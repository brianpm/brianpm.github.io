/**
 * theme.js — Dark mode toggle and Chart.js theme helper.
 *
 * Apply theme from localStorage immediately (call before DOMContentLoaded
 * to avoid FOUC). Then exposes window.ThemeManager for chart pages.
 *
 * Chart pages should:
 *   1. Include this script after Chart.js but before their own script.
 *   2. Call ThemeManager.applyChartDefaults() after Chart.js loads.
 *   3. Listen for the 'themechange' event on document to update live charts.
 */
(function () {
    'use strict';

    var DARK = 'dark';
    var LIGHT = 'light';

    var CHART_COLORS = {
        light: {
            gridColor:  'rgba(0,0,0,0.06)',
            tickColor:  '#474e5d',
            textColor:  '#474e5d',
            legendColor:'#474e5d',
            bgColor:    '#ffffff',
        },
        dark: {
            gridColor:  'rgba(255,255,255,0.1)',
            tickColor:  '#9ba3b8',
            textColor:  '#9ba3b8',
            legendColor:'#c4c8d4',
            bgColor:    '#252b3b',
        }
    };

    function currentTheme() {
        return document.documentElement.getAttribute('data-theme') === DARK ? DARK : LIGHT;
    }

    function applyTheme(theme) {
        if (theme === DARK) {
            document.documentElement.setAttribute('data-theme', DARK);
        } else {
            document.documentElement.removeAttribute('data-theme');
        }
    }

    function applyChartDefaults() {
        if (typeof Chart === 'undefined') return;
        var theme = currentTheme();
        var c = CHART_COLORS[theme];
        Chart.defaults.color = c.textColor;
        Chart.defaults.borderColor = c.gridColor;
        if (Chart.defaults.plugins && Chart.defaults.plugins.legend) {
            Chart.defaults.plugins.legend.labels = Chart.defaults.plugins.legend.labels || {};
            Chart.defaults.plugins.legend.labels.color = c.legendColor;
        }
    }

    function getChartColors() {
        return CHART_COLORS[currentTheme()];
    }

    // Restore theme from localStorage before first paint
    var saved = localStorage.getItem('theme');
    if (saved === DARK) {
        applyTheme(DARK);
    }

    // Wire the toggle button (may not exist yet — fires after nav loads)
    document.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('#theme-toggle') : null;
        if (!btn) return;
        var isDark = currentTheme() === DARK;
        var next = isDark ? LIGHT : DARK;
        applyTheme(next);
        localStorage.setItem('theme', next);
        btn.textContent = next === DARK ? '🌙' : '☀️';
        document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
    });

    window.ThemeManager = {
        currentTheme: currentTheme,
        getChartColors: getChartColors,
        applyChartDefaults: applyChartDefaults,
    };
}());
