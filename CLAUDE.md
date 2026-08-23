# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Overview

This is a static GitHub Pages website (brianpm.github.io) for Brian Medeiros' climate science research (SkyMath.org). The site is hosted directly from this repository without a build process.

## Architecture

**Static HTML with jQuery-based Components**
- Each page is a standalone HTML file that includes Bootstrap CSS and custom styles
- Common elements (navigation and footer) are stored in separate HTML files and dynamically loaded via jQuery:
  - `navigation.html` - Site header and navigation menu
  - `footer.html` - Site footer
- Pages load these components using jQuery's `$.get()` on page load
- Example pattern from any page:
  ```html
  <div id="nav-placeholder">
      <script>
          $.get("navigation.html", function(data){
              $("#nav-placeholder").replaceWith(data);
          });
      </script>
  </div>
  ```

**Styling**
- Bootstrap 3.x for grid layout and responsive design
- Custom CSS in `css/style.css` for site-specific theming
- Font Awesome 6.7.2 via CDN with the v4-shims compatibility shim on all pages:
  ```html
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/v4-shims.min.css">
  ```
  The v4-shims allow using the older `fa fa-*` class syntax (e.g. `fa fa-cloud`) which the site uses extensively. Always include both lines.
- jQuery 3.7.1 loaded from CDN on all pages: `<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>`
- All pages use the card-based layout with `about-section` container, flex card grids, hover effects, and `#55bfea` accent color. Use `contact.html` as the style reference.
- **Dark mode is implemented site-wide** via CSS custom properties in `css/style.css` and a toggle in `navigation.html`. All pages include `<script src="js/theme.js"></script>` in `<head>` for FOUC prevention and chart theming. Never use hardcoded hex colors — always use CSS variables (e.g. `var(--color-text-dark)`). See `STYLE_GUIDE.md` for the full token reference, dark-mode wiring rules, and Chart.js/Plotly.js patterns.

## Conda Environment

The Python environment for scripts is named differently per machine:
- **lothal** (desktop Mac): `py12`
- **laptop**: likely `p12`
- some hosts use a plain `py` env (e.g. the machine where `conda env list` shows only `base` and `py`)

Check with `conda env list` if unsure. All workflow commands below use `py12`; substitute the local env name (`p12`, `py`, …) as needed. A reliable non-interactive form is `conda run -n <env> python scripts/<name>.py`.

## Key Workflows

### Updating Publications

Publications are automatically extracted from the master bibliography and converted to HTML using the `bibtoweb/` tools.

**Quick Update (Recommended):**
```bash
conda activate py12
cd bibtoweb
python update_publications.py
```

This automated script (`update_publications.py`):
1. Extracts all publications with B. Medeiros as author from `/Users/brianpm/Dropbox/refs.bib`
2. Saves to dated archive `mybib_YYYY_MM_DD.bib`
3. Converts BibTeX to HTML format
4. Creates timestamped backup of existing `publications.html` in `bibtoweb/archive/`
5. Deploys new `publications.html` to site root

**Manual Step-by-Step (if needed):**
```bash
conda activate py12
cd bibtoweb

# Step 1: Extract publications from master bibliography
python extract_my_pubs.py

# Step 2: Convert to HTML
python bib_converter.py mybib_YYYY_MM_DD.bib publications_new.html

# Step 3: Deploy (manual backup recommended)
mv publications_new.html ../publications.html
```

**Author Name Matching:**
The extraction script matches all variations:
- `Medeiros, Brian` (most common)
- `Brian Medeiros`
- `Medeiros, B.`
- `B. Medeiros`

**Dependencies:**
- Python 3 (use `py12` conda environment on lothal; `p12` on laptop)
- `pylatexenc==2.10` - for LaTeX character conversion
- `bibtexparser==2.0.0b9` (v2 beta) - for parsing BibTeX files

**Tools:**
- `extract_my_pubs.py` - Filters master bibliography for publications with B. Medeiros as author
- `bib_converter.py` - Converts BibTeX entries to HTML with formatted authors, titles, journals, and DOI links
- `update_publications.py` - Complete workflow automation with backups

### Adding a New Presentation Page

