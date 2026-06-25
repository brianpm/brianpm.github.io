#!/usr/bin/env python3
"""Download MODIS surface albedo (MCD43C3 v061) and summarise it.

Usage:
    conda activate py
    python scripts/update_albedo_modis.py

Downloads MCD43C3 v061 (CMG 0.05° BRDF/Albedo) HDF4 files from NASA LP DAAC
via earthaccess, sampling one granule per month, and produces, relative to
the repo root:

    data/albedo_modis.csv          monthly land-mean albedo time series
    images/albedo_modis_map.png    time-mean white-sky albedo map
    images/albedo_modis_zonal.png  zonal-mean albedo vs latitude

MCD43C3 is land-only (ocean is fill), so the hemispheric means are land
means. The full record (2000–present) is downloaded; see YEARS.

Credentials: ~/.netrc (earthaccess will prompt on first run).
HDF cache:   scripts/modis_albedo_hdf_cache/  (gitignored)
"""

import re
import warnings
from datetime import datetime, timedelta
from pathlib import Path

import earthaccess
import numpy as np
from pyhdf.SD import SD, SDC
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import cartopy.crs as ccrs
import cartopy.feature as cfeature

REPO_ROOT  = Path(__file__).parent.parent
OUT_CSV    = REPO_ROOT / "data" / "albedo_modis.csv"
MAP_PNG    = REPO_ROOT / "images" / "albedo_modis_map.png"
ZONAL_PNG  = REPO_ROOT / "images" / "albedo_modis_zonal.png"
CACHE_DIR  = Path(__file__).parent / "modis_albedo_hdf_cache"

SHORT_NAME = "MCD43C3"
VERSION    = "061"

# Download full MODIS record (2000–present)
YEARS = range(2000, 2027)

# MODIS CMG 0.05° grid: 3600 rows, row 0 = 89.975°N
LATS = np.linspace(89.975, -89.975, 3600)

SDS = {"wsa": "Albedo_WSA_shortwave", "bsa": "Albedo_BSA_shortwave"}

# All-NaN latitude rows (rows with no land) are expected in the zonal mean.
warnings.filterwarnings("ignore", "Mean of empty slice")

# Accumulator grid is strided down to roughly this many columns for figures.
TARGET_COLS = 720
_acc = {"lat": None, "lon": None}


def parse_date_from_filename(name: str):
    """Return (year, month, doy) from a filename containing AYYYYDDD."""
    m = re.search(r"\.A(\d{4})(\d{3})\.", name)
    if not m:
        return None
    year, doy = int(m.group(1)), int(m.group(2))
    dt = datetime(year, 1, 1) + timedelta(days=doy - 1)
    return year, dt.month, doy


def weighted_mean(data: np.ndarray, lat_mask=None) -> float:
    """Cosine-latitude-weighted mean; lat_mask selects rows (True = include)."""
    weights = np.cos(np.deg2rad(LATS))[:, np.newaxis]
    if lat_mask is not None:
        weights = np.where(lat_mask[:, np.newaxis], weights, 0.0)
    weights = np.where(np.isfinite(data), weights, 0.0)
    total = weights.sum()
    if total == 0:
        return float("nan")
    return float(np.nansum(data * weights) / total)


def hemisphere_means(data: np.ndarray) -> tuple:
    """Return (global, NH, SH) area-weighted means.  NH = lat >= 0, SH = lat < 0."""
    return (
        weighted_mean(data),
        weighted_mean(data, LATS >= 0),
        weighted_mean(data, LATS < 0),
    )


