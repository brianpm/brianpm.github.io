#!/bin/zsh
# Monthly local cron/launchd wrapper for the MODIS albedo update.
#
# Runs scripts/update_albedo_modis.py against the local 60 GB MCD43C3 HDF cache
# (scripts/modis_albedo_hdf_cache/, gitignored), then commits & pushes the
# refreshed CSV + figures if they changed. This update is NOT a GitHub Action
# because the cache exceeds a runner's disk; it must run on the machine that
# holds the cache. See scripts/AUTOMATION.md.
#
# Install (once):
#   cp scripts/launchd/org.skymath.albedo-modis.plist ~/Library/LaunchAgents/
#   launchctl load ~/Library/LaunchAgents/org.skymath.albedo-modis.plist
set -euo pipefail

REPO="/Users/brianpm/Code/brianpm.github.io"
CONDA="/Users/brianpm/miniforge3/bin/conda"
LOG_DIR="$REPO/scripts/logs"
LOG="$LOG_DIR/albedo_modis_cron.log"

mkdir -p "$LOG_DIR"
cd "$REPO"

echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) MODIS albedo update starting ===" >> "$LOG"
"$CONDA" run -n py python scripts/update_albedo_modis.py >> "$LOG" 2>&1

git add data/albedo_modis.csv images/albedo_modis_map.png images/albedo_modis_zonal.png
if git diff --staged --quiet; then
  echo "No changes — nothing to commit." >> "$LOG"
else
  git commit -m "chore: update MODIS albedo data [$(date -u +%Y-%m-%d)]" >> "$LOG" 2>&1
  git push >> "$LOG" 2>&1
  echo "Committed and pushed." >> "$LOG"
fi
echo "=== $(date -u +%Y-%m-%dT%H:%M:%SZ) done ===" >> "$LOG"
