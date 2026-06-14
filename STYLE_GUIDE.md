# SkyMath.org Front-End Style Guide

Reference for anyone editing this site. Follow these rules to keep the design consistent and dark-mode compatible.

---

## Color — always use CSS variables

**Never write a hardcoded hex color** anywhere on this site (HTML `style` attributes, `<style>` blocks, or JS strings). Always use the tokens defined in `css/style.css`. They automatically swap values when dark mode is active.

### Light-mode tokens (defined in `:root`)

| Token | Light value | Usage |
|---|---|---|
| `--color-accent-blue` | `#55bfea` | Primary accent: links on hover, active nav items, card borders on hover, icon highlights, CTA buttons |
| `--color-accent-green` | `#8fc74a` | Secondary accent: logo, molecule animations, card subtitles, period labels |
| `--color-text-dark` | `#474e5d` | Headings, card header text, strong body text |
| `--color-text-mid` | `#575859` | Body text, page-intro paragraphs |
| `--color-text-light` | `#6f6f6f` | Secondary text, captions, footnotes |
| `--color-text-nav` | `#6f8686` | Navigation link default color |
| `--color-bg-page` | `#fff` | Page / body background |
| `--color-bg-card` | `#fff` | Card, panel, and `.stat-card` backgrounds |
| `--color-bg-card-head` | `#f8f9fa` | Card header band (`border-bottom: 2px solid --color-accent-blue`) |
| `--color-bg-light` | `#f4f4f4` | Alternate section backgrounds |
| `--color-bg-follow` | `#f8f8f8` | Follow-section / secondary panel backgrounds |
| `--color-border` | `#eee` | Card outer borders (light) |
| `--color-border-mid` | `#e8e8e8` | Card outer borders (default), table row dividers |
| `--color-border-light` | `#f0f0f0` | Very subtle dividers (inside tables, chart grids) |
| `--color-border-input` | `#bfbfbf` | Form input borders |
| `--color-footer-bg` | `#575859` | Footer background |
| `--color-footer-link` | `#71c8ec` | Links inside the footer |
| `--color-nav-bg` | `rgba(255,255,255,0.95)` | Sticky nav backdrop |
| `--color-nav-mobile-bg` | `#001940` | Mobile nav dropdown background |
| `--color-h2o-atom` | `#a0e1f9` | Water molecule atom color (molecule animation) |
| `--color-logo-text` | `#EEB61C` | Gold used in the "SkyMath" logo wordmark |
| `--color-icon` | `#6f6f6f` | Default Font Awesome icon color |
| `--color-main-title` | `#474e5d` | `<h1>` / page title color |
| `--color-subtitle` | `#55bfea` | Sub-headings / accent headings below the page title |
| `--color-shadow` | `rgba(0,0,0,0.05)` | Default card box-shadow color |
| `--color-shadow-hover` | `rgba(0,0,0,0.1)` | Card box-shadow on hover |

### Dark-mode overrides (defined in `[data-theme="dark"]`)

These are set automatically when the user enables dark mode — you do not need to re-define them per page. The tokens you already use will resolve to their dark values.

| Token | Dark value |
|---|---|
| `--color-text-dark` | `#e8eaf0` |
| `--color-text-mid` | `#c4c8d4` |
| `--color-text-light` | `#9ba3b8` |
| `--color-bg-page` | `#1a1f2e` |
| `--color-bg-card` | `#252b3b` |
| `--color-bg-card-head` | `#1e2434` |
| `--color-border` / `--color-border-mid` | `#3a4155` |
| `--color-footer-bg` | `#0f1320` |
| `--color-nav-bg` | `rgba(26,31,46,0.97)` |
| `--color-shadow` | `rgba(0,0,0,0.2)` |

The accent colors (`--color-accent-blue`, `--color-accent-green`, `--color-logo-text`, `--color-footer-link`) are **the same in both modes** — they hold well on both light and dark backgrounds.

### Exceptions — colors that are intentionally hardcoded

These three are always the same and using a variable adds no value:

| Value | Where | Why |
|---|---|---|
| `#fff` (white text) | CTA button labels, `.head-right p a`, `#theme-toggle` | Always white regardless of theme |
| Dataset line colors in charts | `gmst.html`, `climate_trends.html` | Per-dataset scientific identity, not theme-dependent |
| RMSE badge dark-mode overrides | `forecast_accuracy.html` `[data-theme="dark"]` block | Explicit dark-surface colors that can't be expressed as globals |
| Error box dark surfaces | `#2a1a1a` bg / `#5a2a2a` border / `#f08080` text | Red-tinted dark surface; no equivalent global token |

---

## Dark mode wiring

The toggle is built into `navigation.html` and handled by `js/theme.js`. You only need to do three things when adding content:

### 1. All HTML pages — include theme.js early in `<head>`

```html
<script src="js/theme.js"></script>
```

Place it **after** CSS links but **before** `</head>`. This prevents the flash of light mode on page load by restoring the saved theme before the first paint. For pages in `presentations/`, the path is `../js/theme.js`.

