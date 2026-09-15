#!/usr/bin/env python3
"""
update_ohc_data.py
-------------------
Fetch the NOAA/NCEI Global Ocean Heat Content Climate Data Record (Levitus
et al., accession 0164586) pentadal (rolling 5-year mean) time series for
two depth layers, and write a local CSV for climate_trends.html.

Deliberately does NOT use NOAA's thredds-ocean OPeNDAP service — that
subsystem was found to be down/unstable (503s and hangs on every request,
over both IPv4 and IPv6) while the plain HTTPS data directory for the same
accession responded instantly. This script downloads the two netCDF files
directly over plain HTTPS instead, which is both more robust and matches
every other data section on climate_trends.html (EEI, TSI, AOD, albedo),
all of which read from a local CSV rather than fetching live from the
browser.

Steps:
  1. Download heat_content_anomaly_0-700_pentad.nc and
     heat_content_anomaly_0-2000_pentad.nc.
  2. Extract the global-ocean pentad series (pent_h22_WO) and its standard
     error (pent_h22_se_WO) from each, convert time (months since
     1955-01-01) to decimal year, and convert values from 10^22 J to ZJ.
  3. Write data/ohc.csv (both layers share the same time axis).

Output CSV columns:
  year_frac   – decimal year of the pentad center
  ohc700      – 0-700 m heat content anomaly (ZJ)
  ohc700_se   – standard error (ZJ)
  ohc2000     – 0-2000 m heat content anomaly (ZJ)
  ohc2000_se  – standard error (ZJ)

Run manually:
  conda activate py12
  python scripts/update_ohc_data.py
"""

import csv
import socket
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from pathlib import Path

import xarray as xr

# ── Configuration ──────────────────────────────────────────────────────────────
BASE_URL = "https://www.ncei.noaa.gov/data/oceans/ncei/archive/data/0164586/derived"
LAYERS = [
    {"key": "ohc700", "filename": "heat_content_anomaly_0-700_pentad.nc"},
    {"key": "ohc2000", "filename": "heat_content_anomaly_0-2000_pentad.nc"},
]

# OHC time axis: months since 1955-01-01
TIME_ORIGIN_YEAR = 1955

SCRIPT_DIR = Path(__file__).parent
DOWNLOAD_DIR = SCRIPT_DIR / "_ohc_nc_cache"
OUTPUT_CSV = SCRIPT_DIR.parent / "data" / "ohc.csv"

# ── Network timeouts ──────────────────────────────────────────────────────────
# Same defensive pattern as update_tsi_data.py / update_eei_data.py: a hard
# per-request deadline enforced from a worker thread, plus forcing IPv4
# because NOAA NCEI's advertised IPv6 addresses are unreachable from some
# networks and urllib blocks on each dead IPv6 connect until timeout.
READ_TIMEOUT = 30
REQUEST_DEADLINE = 120
REQUEST_RETRIES = 1

socket.setdefaulttimeout(READ_TIMEOUT)

_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(*args, **kwargs):
    return [r for r in _orig_getaddrinfo(*args, **kwargs) if r[0] == socket.AF_INET]


socket.getaddrinfo = _ipv4_only_getaddrinfo


def download_file(url: str, dest: Path) -> None:
    """Download *url* to *dest*, with a hard per-request deadline and retries."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})

    def _do() -> None:
        with urllib.request.urlopen(req, timeout=READ_TIMEOUT) as r, open(dest, "wb") as f:
            f.write(r.read())

    last_err: Exception = RuntimeError("no attempt made")
    for attempt in range(1, REQUEST_RETRIES + 2):
        ex = ThreadPoolExecutor(max_workers=1)
        future = ex.submit(_do)
        try:
            future.result(timeout=REQUEST_DEADLINE)
            ex.shutdown(wait=False)
            return
        except FutureTimeoutError:
            last_err = TimeoutError(f"request exceeded {REQUEST_DEADLINE}s")
        except (urllib.error.URLError, OSError) as e:
            last_err = e
        ex.shutdown(wait=False)
        if attempt <= REQUEST_RETRIES:
            print(f"    Warning: attempt {attempt} failed ({last_err}); retrying…")
    raise last_err


def load_layer(nc_path: Path) -> dict:
    """Open one pentad netCDF file and return {years, values, errors} in ZJ."""
    ds = xr.open_dataset(nc_path, decode_times=False)
    if "time" not in ds or "pent_h22_WO" not in ds:
        raise RuntimeError(f"Expected variables not found in {nc_path.name}")

    months = ds["time"].values
    years = [TIME_ORIGIN_YEAR + float(m) / 12.0 for m in months]
    # Native units are 10^22 J; 1 ZJ = 10^21 J, so multiply by 10.
    values = [float(v) * 10 for v in ds["pent_h22_WO"].values]
    errors = [float(v) * 10 for v in ds["pent_h22_se_WO"].values]
    ds.close()
    return {"years": years, "values": values, "errors": errors}


def write_csv(layers: dict) -> None:
    keys = [layer["key"] for layer in LAYERS]
    years = layers[keys[0]]["years"]
    for key in keys[1:]:
        if layers[key]["years"] != years:
            raise RuntimeError("Layer time axes do not match; cannot merge into one CSV")

    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["year_frac"] + [f"{k}{suffix}" for k in keys for suffix in ("", "_se")])
        for i, yr in enumerate(years):
            row = [f"{yr:.4f}"]
            for key in keys:
                row.append(f"{layers[key]['values'][i]:.4f}")
                row.append(f"{layers[key]['errors'][i]:.4f}")
            writer.writerow(row)
    print(f"Wrote {len(years)} rows → {OUTPUT_CSV}")


def main() -> None:
    print("=" * 80)
    print("Update Ocean Heat Content (OHC) data from NOAA/NCEI")
    print("=" * 80)

    DOWNLOAD_DIR.mkdir(parents=True, exist_ok=True)
    layers = {}
    for layer in LAYERS:
        url = f"{BASE_URL}/{layer['filename']}"
        nc_path = DOWNLOAD_DIR / layer["filename"]
        print(f"Downloading {layer['key']}: {url}")
        download_file(url, nc_path)
        print(f"  Saved {nc_path} ({nc_path.stat().st_size / 1e6:.1f} MB)")
        layers[layer["key"]] = load_layer(nc_path)
        last = layers[layer["key"]]
        print(f"  Latest pentad ~{last['years'][-1]:.1f}: "
              f"{'+' if last['values'][-1] >= 0 else ''}{last['values'][-1]:.1f} ZJ")

    write_csv(layers)

    print("\n" + "=" * 80)
    print("Done!")
    print("=" * 80)


if __name__ == "__main__":
    main()