Presentations are listed on `ourwork.html` and live in the `presentations/` subdirectory. The page auto-discovers them via `presentations/index.json` — you do **not** need to edit `ourwork.html`.

**Steps to add a new presentation:**
1. Create `presentations/{slug}.html` — copy an existing file as a template (e.g. `presentations/lanl_cosim_2024.html`)
2. Add an entry to `presentations/index.json`:
   ```json
   {
     "slug": "my_talk_2025",
     "title": "Presentation Title",
     "venue": "Conference or Seminar Name",
     "date": "2025",
     "type": "Seminar",
     "description": "One-sentence summary shown on the ourwork.html card."
   }
   ```
3. If distributing QR codes pointing to the root URL, create a redirect stub at `/{slug}.html`:
   ```html
   <!DOCTYPE html><html><head>
   <meta http-equiv="refresh" content="0; url=presentations/{slug}.html">
   </head><body><a href="presentations/{slug}.html">Redirect</a></body></html>
   ```

**Presentation page paths** (from `presentations/` subdirectory):
- Navigation/footer: `../navigation.html`, `../footer.html`
- CSS/JS: `../css/bootstrap.css`, `../css/style.css`; jQuery from CDN (not local)
- PDFs/files: `../provide-files/filename.pdf`
- Favicons: `../favicon.ico`, etc.

### Data Visualization Pages

The site hosts several interactive browser pages that fetch data directly from external APIs/servers at runtime (no local data files except where noted).

| Page | Data source | Chart library | Notes |
|---|---|---|---|
| `co2_noaa.html` | NOAA GML AFTP servers (direct `.txt` files per station) | Chart.js | Multi-site selector |
| `nh_seaice.html` | Local CSV `data/N_seaice_extent_daily_v4.0.csv` | Chart.js + date-fns | Single dataset |
| `gmst.html` | Met Office Climate Dashboard formatted CSVs | Chart.js | 5 datasets, toggle per dataset, uncertainty bands |

**gmst.html data sources** — all fetched from `https://climate.metoffice.cloud/formatted_data/gmt_{name}.csv`:
- `gmt_HadCRUT5.csv` (Met Office / CRU)
- `gmt_GISTEMP.csv` (NASA GISS)
- `gmt_Berkeley%20Earth.csv` (Berkeley Earth)
- `gmt_NOAAGlobalTemp.csv` (NOAA NCEI)
- `gmt_ERA5.csv` (Copernicus/ECMWF)

All MetOffice-formatted files use a common pre-industrial baseline (~1850–1900). Format: `Year, Anomaly (°C), Uncertainty (°C)`, annual means.

**Updating GMST data:** Run the following to refresh the five CSVs in `data/` from the Met Office Climate Dashboard (data is released monthly):
```bash
conda activate py12
python scripts/update_gmst_data.py
# then commit data/gmt_*.csv
```

**Pattern for new data viz pages:** host data locally in `data/` (avoids CORS), fetch at runtime, parse in JS, render with Chart.js. Add a card to `resources.html` using the `.resource-card` pattern. See `gmst.html` for the multi-dataset toggle + uncertainty band pattern.

### Data Update Scripts

Climate data scripts live in `scripts/` at the repo root. All write their output to `data/` and can be run from the repo root:

```bash
conda activate py12
python scripts/update_gmst_data.py        # 5 GMST CSVs from Met Office
python scripts/update_eei_data.py         # EEI from CERES EBAF (also runs via GitHub Actions monthly)
python scripts/update_tsi_data.py         # TSI from NOAA NCEI (also runs via GitHub Actions quarterly)
python scripts/update_aod_data.py         # AOD from Sentinel-3A via Copernicus CDS
python scripts/update_modis_aod_data.py   # AOD from MODIS/Aqua via NASA Earthdata (caches HDF4 in scripts/modis_hdf_cache/)
python scripts/update_albedo_c3s.py       # Land surface albedo from C3S/AVHRR via Copernicus CDS
python scripts/update_albedo_modis.py     # Land surface albedo from MODIS MCD43C3 via NASA Earthdata (caches HDF4 in scripts/modis_albedo_hdf_cache/)
```