### 2. Colored `<style>` blocks — use variables, not hex

```css
/* ✅ correct */
.my-element { color: var(--color-text-dark); background: var(--color-bg-card); }

/* ❌ wrong */
.my-element { color: #474e5d; background: #fff; }
```

If a color doesn't map to any token in the table above, add a new token to the `:root` / `[data-theme="dark"]` blocks in `css/style.css` rather than hardcoding it.

### 3. Elements that need explicit dark overrides

Sometimes a component has a dark background in light mode (like the forecast table header) and the auto-swap doesn't work cleanly. Add a `[data-theme="dark"]` block at the bottom of the page's `<style>` tag:

```css
[data-theme="dark"] .my-header { background: #2d3654; color: var(--color-text-dark); }
```

Use `#2d3654` as the "dark elevated surface" for elements that were previously `#474e5d` in light mode (the mid-dark grey). See `forecast_accuracy.html` for a worked example.

### 4. Common dark-mode patterns (copy-paste reference)

**Code blocks and inline code** (`.doc-content pre`, `.doc-content code`):
```css
[data-theme="dark"] .doc-content pre      { background: var(--color-bg-card); }
[data-theme="dark"] .doc-content pre code { color: var(--color-text-dark); }
[data-theme="dark"] .doc-content code     { background: var(--color-bg-light); color: var(--color-text-dark); }
[data-theme="dark"] .doc-content .note    { background: var(--color-bg-light); }
```

**Dataset controls bar** (`.dataset-controls`):
```css
[data-theme="dark"] .dataset-controls { background: var(--color-bg-card-head); border-color: var(--color-border-mid); }
```

**Stat cards with per-dataset accent border** (`.stat-card`):
```css
/* border-color resets all sides; border-left-color restores the per-dataset stripe */
[data-theme="dark"] .stat-card { background: var(--color-bg-card); border-color: var(--color-border-mid); border-left-color: var(--ds-color); }
```

**Error messages** — use a brighter red on dark so contrast holds:
```css
/* light mode: built into the CSS rule */
.error-message { color: #c0392b; }
/* dark mode override */
[data-theme="dark"] .error-message { color: #e74c3c; }
```
For error boxes with background/border, use `background: #2a1a1a; border-color: #5a2a2a; color: #f08080;`.

**JS-generated labels** — never use `element.style.cssText` with a hardcoded color. Assign a CSS class instead so the variable system works:
```js
// ❌ wrong — bypasses dark mode
lbl.style.cssText = 'color:#888; font-size:0.78em; ...';
// ✅ correct — CSS class carries var(--color-text-light)
lbl.className = 'controls-source-label';
```

**Separate CSS files** (e.g. `css/bibbase_custom.css`) — dark overrides must live in that same file, not in `style.css`. Add a `[data-theme="dark"]` block at the bottom of the file. The token variables still resolve correctly because `style.css` is loaded first on every page.

### Chart.js pages

Chart.js config objects can't reference CSS variables. Use `ThemeManager` instead:

```js
// Before creating a chart:
ThemeManager.applyChartDefaults();
const chart = new Chart(ctx, config);

// To read current theme colors for custom config:
const c = ThemeManager.getChartColors();
// c.gridColor, c.textColor, c.legendColor, c.tickColor, c.bgColor

// To re-render when the user toggles:
document.addEventListener('themechange', function () {
    // destroy and recreate chart, or update chart.options and call chart.update()
});
```

`ThemeManager` is defined by `js/theme.js` and is available on `window` after that script runs.

### Plotly.js pages

Plotly doesn't use `Chart.defaults`. Add a helper that reads the theme and returns layout overrides:

```js
function plotlyTheme() {
    var dark = ThemeManager.currentTheme() === 'dark';
    return {
        paper_bgcolor: dark ? '#252b3b' : '#ffffff',
        plot_bgcolor:  dark ? '#252b3b' : '#ffffff',
        gridcolor:     dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)',
        tickfont:      { color: dark ? '#9ba3b8' : '#474e5d' },
    };
}
```

Merge these into your `layout` object and listen for `themechange` to re-render. See `northeast-boulder-climate.html` for the full pattern.

---

## Typography

- **Font family:** `'Lato', sans-serif` — loaded from Google Fonts on every page. Weights used: 100, 300, 400, 700, 900.
- **Headings:** `color: var(--color-text-dark)`. No hardcoded color on `<h1>`–`<h6>`.
- **Body text:** inherits from `body { color: var(--color-text-mid) }` set in dark-mode block; defaults to browser default in light mode (effective `#474e5d` via heading styles).
- **Uppercase labels** (period labels, card sub-headings): `color: var(--color-accent-green)`, `font-weight: 600`, `text-transform: uppercase`, `letter-spacing: 1px`.
- **Captions / footnotes:** `color: var(--color-text-light)`, `font-size: 0.82em–0.9em`.

---

## Icons

Use **Font Awesome 6.7.2** with both the main stylesheet and the v4-shims. Both `<link>` tags are required:

```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/v4-shims.min.css">
```

