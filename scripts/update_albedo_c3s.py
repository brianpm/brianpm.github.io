#!/usr/bin/env python3
"""Download C3S satellite surface albedo (AVHRR 4km) and summarise it.

Usage:
    conda activate p12
    python scripts/update_albedo_c3s.py

Downloads the Copernicus Climate Data Store "satellite-albedo" product
(broadband white-sky ALBB-BH and black-sky ALBB-DH, AVHRR 4km record) and
produces, relative to the repo root:

    data/albedo_c3s.csv          monthly land-mean albedo time series
    images/albedo_c3s_map.png    time-mean white-sky albedo map
    images/albedo_c3s_zonal.png  zonal-mean albedo vs latitude

The CDS product is land-only (ocean is masked by the algorithm), so the
hemispheric means are land means. Only one overlap year is downloaded for
now (see YEARS); the rest of the record can be filled in later.

Credentials: ~/.cdsapirc (standard cdsapi config).
"""

import calendar
import warnings
import zipfile
from pathlib import Path

import cdsapi
import numpy as np
import xarray as xr
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import cartopy.crs as ccrs
import cartopy.feature as cfeature

REPO_ROOT = Path(__file__).parent.parent
OUT_CSV   = REPO_ROOT / "data" / "albedo_c3s.csv"
MAP_PNG   = REPO_ROOT / "images" / "albedo_c3s_map.png"
ZONAL_PNG = REPO_ROOT / "images" / "albedo_c3s_zonal.png"
TMP_FILE  = REPO_ROOT / "data" / "_albedo_c3s_tmp.zip"

DATASET = "satellite-albedo"

# Only the 2000-2005 overlap year(s) for now; extend this list to fill in the
# rest of the AVHRR 4km record (1981-2005).
YEARS = ["2003"]

# AVHRR 4km record parameters. For 2003-2005 the only satellite is NOAA-17.
SATELLITE        = ["noaa_17"]
SENSOR           = "avhrr"
PRODUCT_VERSION  = ["v2"]
RESOLUTION       = ["4km"]
VARIABLES        = ["albb_bh", "albb_dh"]  # broadband white-sky, black-sky

# Accumulator grid is strided down to roughly this many columns for the
# map/zonal figures (the CSV means are always computed at full resolution).
TARGET_COLS = 720

# Running accumulators for the map/zonal figures (filled on first decad).
_acc = {"lat": None, "lon": None}

# All-NaN latitude rows (rows with no land) are expected in the zonal mean.
warnings.filterwarnings("ignore", "Mean of empty slice")
warnings.filterwarnings("ignore", "All-NaN slice encountered")


def _normname(name: str) -> str:
    return name.upper().replace("-", "_")


def find_albedo_vars(ds: xr.Dataset) -> dict:
    """Return {'bh': name, 'dh': name} for broadband albedo vars present in *ds*."""
    found = {}
    for name, da in ds.data_vars.items():
        dims = set(d.lower() for d in da.dims)
        if not (dims & {"lat", "latitude"} and dims & {"lon", "longitude"}):
            continue
        n = _normname(name)
        if "BH" in n and "bh" not in found:
            found["bh"] = name
        elif "DH" in n and "dh" not in found:
            found["dh"] = name
    return found


def _latlon_coords(da: xr.DataArray):
    lat = "lat" if "lat" in da.coords or "lat" in da.dims else "latitude"
    lon = "lon" if "lon" in da.coords or "lon" in da.dims else "longitude"
    return lat, lon


def hemisphere_means(da: xr.DataArray) -> tuple:
    """Return (global, NH, SH) cosine-latitude weighted means of *da*."""
    for dim in list(da.dims):
        if dim.lower() not in ("lat", "latitude", "lon", "longitude"):
            da = da.isel({dim: 0})
    lat_c, lon_c = _latlon_coords(da)
    weights = np.cos(np.deg2rad(da[lat_c])).clip(min=0)

    def _mean(mask=None):
        sub = da if mask is None else da.where(mask)
        w   = weights.where(mask, other=0) if mask is not None else weights
        return float(sub.weighted(w).mean([lat_c, lon_c], skipna=True).values)

    lat = da[lat_c]
    return _mean(), _mean(lat >= 0), _mean(lat < 0)


