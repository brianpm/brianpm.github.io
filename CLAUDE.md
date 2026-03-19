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
- Python 3 (use `py12` conda environment)
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

**Pattern for new data viz pages:** fetch external CSV/text at runtime, parse in JS, render with Chart.js. Add a card to `resources.html` using the `.resource-card` pattern. See `gmst.html` for the multi-dataset toggle + uncertainty band pattern.

### Data Visualization Scripts

`get_noaa_monthly_co2_sites.py` - Scrapes NOAA website for CO2 measurement site data and generates visualization HTML pages. Uses BeautifulSoup for parsing and Plotly for interactive charts.

**Dependencies:**
- `requests`, `beautifulsoup4`, `plotly`, `pandas`

## Directory Structure

- **Root HTML files** - Individual site pages (index.html, aboutus.html, contact.html, etc.)
  - `resources.html` - Curated hub page linking to data browsers (CO2, sea ice, temperature), publications, and GitHub
  - `co2_noaa.html`, `nh_seaice.html`, `gmst.html` - Interactive data visualization pages (linked from resources.html)
  - `{slug}.html` at root — instant `<meta refresh>` redirect stubs for QR-code-distributed presentation URLs
- `presentations/` - Presentation detail pages (site-styled with nav/footer)
  - `presentations/index.json` - Manifest file; `ourwork.html` loads this to auto-discover and render presentation cards
  - Note: venue and type fields use plain `&` (not `&amp;`) in the JSON
- `bibtoweb/` - BibTeX to HTML conversion tools, dated BibTeX archives (`mybib_YYYY_MM_DD.bib`), and Python scripts
  - `bibtoweb/archive/` - Timestamped backups of `publications.html` created by update workflow
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