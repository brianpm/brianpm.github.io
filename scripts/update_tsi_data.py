#!/usr/bin/env python3
"""
update_tsi_data.py
------------------
Fetch the NOAA NCEI Total Solar Irradiance (TSI) Climate Data Record (CDR)
(Coddington et al., NNLTSI1 v1, CDR Version 3, DOI 10.25921/k2ff-p712).

Steps:
  1. Fetch the yearly THREDDS catalog to find the latest yearly TSI file.
  2. Fetch yearly TSI via OPeNDAP ASCII and convert to integer years.
  3. Fetch the monthly catalog, list all monthly files (1874 onward).
  4. Fetch each monthly file via OPeNDAP ASCII and accumulate.
  5. Write two CSVs:
     - data/tsi_yearly.csv  – one row per year, 1610–2025
     - data/tsi_monthly.csv – one row per month, 1874-05 onward

Output CSV columns:
  tsi_yearly.csv:
    year      – integer year (1610, 1611, ..., 2025)
    tsi       – yearly mean TSI in W m⁻²
    tsi_unc   – uncertainty in W m⁻²

  tsi_monthly.csv:
    year_frac – decimal year of month mid-point (e.g., 1874.375 for May)
    tsi       – monthly mean TSI in W m⁻²
    tsi_unc   – uncertainty in W m⁻²

Run manually:
  conda activate p12
  cd bibtoweb
  python update_tsi_data.py

Or triggered automatically by .github/workflows/update_tsi.yml.
"""

import re
import csv
import time
import socket
import datetime
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor, TimeoutError as FutureTimeoutError
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────────
YEARLY_CATALOG_URL = (
    "https://www.ncei.noaa.gov/thredds/catalog/cdr-total-solar-irradiance/yearly/catalog.html"
)
MONTHLY_CATALOG_URL = (
    "https://www.ncei.noaa.gov/thredds/catalog/cdr-total-solar-irradiance/monthly/catalog.html"
)
OPENDAP_BASE_YEARLY = (
    "https://www.ncei.noaa.gov/thredds/dodsC/cdr-total-solar-irradiance/yearly/{filename}.ascii"
)
OPENDAP_BASE_MONTHLY = (
    "https://www.ncei.noaa.gov/thredds/dodsC/cdr-total-solar-irradiance/monthly/{filename}.ascii"
)

# TSI time axis: days since 1610-01-01 00:00:00
TIME_ORIGIN = datetime.date(1610, 1, 1)

SCRIPT_DIR = Path(__file__).parent
OUTPUT_YEARLY = SCRIPT_DIR.parent / "data" / "tsi_yearly.csv"
OUTPUT_MONTHLY = SCRIPT_DIR.parent / "data" / "tsi_monthly.csv"

# ── Network timeouts ──────────────────────────────────────────────────────────
# READ_TIMEOUT bounds each socket operation; REQUEST_DEADLINE is a hard
# wall-clock cap on a whole request, enforced in a worker thread so it also
# catches a server that trickles bytes slowly enough to evade the per-read
# timeout (observed once as a multi-hour stall). MONTHLY_BUDGET caps the total
# time spent fetching the ~150 per-year monthly files; files are fetched
# newest-first so a budget cutoff drops only old history, never recent data.
READ_TIMEOUT = 30          # seconds, per socket operation
REQUEST_DEADLINE = 60      # seconds, hard cap per request
REQUEST_RETRIES = 1        # extra attempts after the first
MONTHLY_BUDGET = 600       # seconds, total cap on the monthly-file loop

# Backstop so any worker thread left blocked on a hung socket dies on its own.
socket.setdefaulttimeout(READ_TIMEOUT)

# Force IPv4. NOAA NCEI advertises IPv6 (AAAA) addresses that are unreachable
# from many networks (and from IPv4-only CI runners); urllib tries addresses
# serially and blocks on each dead IPv6 connect until timeout. Across the ~150
# per-year files that compounded into a multi-hour stall. NCEI serves fine over
# IPv4, so filter getaddrinfo to AF_INET.
_orig_getaddrinfo = socket.getaddrinfo


def _ipv4_only_getaddrinfo(*args, **kwargs):
    return [r for r in _orig_getaddrinfo(*args, **kwargs) if r[0] == socket.AF_INET]


socket.getaddrinfo = _ipv4_only_getaddrinfo


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
        ex.shutdown(wait=False)  # don't block on a hung socket
        if attempt <= REQUEST_RETRIES:
            print(f"    Warning: attempt {attempt} failed ({last_err}); retrying…")
    raise last_err


