#!/usr/bin/env python3
"""
update_piomas_data.py
-----------------------
Fetch the PIOMAS (Pan-Arctic Ice-Ocean Modeling and Assimilation System;
UW Polar Science Center; Zhang & Rothrock 2003; Schweiger et al. 2011)
monthly Arctic sea ice volume time series and write a local CSV for
seaice.html.

NOTE: PIOMAS's atmospheric forcing input (NCEP/NCAR R1 reanalysis) was
discontinued by NOAA/NWS on 2026-03-18, and PSC has no announced timeline
to resume updates as of this writing — the source file currently ends at
February 2026. This script still fetches on schedule so the series
resumes automatically whenever PSC starts publishing again; the commit
step in the GitHub Actions workflow no-ops when the file is unchanged.
There is no equivalent product for the Southern Hemisphere/Antarctic —
Antarctic snow-on-ice makes satellite thickness retrieval far less
certain, and no agency publishes a routine volume time series for it.

Source:  https://psc.apl.uw.edu/research/projects/arctic-sea-ice-volume-anomaly/data/
Format:  one row per year, 12 whitespace-separated monthly values
         (Jan..Dec), volume in 10^3 km^3, missing months coded -1.000.

Output CSV columns:
  year_frac  – decimal year of the month midpoint
  volume     – Arctic sea ice volume (10^3 km^3)

Run manually:
  conda activate py12
  python scripts/update_piomas_data.py
"""

import csv
import socket
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from pathlib import Path

SOURCE_URL = (
    "https://psc.apl.uw.edu/wordpress/wp-content/uploads/schweiger/"
    "ice_volume/PIOMAS.2sst.monthly.Current.v2.1.txt"
)
MISSING = -1.0

SCRIPT_DIR = Path(__file__).parent
OUTPUT_CSV = SCRIPT_DIR.parent / "data" / "piomas_volume.csv"

# ── Network timeouts ──────────────────────────────────────────────────────────
READ_TIMEOUT = 30
REQUEST_DEADLINE = 60
REQUEST_RETRIES = 1

socket.setdefaulttimeout(READ_TIMEOUT)


def fetch_text(url: str) -> str:
    """GET *url* and return decoded text, with a hard per-request deadline.

    Runs the blocking urlopen in a worker thread and abandons it if it exceeds
    REQUEST_DEADLINE, so a slow/stalled server can never hang the run. Retries
    transient failures REQUEST_RETRIES times; raises the last error if all fail.
    """
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})

    def _do() -> str:
        with urllib.request.urlopen(req, timeout=READ_TIMEOUT) as r:
            return r.read().decode("utf-8", errors="replace")

    last_err: Exception = RuntimeError("no attempt made")
    for attempt in range(1, REQUEST_RETRIES + 2):
        ex = ThreadPoolExecutor(max_workers=1)
        future = ex.submit(_do)
        try:
            result = future.result(timeout=REQUEST_DEADLINE)
            ex.shutdown(wait=False)
            return result
        except FutureTimeoutError:
            last_err = TimeoutError(f"request exceeded {REQUEST_DEADLINE}s")
        except (urllib.error.URLError, OSError) as e:
            last_err = e
        ex.shutdown(wait=False)
        if attempt <= REQUEST_RETRIES:
            print(f"    Warning: attempt {attempt} failed ({last_err}); retrying…")
    raise last_err


def parse_piomas(text: str) -> tuple[list[float], list[float]]:
    """Reshape 'year jan feb ... dec' rows into a (year_frac, volume) series."""
    year_fracs: list[float] = []
    volumes: list[float] = []
    for line in text.strip().splitlines():
        parts = line.split()
        if not parts:
            continue
        year = int(float(parts[0]))
        for i, val_str in enumerate(parts[1:13]):
            val = float(val_str)
            if val == MISSING:
                continue
            year_fracs.append(year + (i + 0.5) / 12.0)
            volumes.append(val)
    return year_fracs, volumes


def write_csv(year_fracs: list[float], volumes: list[float]) -> None:
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["year_frac", "volume"])
        for yf, v in zip(year_fracs, volumes):
            writer.writerow([f"{yf:.4f}", f"{v:.3f}"])
    print(f"Wrote {len(year_fracs)} rows → {OUTPUT_CSV}")


def main() -> None:
    print("=" * 80)
    print("Update PIOMAS Arctic sea ice volume data")
    print("=" * 80)
    print(f"Fetching {SOURCE_URL}")
    text = fetch_text(SOURCE_URL)

    year_fracs, volumes = parse_piomas(text)
    if not year_fracs:
        raise RuntimeError("No valid data rows parsed from PIOMAS file")

    write_csv(year_fracs, volumes)
    print(f"Latest month {year_fracs[-1]:.2f}: {volumes[-1]:.2f} x10³ km³")
    print("\n" + "=" * 80)
    print("Done!")
    print("=" * 80)


if __name__ == "__main__":
    main()
