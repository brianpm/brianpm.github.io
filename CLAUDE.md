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
- Font Awesome icons for visual elements
- Newer pages (e.g. `contact.html`, `resources.html`) use Font Awesome 6.7.2 via CDN and include the v4-shims compatibility shim:
  ```html
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/v4-shims.min.css">
  ```
  Older pages use the legacy kit script (`https://use.fontawesome.com/0745a66b38.js`). Prefer the CDN approach for any new pages.
- Newer pages use a card-based layout with `about-section` container, flex card grids, hover effects, and `#55bfea` accent color. Use `contact.html` as the style reference.

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

### Data Visualization Scripts

`get_noaa_monthly_co2_sites.py` - Scrapes NOAA website for CO2 measurement site data and generates visualization HTML pages. Uses BeautifulSoup for parsing and Plotly for interactive charts.

**Dependencies:**
- `requests`, `beautifulsoup4`, `plotly`, `pandas`

## Directory Structure

- **Root HTML files** - Individual site pages (index.html, aboutus.html, contact.html, etc.)
  - `resources.html` - Curated hub page linking to CO2 data browser, publications, and GitHub
- `bibtoweb/` - BibTeX to HTML conversion tools, dated BibTeX archives (`mybib_YYYY_MM_DD.bib`), and Python scripts
  - `bibtoweb/archive/` - Timestamped backups of `publications.html` created by update workflow
- `css/` - Bootstrap and custom stylesheets
- `js/` - jQuery and other JavaScript libraries
- `images/` - Site images, logos, and graphics
- `provide-files/` - Downloadable files (PDFs, NetCDF data, CV, presentation slides)
- `.nojekyll` - Prevents GitHub Pages from running Jekyll processing

## Making Changes

**Editing Pages:**
- HTML files can be edited directly
- To update navigation or footer across all pages, edit `navigation.html` or `footer.html`
- No build or compilation step required
- Changes are live once pushed to the main branch

**Adding New Pages:**
- Create new HTML file following the structure of existing pages
- Include the jQuery snippets for loading navigation and footer
- Link to Bootstrap CSS and custom styles in the `<head>`
- Add FontAwesome if using icons

**Dependency Installation**
If dependencies are not found, check `conda` environments.
If dependencies are still not detected in conda environments, prompt the user to install them and suggest an efficient method compatible with the rest of the project.