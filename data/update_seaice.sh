#!/usr/bin/env bash
# Update the local sea ice extent CSV from NSIDC.
# Run periodically (e.g. weekly) to keep data current.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
curl -fsSL "https://noaadata.apps.nsidc.org/NOAA/G02135/north/daily/data/N_seaice_extent_daily_v4.0.csv" \
    -o "$SCRIPT_DIR/N_seaice_extent_daily_v4.0.csv"
echo "Updated $(wc -l < "$SCRIPT_DIR/N_seaice_extent_daily_v4.0.csv") rows — $(date)"
