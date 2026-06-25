#!/usr/bin/env python3
"""Download monthly global mean AOD from CDS (SLSTR on Sentinel-3A).

Usage:
    conda activate p12
    cd bibtoweb
    python update_aod_data.py

Downloads satellite-aerosol-properties data from the Copernicus Climate Data
Store and computes area-weighted global mean AOD at 550nm for each month,
writing data/aod_sentinel3a.csv relative to the repo root.
"""

import datetime
import re
import zipfile
from pathlib import Path

import cdsapi
import numpy as np
import xarray as xr

REPO_ROOT = Path(__file__).parent.parent
OUT_CSV   = REPO_ROOT / "data" / "aod_sentinel3a.csv"
TMP_FILE  = REPO_ROOT / "data" / "_aod_tmp.zip"

DATASET = "satellite-aerosol-properties"
REQUEST = {
    "time_aggregation": "monthly_average",
    "variable": "aerosol_optical_depth",
    "sensor_on_satellite": ["slstr_on_sentinel_3a"],
    "algorithm": ["ens"],
    # Year range is generated dynamically (2017 → current year) so the script
    # does not go stale; CDS silently ignores months/years with no data yet.
    "year": [str(y) for y in range(2017, datetime.date.today().year + 1)],
    "month": [
        "01", "02", "03",
        "04", "05", "06",
        "07", "08", "09",
        "10", "11", "12"
    ],
    "version": ["v2_4"],
}

# Candidate variable names for AOD at ~550 nm
AOD_VAR_CANDIDATES = [
    "AOD550",
    "aerosol_optical_depth",
    "aerosol_optical_thickness_at_550nm",
    "aod",
    "aod_550",
    "aod550",
]

_reported_varname = False  # print the variable name only once


def find_aod_var(ds: xr.Dataset) -> str:
    """Return the name of the AOD variable in *ds*, or raise if not found."""
    global _reported_varname

    coord_names = set(ds.coords)
    for candidate in AOD_VAR_CANDIDATES:
        if candidate in ds.data_vars:
            if not _reported_varname:
                print(f"  AOD variable found: '{candidate}'")
                _reported_varname = True
            return candidate

    # Fall back: first non-coordinate 2-D variable (lat × lon)
    for name, da in ds.data_vars.items():
        if name in coord_names:
            continue
        dims = set(da.dims)
        if any(d in dims for d in ("lat", "latitude", "lon", "longitude")):
            if not _reported_varname:
                print(f"  AOD variable inferred: '{name}' (from {list(ds.data_vars.keys())})")
                _reported_varname = True
            return name

    raise RuntimeError(
        f"Cannot identify AOD variable. Available: {list(ds.data_vars.keys())}"
    )


def year_month_from_filename(name: str):
    """Extract (year, month) from a filename containing YYYYMM."""
    m = re.search(r"(\d{4})(\d{2})(?:\D|$)", name)
    if m:
        return int(m.group(1)), int(m.group(2))
    return None, None


def year_month_from_dataset(ds: xr.Dataset):
    """Extract (year, month) from a NetCDF time variable (if present)."""
    for tname in ("time", "t"):
        if tname in ds.coords:
            t = ds[tname]
            # Decode to cftime/datetime if needed
            try:
                import pandas as pd
                ts = pd.Timestamp(str(t.values.flat[0]))
                return ts.year, ts.month
            except Exception:
                pass
    return None, None


def hemisphere_means(ds: xr.Dataset, var: str) -> tuple[float, float, float]:
    """Return (global, NH, SH) area-weighted means of *var* in *ds*.

    NH = lat >= 0, SH = lat < 0.
    """
    da = ds[var]

    # Collapse any time/level dimension if present (monthly files may have size-1 time)
    for dim in list(da.dims):
        if dim not in ("lat", "latitude", "lon", "longitude"):
            da = da.isel({dim: 0})

    # Identify lat coordinate name
    lat_coord = None
    for c in ("lat", "latitude"):
        if c in da.coords or c in da.dims:
            lat_coord = c
            break
    if lat_coord is None:
        raise RuntimeError(f"No latitude coordinate found in dims: {da.dims}")

    lon_coord = "lon" if "lon" in da.dims else "longitude"
    spatial_dims = [lat_coord, lon_coord]

    weights = np.cos(np.deg2rad(da[lat_coord])).fillna(0)

    def _mean(mask=None):
        sub = da if mask is None else da.where(mask)
        w   = weights.where(mask, other=0) if mask is not None else weights
        return float(sub.weighted(w).mean(spatial_dims, skipna=True).values)

    lat = da[lat_coord]
    return (
        _mean(),           # global
        _mean(lat >= 0),   # NH
        _mean(lat < 0),    # SH
    )


def process_nc_file(path: Path, filename: str | None = None) -> tuple | None:
    """Open a NetCDF file, return (year_frac, aod_global, aod_nh, aod_sh) or None."""
    name = filename or path.name
    try:
        ds = xr.open_dataset(path, engine="netcdf4")
    except Exception as e:
        print(f"  WARNING: could not open {name}: {e}")
        return None

    var = find_aod_var(ds)
    aod_global, aod_nh, aod_sh = hemisphere_means(ds, var)

    year, month = year_month_from_filename(name)
    if year is None:
        year, month = year_month_from_dataset(ds)
    ds.close()

    if year is None:
        print(f"  WARNING: could not determine date for {name}, skipping")
        return None

    year_frac = year + (month - 0.5) / 12
    return year_frac, aod_global, aod_nh, aod_sh


def fetch_year(client: cdsapi.Client, year: str) -> list[tuple]:
    """Download one year of data, return list of (year_frac, global, nh, sh) tuples."""
    request = {**REQUEST, "year": [year]}
    print(f"  Requesting {year}…", end=" ", flush=True)
    client.retrieve(DATASET, request).download(str(TMP_FILE))
    print("done")

    records = []
    tmp_nc  = TMP_FILE.with_suffix(".nc")

    if zipfile.is_zipfile(TMP_FILE):
        with zipfile.ZipFile(TMP_FILE) as zf:
            nc_members = sorted(n for n in zf.namelist() if n.lower().endswith(".nc"))
            for member in nc_members:
                zf.extract(member, path=tmp_nc.parent)
                extracted = tmp_nc.parent / member
                result = process_nc_file(extracted, filename=member)
                extracted.unlink(missing_ok=True)
                if result:
                    records.append(result)
    else:
        result = process_nc_file(TMP_FILE)
        if result:
            records.append(result)

    TMP_FILE.unlink(missing_ok=True)
    tmp_nc.unlink(missing_ok=True)
    return records


def main():
    print("Downloading AOD data from CDS (one year at a time)…")
    client  = cdsapi.Client()
    records = []

    for year in REQUEST["year"]:
        try:
            records.extend(fetch_year(client, year))
        except Exception as e:
            print(f"  WARNING: failed for {year}: {e}")

    if not records:
        raise RuntimeError("No AOD records extracted — check the download and variable names.")

    records.sort(key=lambda r: r[0])

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_CSV, "w") as f:
        f.write("year_frac,aod_global,aod_nh,aod_sh\n")
        for year_frac, aod_global, aod_nh, aod_sh in records:
            f.write(f"{year_frac:.6f},{aod_global:.6f},{aod_nh:.6f},{aod_sh:.6f}\n")

    print(f"Wrote {len(records)} monthly records to {OUT_CSV}")


if __name__ == "__main__":
    main()
