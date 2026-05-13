"""Refresh GMST CSVs from the Met Office Climate Dashboard.

Run this monthly (or whenever new data is released) to update the local
copies of the five global mean surface temperature datasets used by gmst.html.

Usage:
    conda activate py12
    python bibtoweb/update_gmst_data.py
"""

import requests
import pathlib

SOURCES = {
    "gmt_HadCRUT5.csv":      "https://climate.metoffice.cloud/formatted_data/gmt_HadCRUT5.csv",
    "gmt_GISTEMP.csv":        "https://climate.metoffice.cloud/formatted_data/gmt_GISTEMP.csv",
    "gmt_BerkeleyEarth.csv":  "https://climate.metoffice.cloud/formatted_data/gmt_Berkeley%20Earth.csv",
    "gmt_NOAAGlobalTemp.csv": "https://climate.metoffice.cloud/formatted_data/gmt_NOAAGlobalTemp.csv",
    "gmt_ERA5.csv":           "https://climate.metoffice.cloud/formatted_data/gmt_ERA5.csv",
}

out_dir = pathlib.Path(__file__).parent.parent / "data"
out_dir.mkdir(exist_ok=True)

for filename, url in SOURCES.items():
    print(f"Fetching {filename}...")
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    (out_dir / filename).write_text(r.text, encoding="utf-8")
    lines = r.text.strip().count("\n")
    print(f"  Saved {filename} ({lines} data rows)")

print("\nDone. Commit data/gmt_*.csv to deploy updated data.")
