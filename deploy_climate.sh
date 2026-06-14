#!/usr/bin/env bash
# deploy_climate.sh — regenerate northeast Boulder climate data and deploy to GitHub Pages
# Usage: bash deploy_climate.sh
set -uo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GGWEATHER_DIR="/Users/brianpm/Code/ggweather"
OUTPUT_JSON="$SITE_DIR/data/northeast_boulder_climate.json"
PY="/opt/homebrew/Caskroom/mambaforge/base/envs/py12/bin/python3"

echo "=== Northeast Boulder Climate Deploy ==="
echo ""

CURRENT_YEAR=$(date +%Y)
echo "Step 0: Refresh current-year ($CURRENT_YEAR) WeeWX archive from live database..."
"$PY" "$GGWEATHER_DIR/scripts/archive_year.py" --year "$CURRENT_YEAR" --summary-only
echo ""

echo "Step 1: Rebuild unified daily parquet from all data sources..."
"$PY" "$GGWEATHER_DIR/scripts/build_unified_daily.py"
echo ""

echo "Step 2: Generate web JSON..."
"$PY" "$GGWEATHER_DIR/scripts/generate_web_data.py" --output "$OUTPUT_JSON"
echo ""

echo "Step 3: Commit and push if data changed..."
cd "$SITE_DIR"
git add data/northeast_boulder_climate.json

if git diff --cached --quiet; then
    echo "No changes — data is already up to date."
else
    git commit -m "Update northeast Boulder climate data $(date +%Y-%m-%d)"
    git push
    echo "Deployed successfully."
fi

echo ""
echo "Done."