def accumulate_grid(key: str, da: xr.DataArray):
    """Add a strided copy of *da* into the running sum/count accumulators."""
    for dim in list(da.dims):
        if dim.lower() not in ("lat", "latitude", "lon", "longitude"):
            da = da.isel({dim: 0})
    lat_c, lon_c = _latlon_coords(da)
    da = da.transpose(lat_c, lon_c)

    stride = max(1, da.sizes[lon_c] // TARGET_COLS)
    sub = da.isel({lat_c: slice(None, None, stride), lon_c: slice(None, None, stride)})
    arr = sub.values.astype("float64")

    if _acc["lat"] is None:
        _acc["lat"] = sub[lat_c].values
        _acc["lon"] = sub[lon_c].values
    if key + "_sum" not in _acc:
        _acc[key + "_sum"] = np.zeros_like(arr)
        _acc[key + "_cnt"] = np.zeros_like(arr)
    valid = np.isfinite(arr)
    _acc[key + "_sum"][valid] += arr[valid]
    _acc[key + "_cnt"][valid] += 1


def process_nc(path: Path) -> dict:
    """Return {'bh': (g,nh,sh), 'dh': (g,nh,sh)} for one decad NetCDF file."""
    ds = xr.open_dataset(path, engine="netcdf4")
    vars_ = find_albedo_vars(ds)
    if not vars_:
        print(f"    WARNING: no albedo variable in {path.name}; "
              f"available: {list(ds.data_vars)}")
        ds.close()
        return {}
    out = {}
    for key, vname in vars_.items():
        da = ds[vname]
        out[key] = hemisphere_means(da)
        accumulate_grid(key, da)
    ds.close()
    return out


def fetch_month(client: cdsapi.Client, year: str, month: int) -> dict:
    """Download one month (all decads) and return monthly mean records by key."""
    last_day = calendar.monthrange(int(year), month)[1]
    nominal_day = ["10", "20", str(last_day)]
    request = {
        "variable": VARIABLES,
        "satellite": SATELLITE,
        "sensor": SENSOR,
        "product_version": PRODUCT_VERSION,
        "horizontal_resolution": RESOLUTION,
        "year": [year],
        "month": [f"{month:02d}"],
        "nominal_day": nominal_day,
    }
    print(f"  {year}-{month:02d} (days {nominal_day})…", end=" ", flush=True)
    client.retrieve(DATASET, request).download(str(TMP_FILE))
    print("downloaded", end=" ", flush=True)

    decads = {"bh": [], "dh": []}
    if zipfile.is_zipfile(TMP_FILE):
        with zipfile.ZipFile(TMP_FILE) as zf:
            members = sorted(n for n in zf.namelist() if n.lower().endswith(".nc"))
            for member in members:
                zf.extract(member, path=TMP_FILE.parent)
                extracted = TMP_FILE.parent / member
                for key, means in process_nc(extracted).items():
                    decads[key].append(means)
                extracted.unlink(missing_ok=True)
    else:
        for key, means in process_nc(TMP_FILE).items():
            decads[key].append(means)
    TMP_FILE.unlink(missing_ok=True)

    monthly = {}
    for key, recs in decads.items():
        if recs:
            monthly[key] = tuple(np.mean([r[i] for r in recs]) for i in range(3))
    print(f"({len(decads['bh'])} bh / {len(decads['dh'])} dh decads)")
    return monthly


def render_map():
    if "bh_sum" not in _acc:
        print("  WARNING: no grid data accumulated; skipping map")
        return
    mean = _acc["bh_sum"] / np.where(_acc["bh_cnt"] > 0, _acc["bh_cnt"], np.nan)
    lat, lon = _acc["lat"], _acc["lon"]

    fig = plt.figure(figsize=(11, 5.2))
    ax = plt.axes(projection=ccrs.PlateCarree())
    mesh = ax.pcolormesh(lon, lat, mean, transform=ccrs.PlateCarree(),
                         cmap="YlGnBu_r", vmin=0, vmax=0.8, shading="auto")
    ax.add_feature(cfeature.COASTLINE, linewidth=0.4, edgecolor="#444")
    ax.set_global()
    cb = fig.colorbar(mesh, ax=ax, orientation="vertical", shrink=0.8, pad=0.02)
    cb.set_label("White-sky broadband albedo")
    ax.set_title(f"C3S/AVHRR mean land surface albedo ({', '.join(YEARS)})")
    fig.tight_layout()
    MAP_PNG.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(MAP_PNG, dpi=110)
    plt.close(fig)
    print(f"  Wrote {MAP_PNG}")


def render_zonal():
    if "bh_sum" not in _acc:
        print("  WARNING: no grid data accumulated; skipping zonal plot")
        return
    lat = _acc["lat"]
    fig, ax = plt.subplots(figsize=(5.6, 6.4))
    for key, label, color in (("bh", "White-sky", "#1a5276"),
                              ("dh", "Black-sky", "#c0392b")):
        if key + "_sum" not in _acc:
            continue
        mean = _acc[key + "_sum"] / np.where(_acc[key + "_cnt"] > 0,
                                             _acc[key + "_cnt"], np.nan)
        zonal = np.nanmean(mean, axis=1)
        ax.plot(zonal, lat, label=label, color=color, linewidth=1.8)
    ax.set_xlabel("Broadband surface albedo")
    ax.set_ylabel("Latitude")
    ax.set_xlim(left=0)
    ax.set_ylim(-90, 90)
    ax.grid(alpha=0.3)
    ax.legend()
    ax.set_title(f"C3S/AVHRR zonal-mean land albedo ({', '.join(YEARS)})")
    fig.tight_layout()
    ZONAL_PNG.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(ZONAL_PNG, dpi=110)
    plt.close(fig)
    print(f"  Wrote {ZONAL_PNG}")


def main():
    print("Downloading C3S surface albedo from CDS (one month at a time)…")
    client  = cdsapi.Client()
    records = []  # (year_frac, bh_g, bh_nh, bh_sh, dh_g, dh_nh, dh_sh)

    for year in YEARS:
        for month in range(1, 13):
            try:
                monthly = fetch_month(client, year, month)
            except Exception as e:
                print(f"  WARNING: failed for {year}-{month:02d}: {e}")
                continue
            if "bh" not in monthly and "dh" not in monthly:
                continue
            bh = monthly.get("bh", (np.nan, np.nan, np.nan))
            dh = monthly.get("dh", (np.nan, np.nan, np.nan))
            year_frac = int(year) + (month - 0.5) / 12
            records.append((year_frac, *bh, *dh))

    if not records:
        raise RuntimeError("No albedo records extracted — check the download.")

    records.sort(key=lambda r: r[0])
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_CSV, "w") as f:
        f.write("year_frac,wsa_global,wsa_nh,wsa_sh,bsa_global,bsa_nh,bsa_sh\n")
        for r in records:
            f.write(",".join(f"{v:.6f}" for v in r) + "\n")
    print(f"Wrote {len(records)} monthly records to {OUT_CSV}")

    render_map()
    render_zonal()


if __name__ == "__main__":
    main()