def accumulate_grid(key: str, data: np.ndarray):
    """Add a strided copy of *data* into the running sum/count accumulators."""
    stride = max(1, data.shape[1] // TARGET_COLS)
    sub = data[::stride, ::stride]
    if _acc["lat"] is None:
        _acc["lat"] = LATS[::stride]
        _acc["lon"] = np.linspace(-179.975, 179.975, data.shape[1])[::stride]
    if key + "_sum" not in _acc:
        _acc[key + "_sum"] = np.zeros_like(sub)
        _acc[key + "_cnt"] = np.zeros_like(sub)
    valid = np.isfinite(sub)
    _acc[key + "_sum"][valid] += sub[valid]
    _acc[key + "_cnt"][valid] += 1


def read_sds(hdf: SD, name: str) -> np.ndarray | None:
    """Read one albedo SDS, applying fill mask and scale factor."""
    try:
        sds = hdf.select(name)
        data = sds[:].astype(np.float64)
        attrs = sds.attributes()
    except Exception as e:
        print(f"    WARNING: cannot read SDS {name}: {e}")
        return None
    fill = attrs.get("_FillValue", 32767)
    data = np.where(data == fill, np.nan, data)
    scale = attrs.get("scale_factor", 0.001)
    if scale:
        data = data * scale
    data = np.where((data < 0) | (data > 1), np.nan, data)
    return data


def process_hdf(path: Path) -> dict:
    """Return {'wsa': (g,nh,sh), 'bsa': (g,nh,sh)} for one MCD43C3 file."""
    try:
        hdf = SD(str(path), SDC.READ)
    except Exception as e:
        print(f"  WARNING: cannot open {path.name}: {e}")
        return {}
    out = {}
    try:
        for key, sds_name in SDS.items():
            data = read_sds(hdf, sds_name)
            if data is None:
                continue
            out[key] = hemisphere_means(data)
            accumulate_grid(key, data)
    finally:
        hdf.end()
    return out


def select_monthly_granules(results: list) -> list:
    """Pick the granule nearest mid-month (day 15) for each month."""
    by_month = {}
    for g in results:
        links = g.data_links(access="direct") or g.data_links()
        if not links:
            continue
        fname = links[0].split("/")[-1]
        date = parse_date_from_filename(fname)
        if date is None:
            continue
        year, month, doy = date
        dt = datetime(year, 1, 1) + timedelta(days=doy - 1)
        dist = abs(dt.day - 15)
        if month not in by_month or dist < by_month[month][0]:
            by_month[month] = (dist, g)
    return [by_month[m][1] for m in sorted(by_month)]


def dedupe_monthly_files(files: list[Path]) -> list[Path]:
    """Keep one file per (year, month): the granule nearest mid-month (day 15).

    Two cached granules can map to the same calendar month (e.g. a Dec-15 and a
    Dec-25 acquisition). Without this guard both are processed, producing a
    duplicate year_frac row in the CSV and double-counting that month in the
    map/zonal accumulators.
    """
    best: dict = {}
    for path in files:
        date = parse_date_from_filename(path.name)
        if date is None:
            print(f"  WARNING: cannot parse date from {path.name}, skipping")
            continue
        year, month, doy = date
        dt = datetime(year, 1, 1) + timedelta(days=doy - 1)
        dist = abs(dt.day - 15)
        key = (year, month)
        if key not in best or dist < best[key][0]:
            best[key] = (dist, path)
    return [best[k][1] for k in sorted(best)]


def download_granules() -> list[Path]:
    """Search MCD43C3 for YEARS, pick one granule/month, download with cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    print("Authenticating with NASA Earthdata…")
    earthaccess.login()

    all_paths, monthly_all = [], []
    for year in YEARS:
        print(f"Searching for {SHORT_NAME} v{VERSION} granules in {year}…")
        results = earthaccess.search_data(
            short_name=SHORT_NAME,
            version=VERSION,
            temporal=(f"{year}-01-01", f"{year}-12-31"),
            count=-1,
        )
        print(f"Found {len(results)} granules; selecting one per month…")
        monthly = select_monthly_granules(results)
        print(f"Selected {len(monthly)} monthly granules.")
        monthly_all.extend(monthly)

    need = []
    for g in monthly_all:
        links = g.data_links(access="direct") or g.data_links()
        fname = links[0].split("/")[-1]
        local = CACHE_DIR / fname
        if local.exists():
            all_paths.append(local)
        else:
            need.append(g)

    if need:
        print(f"\nDownloading {len(need)} new granules to {CACHE_DIR}…")
        downloaded = earthaccess.download(need, str(CACHE_DIR))
        all_paths.extend(Path(p) for p in downloaded)
    else:
        print("\nAll granules already cached.")
    return sorted(all_paths)


def render_map():
    if "wsa_sum" not in _acc:
        print("  WARNING: no grid data accumulated; skipping map")
        return
    mean = _acc["wsa_sum"] / np.where(_acc["wsa_cnt"] > 0, _acc["wsa_cnt"], np.nan)
    fig = plt.figure(figsize=(11, 5.2))
    ax = plt.axes(projection=ccrs.PlateCarree())
    mesh = ax.pcolormesh(_acc["lon"], _acc["lat"], mean,
                         transform=ccrs.PlateCarree(),
                         cmap="YlGnBu_r", vmin=0, vmax=0.8, shading="auto")
    ax.add_feature(cfeature.COASTLINE, linewidth=0.4, edgecolor="#444")
    ax.set_global()
    cb = fig.colorbar(mesh, ax=ax, orientation="vertical", shrink=0.8, pad=0.02)
    cb.set_label("White-sky broadband albedo")
    ax.set_title(f"MODIS MCD43C3 mean land surface albedo ({min(YEARS)}-{max(YEARS)})")
    fig.tight_layout()
    MAP_PNG.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(MAP_PNG, dpi=110)
    plt.close(fig)
    print(f"  Wrote {MAP_PNG}")


def render_zonal():
    if "wsa_sum" not in _acc:
        print("  WARNING: no grid data accumulated; skipping zonal plot")
        return
    lat = _acc["lat"]
    fig, ax = plt.subplots(figsize=(5.6, 6.4))
    for key, label, color in (("wsa", "White-sky", "#1a5276"),
                              ("bsa", "Black-sky", "#c0392b")):
        if key + "_sum" not in _acc:
            continue
        mean = _acc[key + "_sum"] / np.where(_acc[key + "_cnt"] > 0,
                                             _acc[key + "_cnt"], np.nan)
        ax.plot(np.nanmean(mean, axis=1), lat, label=label, color=color, linewidth=1.8)
    ax.set_xlabel("Broadband surface albedo")
    ax.set_ylabel("Latitude")
    ax.set_xlim(left=0)
    ax.set_ylim(-90, 90)
    ax.grid(alpha=0.3)
    ax.legend()
    ax.set_title(f"MODIS MCD43C3 zonal-mean land albedo ({min(YEARS)}-{max(YEARS)})")
    fig.tight_layout()
    ZONAL_PNG.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(ZONAL_PNG, dpi=110)
    plt.close(fig)
    print(f"  Wrote {ZONAL_PNG}")


def main():
    files = download_granules()
    files = dedupe_monthly_files(files)
    print(f"\nProcessing {len(files)} HDF4 files…")

    records = []  # (year_frac, wsa_g, wsa_nh, wsa_sh, bsa_g, bsa_nh, bsa_sh)
    for path in files:
        date = parse_date_from_filename(path.name)
        if date is None:
            print(f"  WARNING: cannot parse date from {path.name}, skipping")
            continue
        year, month, _ = date
        means = process_hdf(path)
        if not means:
            continue
        wsa = means.get("wsa", (np.nan, np.nan, np.nan))
        bsa = means.get("bsa", (np.nan, np.nan, np.nan))
        year_frac = year + (month - 0.5) / 12
        records.append((year_frac, *wsa, *bsa))
        print(f"  {year}-{month:02d}: WSA global {wsa[0]:.4f}")

    if not records:
        raise RuntimeError("No records extracted — check HDF files and SDS names.")

    records.sort(key=lambda r: r[0])
    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_CSV, "w") as f:
        f.write("year_frac,wsa_global,wsa_nh,wsa_sh,bsa_global,bsa_nh,bsa_sh\n")
        for r in records:
            f.write(",".join(f"{v:.6f}" for v in r) + "\n")
    print(f"\nWrote {len(records)} monthly records to {OUT_CSV}")

    render_map()
    render_zonal()


if __name__ == "__main__":
    main()