The v4-shims allow the older `fa fa-*` syntax (e.g. `fa fa-cloud`) which this site uses throughout. Always include both lines — omitting the shim breaks existing icons.

Default icon color is `var(--color-icon)`. Accent icons (card headers, CTAs) use `var(--color-accent-blue)`.

Do **not** use the Font Awesome Kit script (`kit.fontawesome.com/...`). It is not used on this site.

---

## Layout

The site uses **Bootstrap 3.x** (loaded from `css/bootstrap.css`). Bootstrap 3 has no built-in dark mode — all dark overrides are manual via the CSS variable system described above.

**Standard page structure:**

```html
<div class="about-section">       <!-- outer section with padding -->
  <div class="container">         <!-- Bootstrap container (max 1170px) -->
    <h2>Section title</h2>
    <div style="display:flex; flex-wrap:wrap; gap:1.5em;">
      <!-- cards here -->
    </div>
  </div>
</div>
```

**Standard card:**

```html
<div style="flex:1 1 260px; background:var(--color-bg-card);
            border:1px solid var(--color-border-mid); border-radius:10px;
            box-shadow:0 2px 8px var(--color-shadow);
            transition:transform 0.3s ease, box-shadow 0.3s ease, border-color 0.3s ease;">
  <div style="background:var(--color-bg-card-head);
              border-bottom:2px solid var(--color-accent-blue);
              border-radius:10px 10px 0 0; padding:1.1em 1.4em;">
    <i class="fa fa-..." style="color:var(--color-accent-blue);"></i>
    <h3 style="color:var(--color-text-dark); text-transform:uppercase; letter-spacing:1.5px;">Title</h3>
    <p style="color:var(--color-accent-green); font-size:0.72em; text-transform:uppercase;">Subtitle</p>
  </div>
  <div style="padding:1.3em 1.4em;">
    <!-- body content -->
  </div>
</div>
```

Use `contact.html` as the canonical style reference for this pattern.

---

## Dependencies

All dependencies are loaded from CDN — **no local copies** (except Bootstrap CSS in `css/bootstrap.css`).

| Library | Version | Load via |
|---|---|---|
| jQuery | 3.7.1 | `https://code.jquery.com/jquery-3.7.1.min.js` |
| Bootstrap CSS | 3.x | local `css/bootstrap.css` |
| Font Awesome | 6.7.2 | cdnjs (both `all.min.css` and `v4-shims.min.css`) |
| Chart.js | latest | `https://cdn.jsdelivr.net/npm/chart.js` |
| chartjs-adapter-date-fns | latest | `https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns/...` |
| PapaParse | 5.3.2 | cdnjs (CSV parsing, sea ice page) |
| Plotly.js | latest | `https://cdn.plot.ly/plotly-latest.min.js` (climate/NE Boulder pages) |

Do **not** load jQuery from `js/jquery.min.js` — the `js/` directory is legacy and jQuery is CDN-only now.

---

## Boilerplate `<head>` for a new page (root level)

```html
<!DOCTYPE HTML>
<html lang="en">
<head>
<title>Page Title — SkyMath.org</title>
<link rel="icon" type="image/x-icon" href="favicon.ico">
<link rel="icon" type="image/png" sizes="16x16" href="favicon-16x16.png">
<link rel="icon" type="image/png" sizes="32x32" href="favicon-32x32.png">
<link rel="apple-touch-icon" sizes="180x180" href="apple-touch-icon.png">
<link href="css/bootstrap.css" rel="stylesheet" type="text/css" media="all">
<link href="css/style.css" rel="stylesheet" type="text/css" media="all">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Type" content="text/html; charset=utf-8">
<link href="https://fonts.googleapis.com/css?family=Lato:100,300,400,700,900" rel="stylesheet">
<script src="https://code.jquery.com/jquery-3.7.1.min.js"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/all.min.css">
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.7.2/css/v4-shims.min.css">
<style>
/* page-specific styles using CSS variables only */
</style>
<script src="js/theme.js"></script>
</head>
```

For pages in `presentations/`, adjust asset paths: `../css/bootstrap.css`, `../css/style.css`, `../js/theme.js`, etc.

---

## Common mistakes to avoid

| ❌ Don't | ✅ Do instead |
|---|---|
| `color: #474e5d` | `color: var(--color-text-dark)` |
| `background: #fff` | `background: var(--color-bg-card)` |
| `border: 1px solid #e8e8e8` | `border: 1px solid var(--color-border-mid)` |
| `color: #575859` in body text | `color: var(--color-text-mid)` |
| `<script src="js/jquery.min.js">` | `<script src="https://code.jquery.com/jquery-3.7.1.min.js">` |
| Font Awesome Kit script | CDN `all.min.css` + `v4-shims.min.css` |
| `Chart.defaults.color = '#474e5d'` | `ThemeManager.applyChartDefaults()` |
| Omitting `theme.js` from `<head>` | Always include `<script src="js/theme.js"></script>` |
| Adding a new global CSS variable inline in a page | Add it to the `:root` / `[data-theme="dark"]` blocks in `css/style.css` |