`scripts/get_noaa_monthly_co2_sites.py` - Scrapes NOAA website for CO2 measurement site codes and prints HTML `<option>` tags + JS URL mapping to stdout (used when refreshing `co2_noaa.html` site list). Uses BeautifulSoup.

The two `update_albedo_*` scripts feed the **Earth's Surface Albedo** section of `climate_trends.html`. Each writes a monthly land-mean time-series CSV (`data/albedo_c3s.csv`, `data/albedo_modis.csv`; columns `year_frac,wsa_global,wsa_nh,wsa_sh,bsa_global,bsa_nh,bsa_sh`) plus two pre-rendered figures committed to `images/` (a mean-albedo map and a zonal-average plot). Both products are land-only. The CDS albedo dataset requires a one-time licence acceptance at the dataset's "Download data" tab; the year range is set by the `YEARS`/`YEAR` constant near the top of each script.

**Dependencies:**
- `requests`, `beautifulsoup4` (CO2 helper)
- `cdsapi`, `numpy`, `xarray` (AOD Sentinel)
- `earthaccess`, `pyhdf`, `numpy` (AOD MODIS)
- `cdsapi`, `numpy`, `xarray`, `matplotlib`, `cartopy` (albedo C3S)
- `earthaccess`, `pyhdf`, `numpy`, `matplotlib`, `cartopy` (albedo MODIS)

### Wine Cellar App (`c/`)

A private, personal inventory app — the one part of this repo that is an
*application* rather than a document. Not linked from `navigation.html`, excluded
in `robots.txt`, and absent from `sitemap.xml`; reach it by bookmark.

- `c/index.html` — the app. Hash-routed single page; **`https://skymath.org/c/#K7M2QP` is
  the URL printed on every physical QR label.** A bare 6-char code is a bottle; anything
  starting `#/` is an app route. That scheme is baked into hundreds of stickers — do not
  change it, and keep `c/index.html` in place permanently even if the app ever moves.
- `c/labels.html` — QR label-sheet generator: presets for 2.625x1 in rectangular and
  0.75 / 1.5 / 2 in round, every dimension editable. No token, no store.
  **Measured 2026-08-22 on a Brother MFC-L3770CDW:** two phones read every size on
  the scan test card down to **0.40 in QR = 0.275 mm per module**. That is the
  empirical floor for this household's hardware — the 0.40 mm/module figure the UI
  warns against is a generic guideline, not a measurement. Don't re-litigate label
  sizing from rules of thumb; reprint the test card if the printer or phones change.
  Round labels must fit content inside the *inscribed circle*, not the bounding box.
- `c/selftest.html` — the test suite. **Run it after every change to the cellar files.**
  Also runs headless: `node -e "require('./js/cellar-model.js');require('./js/cellar-store.js');require('./js/cellar-selftest.js');Cellar.selftest.run().then(s=>{console.log(s.passed+'/'+s.total);process.exit(s.failed?1:0)})"`
- `js/cellar-model.js` — pure: codes, reducers, canonical serialization, CSV. No DOM, no network.
- `js/cellar-store.js` — storage adapters behind one interface. `rev` is opaque and must
  never leak into app code, so the GitHub backend can be swapped for a local one later.
- `js/cellar-app.js` — router, screens, offline queue, sync loop.
- `js/cellar-selftest.js` — shared by the browser page and node.
- `css/cellar.css` — tokens only, `[data-theme="dark"]` block at the bottom.
- `js/vendor/qrcode-generator-1.4.4.js` — vendored (MIT). Deliberately **not** from a CDN:
  the app page holds an access token, so it loads zero third-party scripts.
- `cellar-data-template/` — template for the **separate private** `cellar-data` repo that
  holds the actual bottle data. Not part of the website. Its `.github/` needs the explicit
  `!cellar-data-template/.github/` negation in `.gitignore` to survive the leading `.*` rule.

Develop against `c/index.html?store=memory` — an in-memory store with seeded demo data,
no token and no network. Test with `python3 -m http.server` **from the repo root** (never
`file://`: `fetch` and `crypto.randomUUID` both fail there).

