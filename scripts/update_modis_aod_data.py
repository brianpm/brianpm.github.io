#!/usr/bin/env python3
"""Download monthly global-mean AOD from MODIS/Aqua (MYD08_M3 v6.1).

Usage:
    conda activate p12
    cd bibtoweb
    python update_modis_aod_data.py

Downloads MYD08_M3 v6.1 HDF4 files from NASA LAADS DAAC via earthaccess,
computes area-weighted global/NH/SH mean AOD at 550 nm for each month,
and writes data/aod_modis.csv relative to the repo root.

Credentials: stored in ~/.netrc (earthaccess will prompt on first run).
HDF cache:   bibtoweb/modis_hdf_cache/  (gitignored; ~3.4 GB for full record)
"""

import re
from datetime import datetime, timedelta
from pathlib import Path

import earthaccess
import numpy as np
from pyhdf.SD import SD, SDC

REPO_ROOT  = Path(__file__).parent.parent
OUT_CSV    = REPO_ROOT / "data" / "aod_modis.csv"
CACHE_DIR  = Path(__file__).parent / "modis_hdf_cache"

SHORT_NAME = "MYD08_M3"
START_DATE = "2002-07-01"
END_DATE   = None  # open-ended; earthaccess returns the latest available month

# MODIS CMG 1°×1° grid: row 0 = 89.5°N, row 179 = 89.5°S
LATS = np.linspace(89.5, -89.5, 180)


def parse_date_from_filename(name: str) -> tuple[int, int] | None:
    """Return (year, month) from a filename containing AYYYYDDD."""
    m = re.search(r"\.A(\d{4})(\d{3})\.", name)
    if not m:
        return None
    year = int(m.group(1))
    doy  = int(m.group(2))
    dt   = datetime(year, 1, 1) + timedelta(days=doy - 1)
    return year, dt.month


def weighted_mean(aod: np.ndarray, lat_mask: np.ndarray | None = None) -> float:
    """Cosine-latitude-weighted mean; lat_mask selects rows (True = include)."""
    weights = np.cos(np.deg2rad(LATS))[:, np.newaxis]  # (180, 1)
    data = aod.copy()
    if lat_mask is not None:
        # Zero out weights for excluded rows
        row_mask = lat_mask[:, np.newaxis]
        weights = np.where(row_mask, weights, 0.0)
    weights = np.where(np.isfinite(data), weights, 0.0)
    total_weight = weights.sum()
    if total_weight == 0:
        return float("nan")
    return float(np.nansum(data * weights) / total_weight)


def hemisphere_means(aod: np.ndarray) -> tuple[float, float, float]:
    """Return (global, NH, SH) area-weighted means.  NH = lat >= 0, SH = lat < 0."""
    nh_mask = LATS >= 0   # shape (180,)
    sh_mask = LATS < 0
    return (
        weighted_mean(aod),
        weighted_mean(aod, nh_mask),
        weighted_mean(aod, sh_mask),
    )


def process_hdf(path: Path) -> tuple | None:
    """Return (year_frac, global, nh, sh) from one MYD08_M3 HDF4 file, or None."""
    date = parse_date_from_filename(path.name)
    if date is None:
        print(f"  WARNING: cannot parse date from {path.name}, skipping")
        return None

    year, month = date

    try:
        hdf = SD(str(path), SDC.READ)
    except Exception as e:
        print(f"  WARNING: cannot open {path.name}: {e}")
        return None

    try:
        sds   = hdf.select("Aerosol_Optical_Depth_Land_Ocean_Mean_Mean")
        data  = sds[:].astype(np.float64)  # shape (180, 360)
        attrs = sds.attributes()
    except Exception as e:
        print(f"  WARNING: cannot read AOD SDS from {path.name}: {e}")
        hdf.end()
        return None
    finally:
        hdf.end()

    # Apply fill-value mask
    fill = attrs.get("_FillValue", -28672)
    data = np.where(data == fill, np.nan, data)

    # Apply scale/offset if data appears to be raw integer (typical range > 10)
    if np.nanmax(data) > 10:
        scale  = attrs.get("scale_factor", 0.001)
        offset = attrs.get("add_offset", 0.0)
        data   = (data - offset) * scale

    # Clamp to physically plausible AOD range
    data = np.where((data < 0) | (data > 5), np.nan, data)

    g, nh, sh = hemisphere_means(data)
    year_frac = year + (month - 0.5) / 12
    return year_frac, g, nh, sh


def download_all() -> list[Path]:
    """Search and download all MYD08_M3 v6.1 granules, using cache."""
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    print("Authenticating with NASA Earthdata…")
    earthaccess.login()

    temporal = (START_DATE, END_DATE) if END_DATE else (START_DATE, '2099-12-31')
    print(f"Searching for {SHORT_NAME} granules…")
    results = earthaccess.search_data(
        short_name=SHORT_NAME,
        temporal=temporal,
        count=-1,
    )
    print(f"Found {len(results)} granules.")

    # Skip files already cached
    cached  = {f.name for f in CACHE_DIR.glob("*.hdf")}
    to_download = [
        g for g in results
        if Path(g["meta"]["native-id"]).name not in cached
        # earthaccess granule objects expose file URL; filter by cached names
    ]

    # Simpler: collect all expected filenames from results and check cache
    all_paths = []
    need_download = []
    for g in results:
        links = g.data_links(access="direct") or g.data_links()
        for url in links:
            fname = url.split("/")[-1]
            local = CACHE_DIR / fname
            if local.exists():
                all_paths.append(local)
            else:
                need_download.append(g)
                break

    if need_download:
        print(f"Downloading {len(need_download)} new granules to {CACHE_DIR}…")
        downloaded = earthaccess.download(need_download, str(CACHE_DIR))
        all_paths.extend(Path(p) for p in downloaded)
    else:
        print("All granules already cached.")

    return sorted(all_paths)


def main():
    files = download_all()
    print(f"\nProcessing {len(files)} HDF4 files…")

    records = []
    for i, path in enumerate(files, 1):
        result = process_hdf(path)
        if result:
            records.append(result)
        if i % 24 == 0:
            print(f"  …{i}/{len(files)} files processed")

    if not records:
        raise RuntimeError("No records extracted — check HDF files and variable names.")

    records.sort(key=lambda r: r[0])

    OUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT_CSV, "w") as f:
        f.write("year_frac,aod_global,aod_nh,aod_sh\n")
        for year_frac, g, nh, sh in records:
            f.write(f"{year_frac:.6f},{g:.6f},{nh:.6f},{sh:.6f}\n")

    print(f"\nWrote {len(records)} monthly records to {OUT_CSV}")
    print(f"Date range: {records[0][0]:.2f} – {records[-1][0]:.2f}")
    print(f"Global AOD range: {min(r[1] for r in records):.4f} – {max(r[1] for r in records):.4f}")


if __name__ == "__main__":
    main()
