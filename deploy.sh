#!/usr/bin/env bash
# deploy.sh — copy latest forecast RMSE data to site and push to GitHub Pages
#
# Usage:
#   bash deploy.sh
#
# Copies the most recent rmse_*.json (and matching .csv) from the
# tomorrow_forecast data/web directory into this site's data/ folder,
# then commits and pushes if anything changed.

set -uo pipefail

SITE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORECAST_DATA_DIR="/Users/brianpm/Code/tomorrow_forecast/data/web"

LATEST_JSON=$(ls -t "$FORECAST_DATA_DIR"/rmse_*.json 2>/dev/null | head -1 || true)
if [[ -z "$LATEST_JSON" ]]; then
    echo "No RMSE JSON found in $FORECAST_DATA_DIR" >&2
    exit 1
fi
LATEST_CSV="${LATEST_JSON%.json}.csv"

cp "$LATEST_JSON" "$SITE_DIR/data/weather_rmse.json"
echo "Copied: $LATEST_JSON → data/weather_rmse.json"

if [[ -f "$LATEST_CSV" ]]; then
    cp "$LATEST_CSV" "$SITE_DIR/data/weather_rmse.csv"
    echo "Copied: $LATEST_CSV → data/weather_rmse.csv"
fi

cd "$SITE_DIR"
git add data/weather_rmse.json data/weather_rmse.csv 2>/dev/null || true

if git diff --cached --quiet; then
    echo "No changes to deploy — data already up to date."
else
    git commit -m "Update weather forecast RMSE $(date +%Y-%m-%d)"
    # Integrate any commits pushed from another machine first, otherwise the
    # push is rejected (non-fast-forward) and commits pile up locally unnoticed.
    # This script only touches data/weather_rmse.*, so a rebase is always clean.
    git pull --rebase --autostash origin main
    if git push; then
        echo "Deployed to GitHub Pages."
    else
        echo "ERROR: git push failed — commit is local only." >&2
        exit 1
    fi
fi