# ── Step 1: Find the latest yearly TSI file in the THREDDS catalog ────────────
def find_latest_yearly_filename() -> str:
    print(f"Fetching yearly catalog: {YEARLY_CATALOG_URL}")
    html = fetch_text(YEARLY_CATALOG_URL)

    # Pattern: tsi_v03r00_yearly_s1610_e2025_c20260305.nc
    pattern = r"tsi_v03r00_yearly_s\d+_e\d+_c\d+\.nc"
    matches = re.findall(pattern, html)
    if not matches:
        raise RuntimeError("No matching TSI yearly files found in directory listing.")

    latest = sorted(matches)[-1]
    print(f"Latest yearly file: {latest}")
    return latest


# ── Step 2: Find all monthly TSI files in the THREDDS catalog ────────────────
def find_monthly_filenames() -> list[str]:
    print(f"Fetching monthly catalog: {MONTHLY_CATALOG_URL}")
    html = fetch_text(MONTHLY_CATALOG_URL)

    # Pattern: tsi_v03r00_monthly_s187405_e187412_c20240831.nc or
    #          tsi_v03r00-preliminary_monthly_s202601_e202603_c20260421.nc
    pattern = r"tsi_v03r00(?:-preliminary)?_monthly_s\d+_e\d+_c\d+\.nc"
    matches = sorted(set(re.findall(pattern, html)))
    if not matches:
        raise RuntimeError("No matching TSI monthly files found in directory listing.")

    # Filter out -preliminary files to keep only finalized data
    finalized = [f for f in matches if "-preliminary" not in f]
    print(f"Found {len(finalized)} finalized monthly files (excluding {len(matches) - len(finalized)} preliminary)")
    return finalized


# ── Step 3: Parse OPeNDAP ASCII response ───────────────────────────────────────
def parse_opendap_ascii(text: str) -> dict[str, list[float]]:
    """
    Parse OPeNDAP ASCII format. Format after the '---...' separator:
      varname[N]
      val1, val2, val3, ...
    """
    sepMatch = re.search(r"\n-{10,}\n", text)
    if not sepMatch:
        raise ValueError("Could not find OPeNDAP data separator")
    data_section = text[sepMatch.end():]

    result = {}
    blocks = re.split(r"\n\s*\n", data_section.strip())
    for block in blocks:
        if not block.strip():
            continue
        lines = block.strip().split("\n")
        header_match = re.match(r"^(\w+)\[\d+\]$", lines[0].strip())
        if not header_match:
            continue
        var_name = header_match.group(1)
        value_str = " ".join(lines[1:])
        values = [
            float(v)
            for v in re.split(r"[\s,]+", value_str.strip())
            if v.strip() and not v.strip().startswith("(") and not v.strip().endswith(")")
        ]
        result[var_name] = values

    return result


# ── Step 4: Convert TSI time (days since 1610-01-01) to year/year_frac ─────────
def days_to_year(days: float) -> int:
    """Convert days since 1610-01-01 to integer year (approximate)."""
    d = TIME_ORIGIN + datetime.timedelta(days=float(days))
    return d.year


def days_to_year_frac(days: float, is_month_midpoint: bool = False) -> float:
    """
    Convert days since 1610-01-01 to decimal year.
    If is_month_midpoint=True, use mid-month convention: year + (month - 0.5) / 12
    Otherwise use the date as-is.
    """
    d = TIME_ORIGIN + datetime.timedelta(days=float(days))
    if is_month_midpoint:
        return d.year + (d.month - 0.5) / 12.0
    else:
        # Fraction within the year
        day_of_year = d.timetuple().tm_yday
        days_in_year = 366 if (d.year % 4 == 0 and (d.year % 100 != 0 or d.year % 400 == 0)) else 365
        return d.year + (day_of_year - 1) / days_in_year


# ── Step 5: Fetch yearly data ──────────────────────────────────────────────────
def fetch_yearly_data(filename: str) -> tuple[list[int], list[float], list[float]]:
    """Fetch yearly TSI, return (years, tsi_values, tsi_unc_values)."""
    url = OPENDAP_BASE_YEARLY.format(filename=filename) + "?time,TSI,TSI_UNC"
    print(f"Fetching yearly OPeNDAP: {url}")

    text = fetch_text(url)
    data = parse_opendap_ascii(text)

    if "time" not in data or "TSI" not in data:
        raise RuntimeError("'time' or 'TSI' variable not found in OPeNDAP response.")

    years = [days_to_year(t) for t in data["time"]]
    tsi_vals = data["TSI"]
    tsi_unc = data.get("TSI_UNC", [None] * len(years))

    # Skip missing values (TSI == -99.0)
    result_years = []
    result_tsi = []
    result_unc = []
    for yr, val, unc in zip(years, tsi_vals, tsi_unc):
        if val != -99.0:
            result_years.append(yr)
            result_tsi.append(val)
            result_unc.append(unc if unc != -99.0 else None)

    return result_years, result_tsi, result_unc


