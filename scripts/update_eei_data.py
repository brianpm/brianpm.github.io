#!/usr/bin/env python3
"""
update_eei_data.py
------------------
Fetch the CERES EBAF Edition 4.2.1 global mean TOA net flux time series from
NASA LaRC ASDC (Earthdata Cloud). The old opendap.larc.nasa.gov server was
retired in 2026; the data now requires an Earthdata Login.

Steps:
  1. Query NASA CMR (public) for the latest cumulative EBAF granule.
  2. Download it with earthaccess and read gtoa_net_all_mon + time.
  3. Compute a trailing 12-month running mean of the EEI.
  4. Write  data/eei_ceres.csv  relative to the repo root.

Credentials: ~/.netrc (earthaccess prompts on first run), or in CI the
EARTHDATA_TOKEN env var (a token from urs.earthdata.nasa.gov, from the
GitHub secret EARTHDATA_TOKEN).

Output CSV columns:
  year_frac    – decimal year of the month mid-point
  eei_monthly  – raw global mean TOA net flux (W m⁻²)
  eei_12mo     – trailing 12-month running mean (W m⁻²; blank for first 11 rows)

Run manually:
  conda activate py12
  python scripts/update_eei_data.py

Or triggered automatically by .github/workflows/update_ceres.yml.
"""

import csv
import tempfile
from pathlib import Path

import earthaccess
import xarray as xr

# ── Configuration ──────────────────────────────────────────────────────────────
# TOA+Surface EBAF Ed4.2.1 (LARC_CLOUD). The cumulative file name encodes its
# end month, so the newest granule is the one with the latest start..end range.
COLLECTION = "C3880496704-LARC_CLOUD"

SCRIPT_DIR = Path(__file__).parent
OUTPUT_CSV = SCRIPT_DIR.parent / "data" / "eei_ceres.csv"


# ── Steps 1-2: find, download, and read the latest cumulative file ────────────
def fetch_series() -> tuple[list[float], list[float]]:
    """Returns (year_fracs at month mid-point, global mean TOA net flux W m⁻²)."""
    # "environment" uses EARTHDATA_TOKEN / EARTHDATA_USERNAME+PASSWORD (CI);
    # falls back to ~/.netrc / interactive prompt locally.
    if not earthaccess.login(strategy="environment").authenticated:
        earthaccess.login()

    granules = earthaccess.search_data(
        concept_id=COLLECTION, temporal=("2000-03-01", None), count=50
    )
    if not granules:
        raise RuntimeError("CMR returned no CERES EBAF granules.")
    # cumulative files: pick the one reaching the latest end date
    latest = max(granules, key=lambda g: g["umm"]["TemporalExtent"]
                 ["RangeDateTime"]["EndingDateTime"])
    print(f"Latest granule: {latest['meta']['native-id']}")

    with tempfile.TemporaryDirectory() as tmp:
        (path,) = earthaccess.download([latest], tmp)
        with xr.open_dataset(path) as ds:
            eei = ds["gtoa_net_all_mon"].values.astype(float).tolist()
            t = ds["time"].to_index()
    # Mid-month convention: year + (month - 0.5) / 12
    year_fracs = [d.year + (d.month - 0.5) / 12.0 for d in t]
    return year_fracs, eei


# ── Step 3: trailing 12-month running mean ─────────────
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
    year_fracs, eei_monthly = fetch_series()
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
