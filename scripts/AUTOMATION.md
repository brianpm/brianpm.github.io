# Climate-data update automation

Status and automation plan for the data feeds behind `climate_trends.html` (and the
sea-ice / GMST viz pages). Compiled 2026-06-25 from a full audit + live re-runs of each
script.

## TL;DR status

| Feed | Script | Last data | Automated? | Health |
|---|---|---|---|---|
| CERES EEI | `update_eei_data.py` | ~Mar 2026 | ✅ GH Action, monthly (15th) | Healthy |
| NH sea ice | inline (workflow) | ~21 Jun 2026 | ✅ GH Action, weekly (Mon) | Healthy |
| TSI | `update_tsi_data.py` | Dec 2025 → see note | ✅ GH Action, quarterly | **Untested** — never run on schedule yet |
| AOD MODIS | `update_modis_aod_data.py` | Apr 2026 | ❌ manual | Current (source latency) |
| AOD Sentinel-3A | `update_aod_data.py` | Jun 2025 | ❌ manual | **Source is lagging** — CDS has no data past mid-2025 |
| Albedo MODIS | `update_albedo_modis.py` | **mid-Jun 2026** (refreshed) | ❌ manual | Current |
| Albedo C3S | `update_albedo_c3s.py` | **Sep 2008** | ❌ manual | Far behind — backfill is ~1.5 TB / ~150 h |

## Environment note

This machine's conda env is **`py`** (not `py12`/`p12` as CLAUDE.md documents). `conda env list`
shows only `base` and `py`. All scripts run with `conda run -n py python scripts/<name>.py`.
CLAUDE.md's per-machine env table should be updated to include this host.

GitHub Actions do **not** use conda — they use `actions/setup-python` (3.11) + `pip install`.

---

## Per-feed automation findings

### TSI — `update_tsi_data.py` (NOAA NCEI THREDDS/OPeNDAP)
- **The "missed April run" was a non-event:** the `update_tsi.yml` workflow was created
  2026-05-09, ~5 weeks *after* the 5 Apr quarterly cron. It has therefore had **zero scheduled
  runs**; the next is **2026-07-05**. The Dec-2025 ceiling is just whatever NCEI had published
  when the CSV was first generated — not a broken pipeline.
- **Action:** trigger it once manually (`workflow_dispatch`, or run the script locally) to verify
  the source works and pull anything since Dec 2025, rather than waiting for the July cron.
- **Automation:** already correct (quarterly GH Action). Small HTTP-only download; no secrets.

### AOD Sentinel-3A — `update_aod_data.py` (Copernicus CDS)
- **Stale because the upstream product is behind**, not because of a missed run. CDS
  `satellite-aerosol-properties` (SLSTR/Sentinel-3A v2_4 ENS) has no data past mid-2025;
  requesting 2026 returns `400 / "no valid combination of values"`. Re-running produces a
  byte-identical CSV.
- **Latent bug fixed:** the request year list was hardcoded to end at `2025`, so it would never
  pick up new data even once CDS publishes it. Now dynamic: `range(2017, today.year+1)`, with the
  not-yet-published year failing gracefully. (Edit left uncommitted in the working tree.)
- **Automation: GOOD GitHub Action candidate.** ~50 MB total download, mirrors `update_ceres.yml`.
  Needs `CDSAPI_URL` + `CDSAPI_KEY` secrets written to `~/.cdsapirc`; dataset licence already
  accepted at account level. Recommend **monthly** cron; give the job `timeout-minutes: 60–90`
  because CDS queue latency is unpredictable.

### Albedo MODIS — `update_albedo_modis.py` (NASA Earthdata MCD43C3)
- **Refreshed to mid-Jun 2026** (was Dec 2025). ~9-day MCD43C3 production latency, so this is as
  current as the product allows.
- **Cache reuse is essential:** `scripts/modis_albedo_hdf_cache/` is **60 GB** (one ~200 MB HDF4
  granule/month, 2000→present). Incremental runs download only new months (~1.3 GB this run) but
  reprocess the full record (~6 min, CPU-bound).
- **Fix:** `range(2000, 2026)` → `range(2000, 2027)` (exclusive upper bound was excluding all 2026
  data). Plus a pre-existing uncommitted single-year→multi-year rewrite. (Uncommitted.)
- **Known data quirk:** CSV has duplicate `year_frac` rows (two December granules map to month 12,
  e.g. 2025.958333, 2001.041667). Harmless to currency; fix = de-dup by `year_frac` before write.