Two invariants that are load-bearing and easy to break silently:
1. **Reducers must be convergent** — "make the state look like this", never "add one to
   that" — because the sync loop replays the whole queue after a conflict.
2. **`model.serialize()` must be deterministic** — the flush logic decides what to write by
   diffing serialized output against freshly fetched state.

**Two ways a bottle leaves the cellar, and they are not interchangeable.**
`DRINK_BOTTLE` is for a bottle that existed: it writes an archive entry with a
denormalized wine snapshot, and retires the label. `DELETE_BOTTLE` is for a bottle that
was *entered by mistake*: it leaves no archive entry and no history, and the label goes
back to `codeStatus() === 'issued'` so the physical sticker can be reused — delete the
wrong bottle, rescan the same sticker, enter it correctly. Deleting the last bottle of a
wine also enqueues `DELETE_WINE`, which removes the wine record only if no bottle and no
archive entry still reference it; that guard is re-evaluated at replay time, so a wine
another device just re-stocked survives. Both are undoable for 10 seconds, via the same
drop-from-queue-else-compensate path as the drink undo.

Adding a second bottle of a wine already in the cellar is **not** a new op type — wines
are normalized, so it is `ADD_BOTTLES` against the existing `wineId` (`#/wine/<id>/add`,
reachable from the wine page and from any bottle card). The Acquisition/Bottles form is
shared with "Add wine" through `acquisitionFormHtml` / `bindAcquisitionForm` /
`readAcquisitionForm`; keep it that way rather than forking a second copy.

## Directory Structure

- **Root HTML files** - Individual site pages (index.html, aboutus.html, contact.html, etc.)
  - `resources.html` - Curated hub page linking to data browsers (CO2, sea ice, temperature), publications, and GitHub
  - `co2_noaa.html`, `nh_seaice.html`, `gmst.html` - Interactive data visualization pages (linked from resources.html)
  - `{slug}.html` at root — instant `<meta refresh>` redirect stubs for QR-code-distributed presentation URLs
- `presentations/` - Presentation detail pages (site-styled with nav/footer)
  - `presentations/index.json` - Manifest file; `ourwork.html` loads this to auto-discover and render presentation cards
  - Note: venue and type fields use plain `&` (not `&amp;`) in the JSON
- `bibtoweb/` - BibTeX to HTML conversion tools, dated BibTeX archives (`mybib_YYYY_MM_DD.bib`), and publications Python scripts
  - `bibtoweb/archive/` - Timestamped backups of `publications.html` created by update workflow
- `scripts/` - Climate data update scripts (write outputs to `data/`); see "Data Update Scripts" section
  - `scripts/modis_hdf_cache/` - Local-only MODIS HDF4 cache (~103 GB, gitignored)
  - `scripts/modis_albedo_hdf_cache/` - Local-only MCD43C3 HDF4 cache (gitignored)
- `css/` - Bootstrap (`bootstrap.css`) and custom styles (`style.css`, `bibbase_custom.css`)
- `js/` - No longer used (jQuery loaded from CDN on all pages)
- `images/` - Site images and logos (`.afdesign`/`.af` design source files are gitignored; keep locally)
- `provide-files/` - Downloadable files (PDFs, NetCDF data, CV, presentation slides)
- `.nojekyll` - Prevents GitHub Pages from running Jekyll processing

## Making Changes

**Editing Pages:**
- HTML files can be edited directly
- To update navigation or footer across all pages, edit `navigation.html` or `footer.html`
- No build or compilation step required
- Changes are live once pushed to the main branch

**Adding New Pages:**
- Create new HTML file following the structure of existing pages (use `contact.html` as template)
- Include jQuery CDN, Font Awesome 6.7.2 CDN + v4-shims, Bootstrap, and style.css in `<head>`
- Include the jQuery snippets for loading navigation and footer
- Use the card-based layout (`about-section` > `container` > flex row of cards)
- Do NOT use the legacy Font Awesome kit script or local `js/jquery.min.js`

**Dependency Installation**
If dependencies are not found, check `conda` environments.
If dependencies are still not detected in conda environments, prompt the user to install them and suggest an efficient method compatible with the rest of the project.