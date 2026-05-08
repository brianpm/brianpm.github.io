#!/usr/bin/env python3
"""
update_eei_data.py
------------------
Fetch the CERES EBAF-TOA Edition 4.2.1 global mean TOA net flux time series
directly from the NASA LaRC OPeNDAP server (no login required; CORS: *).

Steps:
  1. Scrape the OPeNDAP directory listing to find the latest cumulative file.
  2. Fetch the 1-D global-mean time series (time, gtoa_net_all_mon) via the
     OPeNDAP ASCII (.ascii) endpoint — a tiny text payload (~15 KB).
  3. Compute a trailing 12-month running mean of the EEI.
  4. Write  data/eei_ceres.csv  relative to the repo root.

Output CSV columns:
  year_frac    – decimal year of the month mid-point
  eei_monthly  – raw global mean TOA net flux (W m⁻²)
  eei_12mo     – trailing 12-month running mean (W m⁻²; blank for first 11 rows)

Run manually:
  conda activate p12
  cd bibtoweb
  python update_eei_data.py

Or triggered automatically by .github/workflows/update_ceres.yml.
"""

import re
import csv
import datetime
import urllib.request
from pathlib import Path

# ── Configuration ──────────────────────────────────────────────────────────────
CATALOG_URL = (
    "https://opendap.larc.nasa.gov/opendap/CERES/EBAF/TOA_Edition4.2.1/contents.html"
)
OPENDAP_BASE = (
    "https://opendap.larc.nasa.gov/opendap/CERES/EBAF/TOA_Edition4.2.1/{filename}.ascii"
)
# OPeNDAP "days since" base date for CERES EBAF time axis
TIME_ORIGIN = datetime.date(2000, 3, 1)

# Path to output CSV (relative to this script's location → go up one level)
SCRIPT_DIR = Path(__file__).parent
OUTPUT_CSV = SCRIPT_DIR.parent / "data" / "eei_ceres.csv"


# ── Step 1: find the latest cumulative file in the OPeNDAP catalog ─────────────
def find_latest_filename() -> str:
    print(f"Fetching catalog: {CATALOG_URL}")
    req = urllib.request.Request(CATALOG_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        html = r.read().decode("utf-8", errors="replace")

    pattern = r"CERES_EBAF-TOA_Edition4\.2\.1_200003-(\d{6})\.nc"
    end_dates = sorted(set(re.findall(pattern, html)))
    if not end_dates:
        raise RuntimeError("No matching CERES EBAF files found in directory listing.")

    latest = end_dates[-1]
    filename = f"CERES_EBAF-TOA_Edition4.2.1_200003-{latest}.nc"
    print(f"Latest file: {filename}")
    return filename


# ── Step 2: fetch time + global mean EEI via OPeNDAP ASCII ─────────────────────
def fetch_opendap(filename: str) -> tuple[list[float], list[float]]:
    """
    Returns (times_days, eei_monthly) where:
      times_days  – days since 2000-03-01
      eei_monthly – global mean TOA net flux in W m⁻²

    The OPeNDAP ASCII response for a Grid variable uses the form:
      varname.mapname, val1, val2, ...
      varname.varname, val1, val2, ...
    """
    url = OPENDAP_BASE.format(filename=filename)
    url += "?time,gtoa_net_all_mon.gtoa_net_all_mon"
    print(f"Fetching: {url}")

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r:
        text = r.read().decode("utf-8", errors="replace")

    # Parse "name, v1, v2, v3, ..." lines (values may wrap across lines)
    data: dict[str, list[float]] = {}
    current_key = None
    current_vals: list[float] = []

    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("Dataset:"):
            if current_key is not None:
                data[current_key] = current_vals
            current_key = None
            current_vals = []
            continue

        # A new variable line starts with a non-numeric identifier
        parts = line.split(", ", 1)
        first = parts[0]
        if len(parts) == 2 and first and not first[0].lstrip("-").isdigit():
            # flush previous
            if current_key is not None:
                data[current_key] = current_vals
            current_key = first
            current_vals = [float(v) for v in parts[1].split(", ") if v.strip()]
        elif current_key is not None:
            # continuation line
            current_vals.extend(float(v) for v in line.split(", ") if v.strip())

    if current_key is not None:
        data[current_key] = current_vals

    if "time" not in data:
        raise RuntimeError("'time' variable not found in OPeNDAP response.")
    if "gtoa_net_all_mon.gtoa_net_all_mon" not in data:
        raise RuntimeError("'gtoa_net_all_mon' not found in OPeNDAP response.")

    return data["time"], data["gtoa_net_all_mon.gtoa_net_all_mon"]


# ── Step 3: derive decimal years and trailing 12-month running mean ─────────────
def days_to_decimal_year(days: float) -> float:
    """Convert 'days since 2000-03-01' to a decimal year at the month mid-point."""
    d = TIME_ORIGIN + datetime.timedelta(days=float(days))
    # Use mid-month convention: year + (month - 0.5) / 12
    return d.year + (d.month - 0.5) / 12.0


def trailing_12mo_mean(values: list[float]) -> list[float | None]:
    """Trailing 12-month running mean. Returns None for the first 11 positions."""
    result: list[float | None] = [None] * len(values)
    for i in range(11, len(values)):
        window = values[i - 11 : i + 1]  # 12 values ending at i
        result[i] = sum(window) / 12.0
    return result


# ── Step 4: write CSV ───────────────────────────────────────────────────────────
def write_csv(
    year_fracs: list[float],
    eei_monthly: list[float],
    eei_12mo: list[float | None],
) -> None:
    OUTPUT_CSV.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_CSV, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["year_frac", "eei_monthly", "eei_12mo"])
        for yf, em, e12 in zip(year_fracs, eei_monthly, eei_12mo):
            writer.writerow([
                f"{yf:.4f}",
                f"{em:.4f}",
                f"{e12:.4f}" if e12 is not None else "",
            ])
    print(f"Wrote {len(year_fracs)} rows → {OUTPUT_CSV}")


# ── Main ────────────────────────────────────────────────────────────────────────
def main() -> None:
    filename = find_latest_filename()
    times_days, eei_monthly = fetch_opendap(filename)

    year_fracs = [days_to_decimal_year(t) for t in times_days]
    eei_12mo   = trailing_12mo_mean(eei_monthly)

    # Sanity check
    n = len(year_fracs)
    assert n == len(eei_monthly) == len(eei_12mo), "Length mismatch after processing."

    annual_means = {}
    for yf, em in zip(year_fracs, eei_monthly):
        yr = int(yf)
        annual_means.setdefault(yr, []).append(em)

    print(f"\n{n} months: {year_fracs[0]:.2f} – {year_fracs[-1]:.2f}")
    print("Recent annual means (W m⁻²):")
    for yr in sorted(annual_means)[-5:]:
        vals = annual_means[yr]
        if len(vals) == 12:
            print(f"  {yr}: {sum(vals)/12:+.3f}  (n=12)")
        else:
            print(f"  {yr}: {sum(vals)/len(vals):+.3f}  (partial, n={len(vals)})")

    last_12mo = next(v for v in reversed(eei_12mo) if v is not None)
    print(f"Latest 12-month trailing mean: {last_12mo:+.3f} W m⁻²")

    write_csv(year_fracs, eei_monthly, eei_12mo)


if __name__ == "__main__":
    main()