# ── Step 6: Fetch monthly data ─────────────────────────────────────────────────
def fetch_monthly_data(filenames: list[str]) -> tuple[list[float], list[float], list[float]]:
    """Fetch and aggregate all monthly TSI files, return (year_fracs, tsi_values, tsi_unc_values)."""
    year_fracs = []
    tsi_vals = []
    tsi_uncs = []

    # Fetch newest-first so that if the total budget is exhausted we drop only
    # old history (already in the CSV), never the recent months we care about.
    ordered = sorted(filenames, reverse=True)
    start = time.monotonic()

    for i, filename in enumerate(ordered):
        if time.monotonic() - start > MONTHLY_BUDGET:
            print(f"  Reached {MONTHLY_BUDGET}s budget after {i} files — "
                  f"stopping (remaining {len(ordered) - i} older files skipped).")
            break

        url = OPENDAP_BASE_MONTHLY.format(filename=filename) + "?time,TSI,TSI_UNC"
        print(f"  [{i+1}/{len(ordered)}] Fetching {filename}...")

        try:
            text = fetch_text(url)
        except (urllib.error.URLError, OSError, TimeoutError) as e:
            print(f"    Warning: fetch failed ({e}) — skipping")
            continue

        try:
            data = parse_opendap_ascii(text)
        except ValueError as e:
            print(f"    Warning: {e} — skipping")
            continue

        if "time" not in data or "TSI" not in data:
            print(f"    Warning: Missing variables — skipping")
            continue

        times = data["time"]
        tsiv = data["TSI"]
        tsi_u = data.get("TSI_UNC", [None] * len(times))

        for t, v, u in zip(times, tsiv, tsi_u):
            if v != -99.0:
                # Use mid-month convention for decimal year
                yf = days_to_year_frac(t, is_month_midpoint=True)
                year_fracs.append(yf)
                tsi_vals.append(v)
                tsi_uncs.append(u if (u and u != -99.0) else None)

    # Sort by year_frac
    combined = sorted(zip(year_fracs, tsi_vals, tsi_uncs))
    year_fracs, tsi_vals, tsi_uncs = zip(*combined) if combined else ([], [], [])
    return list(year_fracs), list(tsi_vals), list(tsi_uncs)


# ── Step 7: Write CSVs ─────────────────────────────────────────────────────────
def write_yearly_csv(years: list[int], tsi: list[float], tsi_unc: list[float]) -> None:
    OUTPUT_YEARLY.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_YEARLY, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["year", "tsi", "tsi_unc"])
        for yr, v, u in zip(years, tsi, tsi_unc):
            writer.writerow([
                yr,
                f"{v:.4f}",
                f"{u:.4f}" if u is not None else "",
            ])
    print(f"Wrote {len(years)} yearly rows → {OUTPUT_YEARLY}")


def write_monthly_csv(year_fracs: list[float], tsi: list[float], tsi_unc: list[float]) -> None:
    OUTPUT_MONTHLY.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_MONTHLY, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["year_frac", "tsi", "tsi_unc"])
        for yf, v, u in zip(year_fracs, tsi, tsi_unc):
            writer.writerow([
                f"{yf:.4f}",
                f"{v:.4f}",
                f"{u:.4f}" if u is not None else "",
            ])
    print(f"Wrote {len(year_fracs)} monthly rows → {OUTPUT_MONTHLY}")


# ── Main ────────────────────────────────────────────────────────────────────────
def main() -> None:
    print("=" * 80)
    print("Update Total Solar Irradiance (TSI) data from NOAA NCEI CDR")
    print("=" * 80)

    # Fetch yearly
    yearly_file = find_latest_yearly_filename()
    years, tsi_yearly, unc_yearly = fetch_yearly_data(yearly_file)
    write_yearly_csv(years, tsi_yearly, unc_yearly)

    # Summary
    print(f"\nYearly data: {years[0]}–{years[-1]} ({len(years)} years)")
    print(f"Latest yearly TSI (year {years[-1]}): {tsi_yearly[-1]:.2f} W m⁻²")

    # Fetch monthly
    print("\nFetching monthly files...")
    monthly_files = find_monthly_filenames()
    year_fracs, tsi_monthly, unc_monthly = fetch_monthly_data(monthly_files)
    write_monthly_csv(year_fracs, tsi_monthly, unc_monthly)

    print(f"\nMonthly data: {year_fracs[0]:.2f}–{year_fracs[-1]:.2f} ({len(year_fracs)} months)")
    print(f"Latest monthly TSI (year {year_fracs[-1]:.2f}): {tsi_monthly[-1]:.2f} W m⁻²")

    print("\n" + "=" * 80)
    print("Done!")
    print("=" * 80)


if __name__ == "__main__":
    main()