- **Automation: local cron only — NOT GitHub Actions.** Runners have ~14 GB disk vs. a 60 GB cache,
  and the script reprocesses the whole record each run. Porting to CI would require a real refactor
  to an incremental/append design. Recommend **monthly local cron/launchd** on this host:
  `0 6 5 * * cd <repo> && conda run -n py python scripts/update_albedo_modis.py` then commit the CSV
  + `images/albedo_modis_*.png`.

### Albedo C3S — `update_albedo_c3s.py` (Copernicus CDS, multi-sensor 1981→present)
- **Root cause of the Aug-2008 stop: an interrupted incremental run**, not a bug or licence issue.
  The script has resume logic (skips months already in the CSV, writes after each month). A run of
  the rewritten multi-era version (uncommitted diff: `["2003"]` → `range(1981,2026)` + 9-sensor
  schedule) got to Aug 2008 and was killed mid-download of Sep 2008.
- **Cleanup done:** deleted the corrupt 2.44 GB `data/_albedo_c3s_tmp.zip` leftover (truncated
  partial download; script recreates its own temp file per month).
- **The backfill is expensive:** 2008-onward is the SPOT/VGT (1 km) and Sentinel-3 (300 m) eras.
  Measured **~7 GB and ~48 min per month**. Remaining Oct 2008 → Jun 2026 ≈ 213 months ≈
  **~1.5 TB and ~150+ hours** of wall time. Peak disk stays ~7 GB (temp deleted per month), so
  storage is fine — **time/bandwidth is the cost.** Pipeline verified working (advanced one month).
- **Automation: local only — NOT GitHub Actions** (single-month downloads ~7 GB vs ~14 GB runner
  disk; 6-h job limit vs 150-h backfill). After backfill, steady-state is 1–2 new months/month.
  Recommend a **monthly local cron/launchd** job; resume logic makes interruptions safe.
- **DECISION (2026-06-25): backfill DEFERRED.** We intend to complete the 2008→2026 backfill, but
  it needs to run on a **server that can download uninterrupted for days** (~1.5 TB / ~150 h) —
  not this workstation. TODO when that host is available:
  1. `git pull`, then `conda run -n <env> python scripts/update_albedo_c3s.py` under
     `nohup`/`tmux`/cron so it survives disconnects. The script's resume logic restarts from the
     last month in `data/albedo_c3s.csv` (currently Sep 2008), so it can be stopped/restarted freely.
  2. When current, commit `data/albedo_c3s.csv` + `images/albedo_c3s_*.png`, then add a monthly
     local cron/launchd job on that server (mirror `cron_update_albedo_modis.sh`).
  C3S's unique value is the **1981–2000** history MODIS lacks; the 2008→2026 overlap is already
  covered on the page by the (now-current) MODIS albedo series, so there's no urgency.

---

## Automation roadmap — status

1. **TSI** — schedule already correct (quarterly). Validated by a manual local run on 2026-06-25.
   ✅ DONE. First scheduled cron is 2026-07-05.
2. **AOD Sentinel-3A** — ✅ DONE: added `.github/workflows/update_aod_sentinel.yml` (monthly, 16th).
   **ACTION REQUIRED BY MAINTAINER:** add repo secrets `CDSAPI_URL` and `CDSAPI_KEY`
   (Settings → Secrets and variables → Actions) or the workflow's CDS step will fail. Will
   auto-resume pulling data once Copernicus publishes past mid-2025.
3. **Albedo MODIS** — ✅ DONE: monthly local **launchd** job `org.skymath.albedo-modis` (6th of each
   month) via `scripts/cron_update_albedo_modis.sh`; plist in `scripts/launchd/`. Runs against the
   local 60 GB cache, commits + pushes CSV + figures. Logs in `scripts/logs/` (gitignored).
   Reinstall: `cp scripts/launchd/org.skymath.albedo-modis.plist ~/Library/LaunchAgents/ && launchctl load …`.
4. **Albedo C3S** — backfill deferred to a server (see C3S section above); no job yet.
5. **MODIS albedo `year_frac` de-dup** — ✅ FIXED in `update_albedo_modis.py`
   (`dedupe_monthly_files`, keeps the granule nearest day 15; also stops double-counting in figures).
6. **CLAUDE.md conda-env table** — still TODO: add this host (env `py`).
