/* cellar-app.js — router, screens and sync loop for the wine cellar app.
 *
 * Local-first by design. Every user action applies to in-memory state, renders,
 * and enqueues an op — all synchronously. The network is never on the tap path,
 * because the tap happens standing in front of a fridge in a basement.
 *
 * Depends on cellar-model.js and cellar-store.js. Classic script, no modules.
 */
(function (global, document) {
    'use strict';

    var Cellar = global.Cellar = global.Cellar || {};
    var model = Cellar.model;
    var stores = Cellar.store;

    /* --------------------------------------------------------- storage */

    // All namespaced. Never localStorage.clear() — that would take the site's
    // `theme` key with it.
    var K = {
        cache:    'cellar.cache.v1',
        queue:    'cellar.queue.v1',
        token:    'cellar.token.v1',
        storecfg: 'cellar.storecfg.v1',
        device:   'cellar.device.v1',
        assign:   'cellar.assign.v1'
    };

    function lsGet(key, fallback) {
        try {
            var raw = localStorage.getItem(key);
            return raw == null ? fallback : JSON.parse(raw);
        } catch (e) { return fallback; }
    }

    function lsSet(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); return true; }
        catch (e) { return false; }
    }

    function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

    /* ----------------------------------------------------------- state */

    var app = {
        store: null,
        storeKind: 'github',
        cfg: null,
        state: null,        // last known-good server state, plus queued ops applied
        revs: {},
        queue: [],
        device: '',
        syncState: 'idle',  // idle | syncing | offline | error | synced
        syncMessage: '',
        lastSyncAt: null,
        flushing: false,
        flushTimer: null,
        pollTimer: null,
        tokenExpiresAt: null,
        booted: false
    };

    function el(id) { return document.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /* ------------------------------------------------------------ sync */

    function setSync(kind, message) {
        app.syncState = kind;
        app.syncMessage = message || '';
        renderSyncPill();
    }

    function renderSyncPill() {
        var pill = el('cellar-sync');
        if (!pill) return;
        var pending = app.queue.length;
        var icon, text, cls;

        if (app.syncState === 'syncing') {
            icon = 'fa-arrows-rotate fa-spin'; cls = 'cellar-sync-syncing';
            text = 'Syncing' + (pending ? ' (' + pending + ')' : '…');
        } else if (app.syncState === 'error') {
            icon = 'fa-triangle-exclamation'; cls = 'cellar-sync-error';
            text = app.syncMessage || 'Sync failed — tap';
        } else if (!navigator.onLine || app.syncState === 'offline') {
            icon = 'fa-cloud-arrow-up'; cls = '';
            text = pending ? 'Offline — ' + pending + ' pending' : 'Offline';
        } else if (pending) {
            icon = 'fa-cloud-arrow-up'; cls = '';
            text = pending + ' pending';
        } else {
            icon = 'fa-check'; cls = 'cellar-sync-synced';
            text = app.lastSyncAt ? 'Synced ' + relTime(app.lastSyncAt) : 'Synced';
        }

        pill.className = 'cellar-sync ' + cls;
        pill.innerHTML = '<i class="fa ' + icon + '"></i> ' + esc(text);
    }

    function relTime(iso) {
        var s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
        if (s < 45) return 'just now';
        if (s < 3600) return Math.round(s / 60) + 'm ago';
        if (s < 86400) return Math.round(s / 3600) + 'h ago';
        return Math.round(s / 86400) + 'd ago';
    }

    function persistLocal() {
        lsSet(K.queue, app.queue);
        // The cache holds SERVER state (pre-queue), so a reload replays the queue
        // on top and reaches the same place. Storing post-queue state would
        // double-apply after a reload.
        lsSet(K.cache, { revs: app.revs, base: app.base, at: model.nowIso() });
    }

    function recompute() {
        app.state = model.replay(app.base, app.queue);
    }

    function enqueue(op) {
        app.queue.push(op);
        recompute();
        persistLocal();
        renderSyncPill();
        scheduleFlush();
    }

    function scheduleFlush(delay) {
        clearTimeout(app.flushTimer);
        app.flushTimer = setTimeout(flush, delay == null ? 800 : delay);
    }

    function commitMessage(ops) {
        if (!ops.length) return 'cellar: update';
        var counts = {};
        ops.forEach(function (o) { counts[o.type] = (counts[o.type] || 0) + 1; });
        var types = Object.keys(counts);
        var who = app.device ? ' [' + app.device + ']' : '';

        if (ops.length === 1) {
            var op = ops[0], p = op.payload;
            switch (op.type) {
                case 'DRINK_BOTTLE':
                    var e = model.index(app.state.archive.entries, 'id')[p.archiveId];
                    var s = e && e.wineSnapshot;
                    return 'cellar: ' + (p.disposition || 'drunk') + ' ' + (e && e.code || '?') +
                           (s ? ' (' + s.producer + ' ' + (s.vintage || '') + ')' : '') + who;
                case 'ADD_BOTTLES':
                    return 'cellar: add ' + p.bottles.length + ' bottle(s)' + who;
                case 'ADD_WINE':
                    return 'cellar: add wine ' + (p.wine.producer || p.wine.name) + who;
                case 'MOVE_BOTTLE':  return 'cellar: move bottle' + who;
                case 'ASSIGN_CODE':  return 'cellar: assign label ' + p.code + who;
                case 'ADD_ARCHIVE_NOTE': return 'cellar: add tasting note' + who;
                case 'ISSUE_CODES':  return 'cellar: issue ' + p.codes.length + ' label codes' + who;
                case 'SET_CONFIG':   return 'cellar: update configuration' + who;
                default: break;
            }
        }
        return 'cellar: ' + ops.length + ' changes (' + types.join(', ') + ')' + who;
    }

    // The retry loop. Re-fetches server truth every attempt, replays the whole
    // queue onto it, and writes only the documents whose SERIALIZED form actually
    // changed. That diff-against-fresh-state check is what makes a partial write
    // safe: a doc that already landed produces no diff and is skipped, so a retry
    // never double-applies.
    function flush() {
        if (app.flushing || !app.queue.length) return Promise.resolve();
        if (!app.store || !app.store.isConfigured()) return Promise.resolve();
        if (!navigator.onLine) { setSync('offline'); return Promise.resolve(); }

        app.flushing = true;
        setSync('syncing');
        var queued = app.queue.slice();

        function attempt(n) {
            return app.store.getAll(model.DOCS).then(function (fresh) {
                var base = {};
                model.DOCS.forEach(function (d) { base[d] = fresh[d].data; });
                var next = model.replay(base, queued);

                var dirty = model.DOCS.filter(function (d) {
                    return model.serialize(d, next[d]) !== model.serialize(d, base[d]);
                });
                var order = model.WRITE_ORDER.filter(function (d) {
                    return dirty.indexOf(d) !== -1;
                });

                var msg = commitMessage(queued);
                var revs = {};
                model.DOCS.forEach(function (d) { revs[d] = fresh[d].rev; });

                var chain = Promise.resolve();
                order.forEach(function (d) {
                    chain = chain.then(function () {
                        return app.store.putDoc(d, next[d], fresh[d].rev, msg)
                            .then(function (r) {
                                revs[d] = r.rev;
                                // GitHub secondary-throttles rapid writes to one repo.
                                return stores.sleep(250);
                            });
                    });
                });

                return chain.then(function () {
                    // Success. Drop exactly the ops we flushed — anything enqueued
                    // during the round trip stays for the next pass.
                    app.base = next;
                    app.revs = revs;
                    app.queue = app.queue.filter(function (op) {
                        return queued.every(function (q) { return q.opId !== op.opId; });
                    });
                    recompute();
                    app.lastSyncAt = model.nowIso();
                    persistLocal();
                    setSync(app.queue.length ? 'idle' : 'synced');
                    if (app.queue.length) scheduleFlush(300);
                    return true;
                }, function (err) {
                    if (!err.isConflict) throw err;
                    if (n >= 4) throw err;
                    var wait = 400 * Math.pow(2, n) + Math.random() * 300;
                    return stores.sleep(wait).then(function () { return attempt(n + 1); });
                });
            });
        }

        return attempt(0).catch(function (err) {
            if (err.kind === 'network' || !navigator.onLine) {
                setSync('offline');
            } else if (err.kind === 'auth') {
                setSync('error', 'Token rejected');
            } else if (err.kind === 'ratelimit') {
                setSync('error', 'Rate limited');
                scheduleFlush(60000);
            } else {
                setSync('error', 'Sync failed — tap');
            }
            app.lastError = err.message;
            // Queue is preserved on every failure path; nothing is ever dropped.
            return false;
        }).then(function (r) {
            app.flushing = false;
            renderSyncPill();
            return r;
        });
    }

    function pullIfChanged() {
        if (!app.store || !app.store.isConfigured()) return Promise.resolve();
        if (!navigator.onLine || app.flushing || app.queue.length) return Promise.resolve();
        return app.store.manifest().then(function (m) {
            var changed = model.DOCS.some(function (d) {
                var seen = app.revs[d] || null;
                var now = (m[d] && m[d].rev) || null;
                return seen !== now;
            });
            if (!changed) return;
            return app.store.getAll(model.DOCS).then(function (fresh) {
                var base = {};
                model.DOCS.forEach(function (d) {
                    base[d] = fresh[d].data;
                    app.revs[d] = fresh[d].rev;
                });
                app.base = base;
                recompute();
                app.lastSyncAt = model.nowIso();
                persistLocal();
                render();
            });
        }).catch(function () { /* a failed poll is not worth surfacing */ });
    }

    function loadAll() {
        if (!app.store || !app.store.isConfigured()) { render(); return Promise.resolve(); }
        setSync('syncing');
        return app.store.getAll(model.DOCS).then(function (fresh) {
            var base = {};
            model.DOCS.forEach(function (d) {
                base[d] = fresh[d].data;
                app.revs[d] = fresh[d].rev;
            });
            app.base = base;
            recompute();
            app.lastSyncAt = model.nowIso();
            app.tokenExpiresAt = app.store.tokenExpiresAt || null;
            persistLocal();
            setSync(app.queue.length ? 'idle' : 'synced');
            render();
            if (app.queue.length) scheduleFlush(200);
        }).catch(function (err) {
            app.lastError = err.message;
            setSync(err.kind === 'network' ? 'offline' : 'error',
                    err.kind === 'auth' ? 'Token rejected' : 'Load failed');
            render();
        });
    }

    /* ---------------------------------------------------------- router */

    function currentRoute() {
        var h = (location.hash || '').replace(/^#/, '');
        if (!h) return { name: 'home' };

        // A bare code is the QR target and must win over everything. Routes are
        // all prefixed with "/" so the two can never collide.
        if (h.charAt(0) !== '/') {
            var code = model.normalizeCode(h);
            if (model.isCode(code)) return { name: 'bottle', code: code };
            if (/^token=/.test(h)) return { name: 'token', token: h.slice(6) };
            return { name: 'badcode', raw: h };
        }

        var parts = h.slice(1).split('/').map(decodeURIComponent);
        switch (parts[0]) {
            case '':         return { name: 'home' };
            case 'add':      return { name: 'add' };
            case 'archive':  return parts[1] ? { name: 'archiveDetail', id: parts[1] }
                                             : { name: 'archive' };
            case 'wine':     return { name: 'wine', id: parts[1] };
            case 'fridge':   return { name: 'shelf', fridgeId: parts[1], shelf: parts[2] };
            case 'search':   return { name: 'search' };
            case 'stats':    return { name: 'stats' };
            case 'tonight':  return { name: 'tonight' };
            case 'settings': return { name: 'settings' };
            case 'import':   return { name: 'import' };
            case 'bottle':   return { name: 'bottleById', id: parts[1] };
            default:         return { name: 'home' };
        }
    }

    // Assigning a label happens while already sitting on that label's URL, so
    // setting an identical hash fires no hashchange and the screen would freeze
    // on "unassigned". Re-render explicitly when the target is where we already are.
    function go(hash) {
        if (location.hash === hash) render();
        else location.hash = hash;
    }

    /* -------------------------------------------------------- rendering */

    function render() {
        var main = el('cellar-main');
        if (!main) return;
        var route = currentRoute();

        if (route.name === 'token') { consumeTokenHandoff(route.token); return; }

        // Settings must stay reachable with no token — it is where you enter one.
        if (!app.store || !app.store.isConfigured()) {
            if (route.name === 'settings') { renderSettings(main); return; }
            renderLocked(main, route);
            return;
        }
        if (!app.state) { main.innerHTML = '<div class="cellar-empty"><i class="fa fa-hourglass-half"></i>Loading…</div>'; return; }

        switch (route.name) {
            case 'home':          renderHome(main); break;
            case 'bottle':        renderBottle(main, route.code); break;
            case 'bottleById':    renderBottleById(main, route.id); break;
            case 'badcode':       renderBadCode(main, route.raw); break;
            case 'shelf':         renderShelf(main, route.fridgeId, route.shelf); break;
            case 'add':           renderAdd(main); break;
            case 'wine':          renderWine(main, route.id); break;
            case 'archive':       renderArchive(main); break;
            case 'archiveDetail': renderArchiveDetail(main, route.id); break;
            case 'search':        renderSearch(main); break;
            case 'stats':         renderStats(main); break;
            case 'tonight':       renderTonight(main); break;
            case 'import':        renderImport(main); break;
            case 'settings':      renderSettings(main); break;
            default:              renderHome(main);
        }
        renderSyncPill();
    }

    function backLink(href, label) {
        return '<p><a class="cellar-muted" href="' + href + '">' +
               '<i class="fa fa-chevron-left"></i> ' + esc(label) + '</a></p>';
    }

    function colorClass(w) { return 'cellar-chip-' + ((w && w.color) || 'other'); }

    /* -- locked (no token) ------------------------------------------- */

    // Deliberately identical whether or not the code exists: distinguishing
    // "unassigned" from "assigned" would leak the cellar's contents to anyone
    // who scans a bottle at a dinner party.
    function renderLocked(main, route) {
        var code = route.name === 'bottle' ? route.code : null;
        main.innerHTML =
            '<div class="cellar-locked">' +
                '<h2>Private cellar catalog</h2>' +
                (code ? '<div class="cellar-code">' + esc(code) + '</div>' : '') +
                '<p class="cellar-muted">This page is a personal wine inventory. ' +
                'It needs to be set up on this device before it will show anything.</p>' +
                '<p><a class="cellar-btn cellar-btn-sm" href="#/settings">Set up this device</a></p>' +
                '<p style="margin-top:2em;"><a class="cellar-muted" href="/">skymath.org</a></p>' +
            '</div>';
    }

    /* -- home --------------------------------------------------------- */

    function renderHome(main) {
        var st = model.stats(app.state);
        var fridges = (app.state.config.fridges || [])
            .filter(function (f) { return f.active !== false; })
            .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });

        var html = renderAssignStrip();

        html += '<div class="cellar-field" style="margin-top:0.6em;">' +
                '<input id="cellar-quick" type="search" placeholder="Search producer, wine, region, code…" ' +
                'autocomplete="off" autocapitalize="none"></div>';

        if (!fridges.length) {
            html += '<div class="cellar-empty"><i class="fa fa-wine-bottle"></i>' +
                    '<p>No fridges configured yet.</p>' +
                    '<a class="cellar-btn cellar-btn-primary" href="#/settings">Set up fridges</a></div>';
        }

        fridges.forEach(function (f) {
            var inFridge = (app.state.bottles.bottles || []).filter(function (b) {
                return b.fridgeId === f.id;
            });
            var max = 1;
            var perShelf = [];
            for (var s = 1; s <= (f.shelfCount || 0); s++) {
                var n = inFridge.filter(function (b) { return Number(b.shelf) === s; }).length;
                perShelf.push(n);
                if (n > max) max = n;
            }
            html += '<div class="cellar-card">' +
                '<div class="cellar-card-head"><i class="fa fa-snowflake"></i>' +
                '<h3>' + esc(f.name) + '</h3>' +
                '<span class="cellar-count">' + inFridge.length + '</span></div>' +
                '<div class="cellar-card-body" style="padding-top:0.2em;padding-bottom:0.2em;">';
            for (var i = 0; i < perShelf.length; i++) {
                var label = (f.shelfLabels && f.shelfLabels[i]) || ('Shelf ' + (i + 1));
                var count = perShelf[i];
                var pct = Math.round((count / max) * 100);
                html += '<a class="cellar-shelf-row' + (count ? '' : ' cellar-shelf-empty') + '" ' +
                        'href="#/fridge/' + encodeURIComponent(f.id) + '/' + (i + 1) + '">' +
                        '<span class="cellar-shelf-name">' + esc(label) + '</span>' +
                        '<span class="cellar-shelf-bar" style="width:' + Math.max(pct, count ? 6 : 0) + 'px;"></span>' +
                        '<span class="cellar-muted">' + count + '</span>' +
                        '<i class="fa fa-chevron-right cellar-muted"></i></a>';
            }
            html += '</div></div>';
        });

        var unassigned = (app.state.bottles.bottles || []).filter(function (b) { return !b.fridgeId; });
        if (unassigned.length) {
            html += '<div class="cellar-banner cellar-banner-info">' +
                    unassigned.length + ' bottle(s) have no fridge assigned. ' +
                    '<a href="#/search">Find them</a></div>';
        }
        if (st.unlabeled) {
            html += '<div class="cellar-banner">' + st.unlabeled +
                    ' bottle(s) have no QR label yet. Stick a label on one and scan it to link them up.</div>';
        }

        html += '<div class="cellar-actions" style="padding-left:0;padding-right:0;">' +
                '<a class="cellar-btn cellar-btn-primary cellar-btn-block" href="#/add">' +
                '<i class="fa fa-plus"></i> Add wine</a>' +
                '<div class="cellar-actions-row">' +
                '<a class="cellar-btn" href="#/tonight"><i class="fa fa-glass-cheers"></i> Tonight</a>' +
                '<a class="cellar-btn" href="#/archive"><i class="fa fa-clock-rotate-left"></i> Archive</a>' +
                '<a class="cellar-btn" href="#/stats"><i class="fa fa-chart-simple"></i> Stats</a>' +
                '</div></div>';

        main.innerHTML = html;

        var quick = el('cellar-quick');
        if (quick) {
            quick.addEventListener('keydown', function (e) {
                if (e.key !== 'Enter') return;
                var v = quick.value.trim();
                var code = model.normalizeCode(v);
                // Typing a label code straight into search should just open it.
                if (model.isCode(code) && model.codeStatus(app.state, code) !== 'unknown') {
                    go('#' + code);
                } else {
                    sessionStorage.setItem('cellar.q', v);
                    go('#/search');
                }
            });
        }
        bindAssignStrip();
    }

    /* -- assign session ---------------------------------------------- */

    function renderAssignStrip() {
        var sess = lsGet(K.assign, null);
        if (!sess) return '';
        var remaining = (app.state.bottles.bottles || []).filter(function (b) {
            return b.wineId === sess.wineId && !b.code;
        });
        if (!remaining.length) { lsDel(K.assign); return ''; }
        var w = model.wineById(app.state, sess.wineId);
        return '<div class="cellar-assign-strip">' +
            '<div class="cellar-muted">Labelling session</div>' +
            '<strong>' + esc(model.wineLabel(w)) + '</strong><br>' +
            '<span class="cellar-muted">' + remaining.length + ' of ' + sess.total +
            ' bottle(s) still need a label. Scan one to assign it.</span>' +
            '<div style="margin-top:0.7em;"><button class="cellar-btn cellar-btn-sm" ' +
            'id="cellar-assign-stop">End session</button></div></div>';
    }

    function bindAssignStrip() {
        var stop = el('cellar-assign-stop');
        if (stop) stop.addEventListener('click', function () { lsDel(K.assign); render(); });
    }

    /* -- bottle detail (the scan landing page) ------------------------ */

    function renderBottle(main, code) {
        var b = model.bottleByCode(app.state, code);
        if (b) return renderBottleCard(main, b, code);

        var arch = model.archiveByCode(app.state, code);
        if (arch) {
            main.innerHTML =
                '<div class="cellar-banner">This label was on a bottle that has already been ' +
                esc(arch.disposition || 'consumed') + '.</div>';
            renderArchiveDetail(main, arch.id, true);
            return;
        }

        var status = model.codeStatus(app.state, code);
        if (status === 'issued') return renderUnassigned(main, code);
        renderBadCode(main, code);
    }

    function renderBottleById(main, id) {
        var b = model.index(app.state.bottles.bottles, 'id')[id];
        if (!b) { renderBadCode(main, id); return; }
        renderBottleCard(main, b, b.code);
    }

    function renderBottleCard(main, b, code) {
        var w = model.wineById(app.state, b.wineId);
        var f = model.fridgeById(app.state, b.fridgeId);
        var year = new Date().getFullYear();
        var win = model.drinkWindowState(w, year);
        var siblings = (app.state.bottles.bottles || []).filter(function (x) {
            return x.wineId === b.wineId && x.id !== b.id;
        });

        var html = '<div class="cellar-card"><div class="cellar-hero">' +
            '<div class="cellar-hero-producer">' + esc((w && w.producer) || 'Unknown producer') + '</div>' +
            ((w && w.name && w.name !== w.producer)
                ? '<div class="cellar-hero-name">' + esc(w.name) + '</div>' : '') +
            '<div class="cellar-hero-vintage">' +
                esc(w && w.nv ? 'NV' : ((w && w.vintage) || '—')) + '</div>';

        var meta = [];
        if (w && w.varietals && w.varietals.length) meta.push(w.varietals.join(', '));
        if (w && (w.appellation || w.region)) meta.push(w.appellation || w.region);
        if (w && w.country) meta.push(w.country);
        if (b.sizeMl && b.sizeMl !== 750) meta.push(b.sizeMl + ' mL');
        if (meta.length) html += '<div class="cellar-hero-meta">' + esc(meta.join(' · ')) + '</div>';

        if (win !== 'unknown') {
            var label = { ready: 'Ready now', young: 'Too young', past: 'Past window' }[win];
            html += '<div style="margin-top:0.6em;"><span class="cellar-badge cellar-badge-' +
                    win + '">' + label + '</span> <span class="cellar-muted">' +
                    esc(windowText(w)) + '</span></div>';
        }

        html += '<div class="cellar-location"><i class="fa fa-location-dot"></i> ' +
                esc(f ? f.name : 'No fridge') +
                (b.shelf != null ? ' · ' + esc(shelfLabel(f, b.shelf)) : '') +
                (b.slot ? ' · ' + esc(b.slot) : '') + '</div>';
        html += '</div>';

        html += '<div class="cellar-actions">' +
            '<button class="cellar-btn cellar-btn-primary cellar-btn-block" id="cellar-drink">' +
            '<i class="fa fa-wine-glass"></i> Drink this</button>' +
            '<div class="cellar-actions-row">' +
            '<button class="cellar-btn" id="cellar-move"><i class="fa fa-arrows-up-down-left-right"></i> Move</button>' +
            '<button class="cellar-btn" id="cellar-edit"><i class="fa fa-pen"></i> Edit</button>' +
            '</div>' +
            '<button class="cellar-btn cellar-btn-sm" id="cellar-other">Other outcome…</button>' +
            '</div></div>';

        html += '<div class="cellar-card"><div class="cellar-card-body"><ul class="cellar-facts">';
        html += fact('Label', code ? '<span class="cellar-code">' + esc(code) + '</span>' : 'none', true);
        if (b.acquiredFrom) html += fact('Bought from', b.acquiredFrom);
        if (b.acquiredAt)   html += fact('Purchased', b.acquiredAt);
        if (b.costCents != null) html += fact('Price', model.formatMoney(b.costCents, b.currency));
        if (w && w.abv)     html += fact('ABV', w.abv + '%');
        if (b.notes)        html += fact('Notes', b.notes);
        html += '</ul>';
        if (siblings.length) {
            html += '<p style="margin-top:0.9em;"><a href="#/wine/' + encodeURIComponent(b.wineId) + '">' +
                    siblings.length + ' other bottle(s) of this wine <i class="fa fa-chevron-right"></i></a></p>';
        } else if (w) {
            html += '<p style="margin-top:0.9em;"><a href="#/wine/' + encodeURIComponent(b.wineId) +
                    '">Wine details <i class="fa fa-chevron-right"></i></a></p>';
        }
        html += '</div></div>';
        html += backLink('#/', 'All fridges');

        main.innerHTML = html;

        el('cellar-drink').addEventListener('click', function () { doDrink(b, 'drunk'); });
        el('cellar-move').addEventListener('click', function () { openMove(b); });
        el('cellar-edit').addEventListener('click', function () { openEditBottle(b); });
        el('cellar-other').addEventListener('click', function () { openDisposition(b); });
    }

    function shelfLabel(f, shelf) {
        if (f && f.shelfLabels && f.shelfLabels[shelf - 1]) return f.shelfLabels[shelf - 1];
        return 'Shelf ' + shelf;
    }

    function windowText(w) {
        if (!w) return '';
        if (w.drinkFrom && w.drinkTo) return w.drinkFrom + '–' + w.drinkTo;
        if (w.drinkFrom) return 'from ' + w.drinkFrom;
        if (w.drinkTo) return 'through ' + w.drinkTo;
        return '';
    }

    function fact(key, val, raw) {
        return '<li><span class="cellar-fact-key">' + esc(key) + '</span>' +
               '<span class="cellar-fact-val">' + (raw ? val : esc(val)) + '</span></li>';
    }

    /* -- drink -------------------------------------------------------- */

    function doDrink(b, disposition, rating, note) {
        var archiveId = model.newId();
        var op = model.makeOp('DRINK_BOTTLE', {
            bottleId: b.id,
            archiveId: archiveId,
            disposition: disposition || 'drunk',
            occurredAt: model.nowIso(),
            rating: rating == null ? null : rating,
            note: note || null,
            noteId: note ? model.newId() : null
        }, app.device);
        enqueue(op);

        var w = model.wineById(app.state, b.wineId);
        // A 10-second undo is not optional: mis-tapping while holding two bottles
        // is a matter of when, not if.
        toast('Logged: ' + model.wineLabel(w), 'Undo', function () {
            undoOp(op.opId, archiveId);
        });
        go('#/archive/' + encodeURIComponent(archiveId));
    }

    // Undo removes the op from the queue if it has not synced yet; once it has,
    // it becomes a real RESTORE_BOTTLE op.
    function undoOp(opId, archiveId) {
        var idx = -1;
        for (var i = 0; i < app.queue.length; i++) {
            if (app.queue[i].opId === opId) { idx = i; break; }
        }
        if (idx !== -1) {
            app.queue.splice(idx, 1);
            recompute();
            persistLocal();
            renderSyncPill();
        } else {
            enqueue(model.makeOp('RESTORE_BOTTLE', { archiveId: archiveId }, app.device));
        }
        go('#/');
    }

    function openDisposition(b) {
        var opts = model.DISPOSITIONS.map(function (d) {
            return '<button class="cellar-segment" data-d="' + d + '">' + d + '</button>';
        }).join('');
        modal('What happened to this bottle?',
            '<div class="cellar-segments" id="cellar-disp">' + opts + '</div>',
            function (root) {
                root.querySelectorAll('[data-d]').forEach(function (btn) {
                    btn.addEventListener('click', function () {
                        closeModal();
                        doDrink(b, btn.getAttribute('data-d'));
                    });
                });
            });
    }

    /* -- move --------------------------------------------------------- */

    function openMove(b, onDone) {
        var fridges = (app.state.config.fridges || []).filter(function (f) { return f.active !== false; });
        if (!fridges.length) { alert('No fridges configured yet — add one in Settings.'); return; }

        var chosen = { fridgeId: b.fridgeId || fridges[0].id, shelf: b.shelf || 1 };

        function body() {
            var f = model.fridgeById(app.state, chosen.fridgeId) || fridges[0];
            var h = '<div class="cellar-field"><label>Fridge</label><div class="cellar-segments">';
            fridges.forEach(function (x) {
                h += '<button class="cellar-segment' + (x.id === chosen.fridgeId ? ' cellar-segment-on' : '') +
                     '" data-f="' + esc(x.id) + '">' + esc(x.name) + '</button>';
            });
            h += '</div></div><div class="cellar-field"><label>Shelf</label><div class="cellar-segments">';
            for (var s = 1; s <= (f.shelfCount || 1); s++) {
                h += '<button class="cellar-segment' + (Number(chosen.shelf) === s ? ' cellar-segment-on' : '') +
                     '" data-s="' + s + '">' + esc(shelfLabel(f, s)) + '</button>';
            }
            h += '</div></div>' +
                 '<button class="cellar-btn cellar-btn-primary cellar-btn-block" id="cellar-move-go">Move here</button>';
            return h;
        }

        function bind(root) {
            root.querySelectorAll('[data-f]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    chosen.fridgeId = btn.getAttribute('data-f');
                    chosen.shelf = 1;
                    root.innerHTML = body(); bind(root);
                });
            });
            root.querySelectorAll('[data-s]').forEach(function (btn) {
                btn.addEventListener('click', function () {
                    chosen.shelf = Number(btn.getAttribute('data-s'));
                    root.innerHTML = body(); bind(root);
                });
            });
            root.querySelector('#cellar-move-go').addEventListener('click', function () {
                enqueue(model.makeOp('MOVE_BOTTLE', {
                    bottleId: b.id, fridgeId: chosen.fridgeId, shelf: chosen.shelf, slot: b.slot || ''
                }, app.device));
                closeModal();
                if (onDone) onDone(); else render();
            });
        }

        modal('Move bottle', body(), bind);
    }

    /* -- edit bottle -------------------------------------------------- */

    function openEditBottle(b) {
        var html =
            '<div class="cellar-field"><label>Bought from</label>' +
            '<input id="ce-from" value="' + esc(b.acquiredFrom || '') + '"></div>' +
            '<div class="cellar-field-row">' +
            '<div class="cellar-field"><label>Purchase date</label>' +
            '<input id="ce-at" type="date" value="' + esc(b.acquiredAt || '') + '"></div>' +
            '<div class="cellar-field"><label>Price</label>' +
            '<input id="ce-price" inputmode="decimal" value="' +
            (b.costCents == null ? '' : (b.costCents / 100).toFixed(2)) + '"></div></div>' +
            '<div class="cellar-field"><label>Slot / position (optional)</label>' +
            '<input id="ce-slot" value="' + esc(b.slot || '') + '"></div>' +
            '<div class="cellar-field"><label>Notes</label>' +
            '<textarea id="ce-notes">' + esc(b.notes || '') + '</textarea></div>' +
            '<button class="cellar-btn cellar-btn-primary cellar-btn-block" id="ce-save">Save</button>';

        modal('Edit bottle', html, function (root) {
            root.querySelector('#ce-save').addEventListener('click', function () {
                enqueue(model.makeOp('EDIT_BOTTLE', {
                    bottleId: b.id,
                    fields: {
                        acquiredFrom: root.querySelector('#ce-from').value.trim(),
                        acquiredAt: root.querySelector('#ce-at').value || null,
                        costCents: model.parseMoneyCents(root.querySelector('#ce-price').value),
                        slot: root.querySelector('#ce-slot').value.trim(),
                        notes: root.querySelector('#ce-notes').value.trim()
                    }
                }, app.device));
                closeModal();
                render();
            });
        });
    }

    /* -- unassigned label --------------------------------------------- */

    function renderUnassigned(main, code) {
        var sess = lsGet(K.assign, null);
        var html = '<div class="cellar-card"><div class="cellar-card-head">' +
            '<i class="fa fa-tag"></i><h3>Unassigned label</h3></div>' +
            '<div class="cellar-card-body">' +
            '<p>Label <span class="cellar-code">' + esc(code) + '</span> is printed but not yet on a tracked bottle.</p>';

        // The whole point of the labelling session: entering a case is 12 taps,
        // not 12 forms.
        if (sess) {
            var remaining = (app.state.bottles.bottles || []).filter(function (b) {
                return b.wineId === sess.wineId && !b.code;
            });
            if (remaining.length) {
                var w = model.wineById(app.state, sess.wineId);
                var done = sess.total - remaining.length + 1;
                html += '<div class="cellar-assign-strip">' +
                    '<div class="cellar-muted">Labelling session in progress</div>' +
                    '<strong>' + esc(model.wineLabel(w)) + '</strong><br>' +
                    '<span class="cellar-muted">Bottle ' + done + ' of ' + sess.total + '</span>' +
                    '<div style="margin-top:0.7em;">' +
                    '<button class="cellar-btn cellar-btn-primary cellar-btn-block" id="cellar-assign-go">' +
                    '<i class="fa fa-check"></i> Assign this label</button>' +
                    '<button class="cellar-btn cellar-btn-sm" id="cellar-assign-skip">Not this wine</button>' +
                    '</div></div>';
            }
        }

        html += '<div class="cellar-field" style="margin-top:1em;"><label>Assign to an existing wine</label>' +
            '<input id="cellar-typeahead" placeholder="Type a producer or wine name…" autocomplete="off"></div>' +
            '<div id="cellar-typeahead-results"></div>' +
            '<a class="cellar-btn cellar-btn-block" href="#/add?code=' + encodeURIComponent(code) + '">' +
            '<i class="fa fa-plus"></i> This is a new wine</a>' +
            '</div></div>' + backLink('#/', 'All fridges');

        main.innerHTML = html;

        var go1 = el('cellar-assign-go');
        if (go1) go1.addEventListener('click', function () {
            var sess2 = lsGet(K.assign, null);
            var next = (app.state.bottles.bottles || []).filter(function (b) {
                return b.wineId === sess2.wineId && !b.code;
            })[0];
            if (!next) { lsDel(K.assign); render(); return; }
            assignCode(next, code);
        });
        var skip = el('cellar-assign-skip');
        if (skip) skip.addEventListener('click', function () { lsDel(K.assign); render(); });

        bindTypeahead(code);
    }

    function bindTypeahead(code) {
        var input = el('cellar-typeahead');
        var out = el('cellar-typeahead-results');
        if (!input || !out) return;

        input.addEventListener('input', function () {
            var q = input.value.trim().toLowerCase();
            if (q.length < 2) { out.innerHTML = ''; return; }
            var matches = (app.state.wines.wines || []).filter(function (w) {
                return (model.wineLabel(w) + ' ' + (w.region || '')).toLowerCase().indexOf(q) !== -1;
            }).slice(0, 8);

            if (!matches.length) { out.innerHTML = '<p class="cellar-muted">No match.</p>'; return; }

            out.innerHTML = '<ul class="cellar-list">' + matches.map(function (w) {
                var unlabeled = (app.state.bottles.bottles || []).filter(function (b) {
                    return b.wineId === w.id && !b.code;
                }).length;
                return '<li><a href="#" data-w="' + esc(w.id) + '">' +
                    '<span class="cellar-chip ' + colorClass(w) + '"></span>' +
                    '<span class="cellar-list-main"><span class="cellar-list-title">' +
                    esc(model.wineLabel(w)) + '</span>' +
                    '<span class="cellar-list-sub">' +
                    (unlabeled ? unlabeled + ' unlabeled bottle(s)' : 'all bottles labeled — adds a new one') +
                    '</span></span></a></li>';
            }).join('') + '</ul>';

            out.querySelectorAll('[data-w]').forEach(function (a) {
                a.addEventListener('click', function (e) {
                    e.preventDefault();
                    var wineId = a.getAttribute('data-w');
                    var target = (app.state.bottles.bottles || []).filter(function (b) {
                        return b.wineId === wineId && !b.code;
                    })[0];
                    if (target) { assignCode(target, code); return; }
                    // No spare bottle of this wine: create one and label it.
                    var nb = newBottleRecord(wineId, {});
                    nb.code = code;
                    enqueue(model.makeOp('ADD_BOTTLES', { bottles: [nb] }, app.device));
                    go('#' + code);
                });
            });
        });
    }

    function assignCode(bottle, code) {
        enqueue(model.makeOp('ASSIGN_CODE', { bottleId: bottle.id, code: code }, app.device));
        var sess = lsGet(K.assign, null);
        if (sess) {
            var left = (app.state.bottles.bottles || []).filter(function (b) {
                return b.wineId === sess.wineId && !b.code;
            }).length;
            if (!left) { lsDel(K.assign); toast('Case fully labeled.'); }
        }
        go('#' + code);
    }

    function renderBadCode(main, raw) {
        main.innerHTML =
            '<div class="cellar-card"><div class="cellar-card-head">' +
            '<i class="fa fa-circle-question"></i><h3>Label not recognized</h3></div>' +
            '<div class="cellar-card-body">' +
            '<p class="cellar-muted">No label matching <span class="cellar-code">' + esc(raw) +
            '</span> has been issued. If the printed code is scratched, type what you can read:</p>' +
            '<div class="cellar-field"><input id="cellar-manual" placeholder="e.g. K7M2QP" ' +
            'autocapitalize="characters" autocomplete="off" maxlength="12"></div>' +
            '<button class="cellar-btn cellar-btn-primary cellar-btn-block" id="cellar-manual-go">Look up</button>' +
            '<p class="cellar-field-hint">Letters I, L, O and U are never used on labels — ' +
            'they are read as 1, 1, 0 and nothing.</p>' +
            '</div></div>' + backLink('#/', 'All fridges');

        function lookup() {
            var v = model.normalizeCode(el('cellar-manual').value);
            if (!model.isCode(v)) { alert('That is not a 6-character label code.'); return; }
            go('#' + v);
        }
        el('cellar-manual-go').addEventListener('click', lookup);
        el('cellar-manual').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') lookup();
        });
    }

    /* -- shelf -------------------------------------------------------- */

    function renderShelf(main, fridgeId, shelf) {
        var f = model.fridgeById(app.state, fridgeId);
        var n = Number(shelf);
        var list = (app.state.bottles.bottles || []).filter(function (b) {
            return b.fridgeId === fridgeId && Number(b.shelf) === n;
        });
        main.innerHTML = backLink('#/', 'All fridges') +
            '<h2>' + esc(f ? f.name : 'Fridge') + ' · ' + esc(shelfLabel(f, n)) + '</h2>' +
            (list.length ? '<div class="cellar-card">' + bottleListHtml(list) + '</div>'
                         : '<div class="cellar-empty"><i class="fa fa-wine-bottle"></i>This shelf is empty.</div>');
    }

    function bottleListHtml(list) {
        var year = new Date().getFullYear();
        var rows = list.map(function (b) {
            var w = model.wineById(app.state, b.wineId);
            var win = model.drinkWindowState(w, year);
            return { b: b, w: w, win: win, key: (model.wineLabel(w) || '').toLowerCase() };
        }).sort(function (x, y) { return x.key < y.key ? -1 : x.key > y.key ? 1 : 0; });

        return '<ul class="cellar-list">' + rows.map(function (r) {
            var sub = [];
            if (r.w && r.w.region) sub.push(r.w.region);
            if (r.w && r.w.varietals && r.w.varietals.length) sub.push(r.w.varietals[0]);
            return '<li><a href="' + (r.b.code ? '#' + r.b.code
                                               : '#/bottle/' + encodeURIComponent(r.b.id)) + '">' +
                '<span class="cellar-chip ' + colorClass(r.w) + '"></span>' +
                '<span class="cellar-list-main">' +
                '<span class="cellar-list-title">' + esc(model.wineLabel(r.w)) + '</span>' +
                '<span class="cellar-list-sub">' + esc(sub.join(' · ')) +
                (r.win === 'ready' ? ' <span class="cellar-badge cellar-badge-ready">ready</span>' : '') +
                (r.win === 'past' ? ' <span class="cellar-badge cellar-badge-past">past</span>' : '') +
                '</span></span>' +
                (r.b.code ? '<span class="cellar-code">' + esc(r.b.code) + '</span>'
                          : '<span class="cellar-muted"><i class="fa fa-tag"></i></span>') +
                '</a></li>';
        }).join('') + '</ul>';
    }

    /* -- add wine ----------------------------------------------------- */

    function newBottleRecord(wineId, v) {
        return {
            id: model.newId(),
            wineId: wineId,
            code: null,
            fridgeId: v.fridgeId || null,
            shelf: v.shelf != null ? v.shelf : null,
            slot: '',
            acquiredFrom: v.acquiredFrom || '',
            acquiredAt: v.acquiredAt || null,
            costCents: v.costCents == null ? null : v.costCents,
            currency: app.state.config.currency || 'USD',
            sizeMl: v.sizeMl || 750,
            notes: ''
        };
    }

    function renderAdd(main) {
        var fridges = (app.state.config.fridges || []).filter(function (f) { return f.active !== false; });
        var pendingCode = (location.hash.split('?code=')[1] || '');
        var colorOpts = model.COLORS.map(function (c) {
            return '<option value="' + c + '">' + c + '</option>';
        }).join('');
        var fridgeOpts = fridges.map(function (f) {
            return '<option value="' + esc(f.id) + '">' + esc(f.name) + '</option>';
        }).join('');

        main.innerHTML = backLink('#/', 'All fridges') + '<h2>Add wine</h2>' +
            '<div class="cellar-card"><div class="cellar-card-body">' +
            '<div class="cellar-field"><label>Producer</label><input id="ca-producer" autofocus></div>' +
            '<div class="cellar-field"><label>Wine name</label><input id="ca-name"></div>' +
            '<div class="cellar-field-row">' +
              '<div class="cellar-field"><label>Vintage</label>' +
              '<input id="ca-vintage" inputmode="numeric" placeholder="2019 or NV"></div>' +
              '<div class="cellar-field"><label>Color</label>' +
              '<select id="ca-color">' + colorOpts + '</select></div></div>' +
            '<div class="cellar-field"><label>Varietal(s)</label>' +
            '<input id="ca-varietals" placeholder="Cabernet Sauvignon, Merlot"></div>' +
            '<div class="cellar-field-row">' +
              '<div class="cellar-field"><label>Region</label><input id="ca-region"></div>' +
              '<div class="cellar-field"><label>Country</label><input id="ca-country"></div></div>' +
            '<div class="cellar-field-row">' +
              '<div class="cellar-field"><label>Drink from</label>' +
              '<input id="ca-from" inputmode="numeric"></div>' +
              '<div class="cellar-field"><label>Drink to</label>' +
              '<input id="ca-to" inputmode="numeric"></div></div>' +
            '<div class="cellar-field"><label>Notes</label><textarea id="ca-notes"></textarea></div>' +
            '</div></div>' +

            '<div class="cellar-card"><div class="cellar-card-head">' +
            '<i class="fa fa-cart-shopping"></i><h3>Acquisition</h3></div>' +
            '<div class="cellar-card-body">' +
            '<div class="cellar-field"><label>Bought from</label><input id="ca-vendor"></div>' +
            '<div class="cellar-field-row">' +
              '<div class="cellar-field"><label>Purchase date</label>' +
              '<input id="ca-date" type="date"></div>' +
              '<div class="cellar-field"><label>Price per bottle</label>' +
              '<input id="ca-price" inputmode="decimal" placeholder="89.99"></div></div>' +
            '</div></div>' +

            '<div class="cellar-card"><div class="cellar-card-head">' +
            '<i class="fa fa-boxes-stacked"></i><h3>Bottles</h3></div>' +
            '<div class="cellar-card-body">' +
            '<div class="cellar-field-row">' +
              '<div class="cellar-field"><label>How many bottles</label>' +
              '<input id="ca-qty" inputmode="numeric" value="1"></div>' +
              '<div class="cellar-field"><label>Size (mL)</label>' +
              '<input id="ca-size" inputmode="numeric" value="750"></div></div>' +
            '<div class="cellar-field-row">' +
              '<div class="cellar-field"><label>Fridge</label>' +
              '<select id="ca-fridge">' + fridgeOpts + '</select></div>' +
              '<div class="cellar-field"><label>Shelf</label>' +
              '<select id="ca-shelf"></select></div></div>' +
            (pendingCode ? '<p class="cellar-muted">Label <span class="cellar-code">' +
                esc(pendingCode) + '</span> will be assigned to the first bottle.</p>' : '') +
            '<button class="cellar-btn cellar-btn-primary cellar-btn-block" id="ca-save">' +
            '<i class="fa fa-check"></i> Add</button>' +
            '<p class="cellar-field-hint">After saving, scan a label on each bottle to link it up.</p>' +
            '</div></div>';

        function syncShelves() {
            var f = model.fridgeById(app.state, el('ca-fridge').value);
            var sel = el('ca-shelf');
            sel.innerHTML = '';
            for (var s = 1; s <= ((f && f.shelfCount) || 1); s++) {
                sel.innerHTML += '<option value="' + s + '">' + esc(shelfLabel(f, s)) + '</option>';
            }
        }
        if (fridges.length) { syncShelves(); el('ca-fridge').addEventListener('change', syncShelves); }

        el('ca-save').addEventListener('click', function () {
            var producer = el('ca-producer').value.trim();
            var name = el('ca-name').value.trim();
            if (!producer && !name) { alert('Enter at least a producer or a wine name.'); return; }

            var vintageRaw = el('ca-vintage').value.trim();
            var qty = Math.max(1, parseInt(el('ca-qty').value, 10) || 1);
            var sizeMl = parseInt(el('ca-size').value, 10) || 750;
            var wineId = model.newId();

            var wine = {
                id: wineId,
                producer: producer,
                name: name,
                vintage: /^\d{4}$/.test(vintageRaw) ? parseInt(vintageRaw, 10) : null,
                nv: !vintageRaw || /^nv$/i.test(vintageRaw),
                color: el('ca-color').value,
                varietals: el('ca-varietals').value.split(/[,;/]+/)
                    .map(function (s) { return s.trim(); }).filter(Boolean),
                region: el('ca-region').value.trim(),
                appellation: '',
                country: el('ca-country').value.trim(),
                abv: null,
                sizeMl: sizeMl,
                drinkFrom: parseInt(el('ca-from').value, 10) || null,
                drinkTo: parseInt(el('ca-to').value, 10) || null,
                notes: el('ca-notes').value.trim(),
                externalUrl: ''
            };

            var common = {
                fridgeId: el('ca-fridge').value || null,
                shelf: parseInt(el('ca-shelf').value, 10) || null,
                acquiredFrom: el('ca-vendor').value.trim(),
                acquiredAt: el('ca-date').value || null,
                costCents: model.parseMoneyCents(el('ca-price').value),
                sizeMl: sizeMl
            };

            var bottles = [];
            for (var i = 0; i < qty; i++) bottles.push(newBottleRecord(wineId, common));
            if (pendingCode) bottles[0].code = pendingCode;

            enqueue(model.makeOp('ADD_WINE', { wine: wine }, app.device));
            enqueue(model.makeOp('ADD_BOTTLES', { bottles: bottles }, app.device));

            // Arm the labelling session so the next N scans are one tap each.
            var needLabels = bottles.filter(function (b) { return !b.code; }).length;
            if (needLabels) {
                lsSet(K.assign, { wineId: wineId, total: qty, startedAt: model.nowIso() });
                toast('Added ' + qty + ' bottle(s). Scan a label on each one.');
            } else {
                toast('Added.');
            }
            go('#/wine/' + encodeURIComponent(wineId));
        });
    }

    /* -- wine detail -------------------------------------------------- */

    function renderWine(main, id) {
        var w = model.wineById(app.state, id);
        if (!w) { main.innerHTML = backLink('#/', 'All fridges') +
            '<div class="cellar-empty">Wine not found.</div>'; return; }

        var live = (app.state.bottles.bottles || []).filter(function (b) { return b.wineId === id; });
        var gone = (app.state.archive.entries || []).filter(function (e) { return e.wineId === id; });
        var spend = live.concat(gone).reduce(function (a, x) {
            return a + (x.costCents || 0);
        }, 0);
        var rated = gone.filter(function (e) { return e.rating != null; });

        var html = backLink('#/', 'All fridges') +
            '<h2>' + esc(model.wineLabel(w)) + '</h2>' +
            '<div class="cellar-card"><div class="cellar-card-body"><ul class="cellar-facts">';
        if (w.varietals && w.varietals.length) html += fact('Varietals', w.varietals.join(', '));
        if (w.region)      html += fact('Region', w.region);
        if (w.appellation) html += fact('Appellation', w.appellation);
        if (w.country)     html += fact('Country', w.country);
        if (windowText(w)) html += fact('Drink window', windowText(w));
        html += fact('Bottles bought', String(live.length + gone.length));
        html += fact('Remaining', String(live.length));
        if (spend) html += fact('Total spend', model.formatMoney(spend, app.state.config.currency));
        if (rated.length) {
            var avg = rated.reduce(function (a, e) { return a + e.rating; }, 0) / rated.length;
            html += fact('Average rating', avg.toFixed(1) + ' / 5');
        }
        if (w.notes) html += fact('Notes', w.notes);
        html += '</ul></div></div>';

        if (live.length) {
            html += '<h3>In the cellar</h3><div class="cellar-card">' + bottleListHtml(live) + '</div>';
            html += '<button class="cellar-btn cellar-btn-block" id="cw-moveall">' +
                    '<i class="fa fa-arrows-up-down-left-right"></i> Move all ' + live.length + ' bottles</button>';
        }
        if (gone.length) {
            html += '<h3>Archive</h3><div class="cellar-card"><ul class="cellar-list">' +
                gone.map(function (e) {
                    return '<li><a href="#/archive/' + encodeURIComponent(e.id) + '">' +
                        '<span class="cellar-list-main"><span class="cellar-list-title">' +
                        esc((e.occurredAt || '').slice(0, 10)) + ' · ' + esc(e.disposition) + '</span>' +
                        '<span class="cellar-list-sub">' +
                        (e.rating ? stars(e.rating) + ' ' : '') +
                        esc((e.notes || []).map(function (n) { return n.text; }).join(' | ').slice(0, 60)) +
                        '</span></span></a></li>';
                }).join('') + '</ul></div>';
        }

        main.innerHTML = html;

        var mv = el('cw-moveall');
        if (mv) mv.addEventListener('click', function () {
            // Reuse the single-bottle picker, then apply to every bottle.
            openMove(live[0], function () {
                var moved = model.index(app.state.bottles.bottles, 'id')[live[0].id];
                live.slice(1).forEach(function (b) {
                    enqueue(model.makeOp('MOVE_BOTTLE', {
                        bottleId: b.id, fridgeId: moved.fridgeId, shelf: moved.shelf, slot: b.slot || ''
                    }, app.device));
                });
                render();
            });
        });
    }

    function stars(n) {
        var s = '';
        for (var i = 1; i <= 5; i++) s += i <= n ? '★' : '☆';
        return '<span class="cellar-stars">' + s + '</span>';
    }

    /* -- archive ------------------------------------------------------ */

    function renderArchive(main) {
        var entries = (app.state.archive.entries || []).slice().sort(function (a, b) {
            return String(b.occurredAt).localeCompare(String(a.occurredAt));
        });
        if (!entries.length) {
            main.innerHTML = backLink('#/', 'All fridges') + '<h2>Archive</h2>' +
                '<div class="cellar-empty"><i class="fa fa-clock-rotate-left"></i>Nothing archived yet.</div>';
            return;
        }
        main.innerHTML = backLink('#/', 'All fridges') + '<h2>Archive</h2>' +
            '<div class="cellar-card"><ul class="cellar-list">' +
            entries.map(function (e) {
                var s = e.wineSnapshot || {};
                var note = (e.notes || []).map(function (n) { return n.text; }).join(' | ');
                return '<li><a href="#/archive/' + encodeURIComponent(e.id) + '">' +
                    '<span class="cellar-chip cellar-chip-' + esc(s.color || 'other') + '"></span>' +
                    '<span class="cellar-list-main">' +
                    '<span class="cellar-list-title">' +
                    esc([s.producer, s.name].filter(Boolean).join(' ') + ' ' + (s.vintage || '')) + '</span>' +
                    '<span class="cellar-list-sub">' + esc((e.occurredAt || '').slice(0, 10)) +
                    ' · ' + esc(e.disposition || '') +
                    (e.rating ? ' · ' + stars(e.rating) : '') +
                    (note ? ' · ' + esc(note.slice(0, 40)) : '') + '</span></span></a></li>';
            }).join('') + '</ul></div>';
    }

    function renderArchiveDetail(main, id, append) {
        var e = model.index(app.state.archive.entries, 'id')[id];
        if (!e) {
            if (!append) main.innerHTML = backLink('#/archive', 'Archive') +
                '<div class="cellar-empty">Entry not found.</div>';
            return;
        }
        var s = e.wineSnapshot || {};
        var html =
            '<div class="cellar-card"><div class="cellar-hero">' +
            '<div class="cellar-hero-producer">' + esc(s.producer || '') + '</div>' +
            (s.name && s.name !== s.producer ? '<div class="cellar-hero-name">' + esc(s.name) + '</div>' : '') +
            '<div class="cellar-hero-vintage">' + esc(s.vintage || 'NV') + '</div>' +
            '<div class="cellar-hero-meta">' + esc(e.disposition) + ' on ' +
            esc((e.occurredAt || '').slice(0, 10)) + '</div>' +
            (e.rating ? '<div style="margin-top:0.4em;font-size:1.3em;">' + stars(e.rating) + '</div>' : '') +
            '</div>' +
            '<div class="cellar-card-body"><ul class="cellar-facts">' +
            (e.code ? fact('Label', '<span class="cellar-code">' + esc(e.code) + '</span>', true) : '') +
            (e.acquiredFrom ? fact('Bought from', e.acquiredFrom) : '') +
            (e.costCents != null ? fact('Price', model.formatMoney(e.costCents, e.currency)) : '') +
            '</ul></div></div>';

        html += '<div class="cellar-card"><div class="cellar-card-head">' +
            '<i class="fa fa-pen-to-square"></i><h3>Tasting notes</h3></div>' +
            '<div class="cellar-card-body">';
        if ((e.notes || []).length) {
            html += e.notes.slice().sort(function (a, b) {
                return String(a.at).localeCompare(String(b.at));
            }).map(function (n) {
                return '<div class="cellar-note"><div class="cellar-note-meta">' +
                    esc((n.at || '').slice(0, 10)) + (n.author ? ' · ' + esc(n.author) : '') +
                    '</div><div class="cellar-note-text">' + esc(n.text) + '</div></div>';
            }).join('');
        } else {
            html += '<p class="cellar-muted">No notes yet — add one any time.</p>';
        }
        html += '<div class="cellar-field" style="margin-top:0.8em;"><label>Add a note</label>' +
            '<textarea id="cn-text" placeholder="How was it?"></textarea></div>' +
            '<div class="cellar-field"><label>Rating</label><div class="cellar-segments" id="cn-rating">' +
            [1, 2, 3, 4, 5].map(function (n) {
                return '<button class="cellar-segment' + (e.rating === n ? ' cellar-segment-on' : '') +
                       '" data-r="' + n + '">' + n + '</button>';
            }).join('') + '</div></div>' +
            '<button class="cellar-btn cellar-btn-primary cellar-btn-block" id="cn-save">Save note</button>' +
            '<button class="cellar-btn cellar-btn-sm" id="cn-restore">' +
            '<i class="fa fa-rotate-left"></i> Put back in the cellar</button>' +
            '</div></div>' + backLink('#/archive', 'Archive');

        if (append) main.innerHTML += html; else main.innerHTML = html;

        var rating = e.rating || null;
        document.querySelectorAll('#cn-rating [data-r]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                rating = Number(btn.getAttribute('data-r'));
                document.querySelectorAll('#cn-rating [data-r]').forEach(function (b2) {
                    b2.className = 'cellar-segment' +
                        (Number(b2.getAttribute('data-r')) === rating ? ' cellar-segment-on' : '');
                });
            });
        });
        el('cn-save').addEventListener('click', function () {
            var text = el('cn-text').value.trim();
            if (!text && rating === e.rating) { alert('Write a note or change the rating first.'); return; }
            enqueue(model.makeOp('ADD_ARCHIVE_NOTE', {
                archiveId: id, noteId: model.newId(),
                text: text || '(rating updated)', at: model.nowIso(), rating: rating
            }, app.device));
            render();
        });
        el('cn-restore').addEventListener('click', function () {
            enqueue(model.makeOp('RESTORE_BOTTLE', { archiveId: id }, app.device));
            toast('Back in the cellar.');
            go('#/');
        });
    }

    /* -- search ------------------------------------------------------- */

    function renderSearch(main) {
        var initial = sessionStorage.getItem('cellar.q') || '';
        sessionStorage.removeItem('cellar.q');
        main.innerHTML = backLink('#/', 'All fridges') + '<h2>Search</h2>' +
            '<div class="cellar-field"><input id="cs-q" type="search" value="' + esc(initial) + '" ' +
            'placeholder="producer, wine, varietal, region, vintage, code" autocomplete="off"></div>' +
            '<div class="cellar-segments" id="cs-filters">' +
            ['all'].concat(model.COLORS).map(function (c) {
                return '<button class="cellar-segment' + (c === 'all' ? ' cellar-segment-on' : '') +
                       '" data-c="' + c + '">' + c + '</button>';
            }).join('') +
            '<button class="cellar-segment" data-c="ready">ready now</button>' +
            '<button class="cellar-segment" data-c="unlabeled">unlabeled</button>' +
            '</div><div id="cs-results" style="margin-top:1em;"></div>';

        var filter = 'all';
        function run() {
            var q = el('cs-q').value.trim().toLowerCase();
            var year = new Date().getFullYear();
            var list = (app.state.bottles.bottles || []).filter(function (b) {
                var w = model.wineById(app.state, b.wineId) || {};
                if (filter === 'ready' && model.drinkWindowState(w, year) !== 'ready') return false;
                else if (filter === 'unlabeled' && b.code) return false;
                else if (filter !== 'all' && filter !== 'ready' && filter !== 'unlabeled' &&
                         (w.color || 'other') !== filter) return false;
                if (!q) return true;
                var hay = [w.producer, w.name, w.region, w.appellation, w.country,
                           (w.varietals || []).join(' '), w.vintage, b.code]
                          .filter(Boolean).join(' ').toLowerCase();
                return hay.indexOf(q) !== -1;
            });
            el('cs-results').innerHTML = list.length
                ? '<p class="cellar-muted">' + list.length + ' bottle(s)</p>' +
                  '<div class="cellar-card">' + bottleListHtml(list) + '</div>'
                : '<div class="cellar-empty"><i class="fa fa-magnifying-glass"></i>No matches.</div>';
        }

        el('cs-q').addEventListener('input', run);
        document.querySelectorAll('#cs-filters [data-c]').forEach(function (btn) {
            btn.addEventListener('click', function () {
                filter = btn.getAttribute('data-c');
                document.querySelectorAll('#cs-filters [data-c]').forEach(function (b2) {
                    b2.className = 'cellar-segment' +
                        (b2.getAttribute('data-c') === filter ? ' cellar-segment-on' : '');
                });
                run();
            });
        });
        run();
        el('cs-q').focus();
    }

    /* -- tonight ------------------------------------------------------ */

    function renderTonight(main) {
        var year = new Date().getFullYear();
        // Inside the window, closest to the end of it first — the bottles that
        // will stop being good soonest.
        var ready = (app.state.bottles.bottles || []).map(function (b) {
            var w = model.wineById(app.state, b.wineId) || {};
            return { b: b, w: w, state: model.drinkWindowState(w, year) };
        }).filter(function (r) { return r.state === 'ready'; })
          .sort(function (x, y) {
              var xa = x.w.drinkTo == null ? 9999 : x.w.drinkTo;
              var ya = y.w.drinkTo == null ? 9999 : y.w.drinkTo;
              return xa - ya;
          });

        var past = (app.state.bottles.bottles || []).filter(function (b) {
            return model.drinkWindowState(model.wineById(app.state, b.wineId), year) === 'past';
        });

        var html = backLink('#/', 'All fridges') + '<h2>What to drink tonight</h2>';
        if (past.length) {
            html += '<div class="cellar-banner cellar-banner-warn">' + past.length +
                    ' bottle(s) are past their drink window. ' +
                    '<a href="#/search">Review them</a></div>';
        }
        html += ready.length
            ? '<p class="cellar-muted">' + ready.length +
              ' bottle(s) are in their window, soonest to close first.</p>' +
              '<div class="cellar-card">' + bottleListHtml(ready.map(function (r) { return r.b; })) + '</div>'
            : '<div class="cellar-empty"><i class="fa fa-glass-cheers"></i>' +
              'Nothing is flagged as ready. Add drink-window years to your wines to use this.</div>';
        main.innerHTML = html;
    }

    /* -- stats -------------------------------------------------------- */

    function renderStats(main) {
        var st = model.stats(app.state);
        function bars(obj, limit) {
            var pairs = Object.keys(obj).map(function (k) { return [k, obj[k]]; })
                .sort(function (a, b) { return b[1] - a[1]; }).slice(0, limit || 10);
            var max = pairs.length ? pairs[0][1] : 1;
            return '<ul class="cellar-bars">' + pairs.map(function (p) {
                return '<li><span class="cellar-bars-label">' + esc(p[0]) + '</span>' +
                    '<span class="cellar-bars-track"><span class="cellar-bars-fill" style="width:' +
                    Math.round((p[1] / max) * 100) + '%;"></span></span>' +
                    '<span class="cellar-bars-num">' + p[1] + '</span></li>';
            }).join('') + '</ul>';
        }

        var fridgeCounts = {};
        Object.keys(st.byFridge).forEach(function (fid) {
            var f = model.fridgeById(app.state, fid);
            fridgeCounts[f ? f.name : 'Unassigned'] = st.byFridge[fid];
        });

        main.innerHTML = backLink('#/', 'All fridges') + '<h2>Stats</h2>' +
            '<div class="cellar-stat-grid">' +
            statTile(st.liveCount, 'in cellar') +
            statTile(st.archivedCount, 'archived') +
            statTile(model.formatMoney(st.valueCents, app.state.config.currency) || '—', 'cellar value') +
            statTile(st.avgRating ? st.avgRating.toFixed(1) : '—', 'avg rating') +
            '</div>' +
            '<h3>By fridge</h3>' + bars(fridgeCounts) +
            '<h3>By color</h3>' + bars(st.byColor) +
            '<h3>By region</h3>' + bars(st.byRegion, 12) +
            '<h3>By vintage</h3>' + bars(st.byVintage, 15) +
            '<h3>Bottles drunk per month</h3>' +
            (Object.keys(st.byMonth).length ? bars(st.byMonth, 18)
                : '<p class="cellar-muted">Nothing logged yet.</p>') +
            (st.pricedCount < st.liveCount
                ? '<p class="cellar-muted" style="margin-top:1em;">Cellar value covers the ' +
                  st.pricedCount + ' of ' + st.liveCount + ' bottles that have a price recorded.</p>'
                : '');
    }

    function statTile(num, label) {
        return '<div class="cellar-stat"><div class="cellar-stat-num">' + esc(num) + '</div>' +
               '<div class="cellar-stat-lbl">' + esc(label) + '</div></div>';
    }

    /* -- import ------------------------------------------------------- */

    function renderImport(main) {
        main.innerHTML = backLink('#/settings', 'Settings') + '<h2>Import CSV</h2>' +
            '<div class="cellar-card"><div class="cellar-card-body">' +
            '<p class="cellar-muted">Paste a CSV export (CellarTracker, Vivino, or your own ' +
            'spreadsheet). A <strong>quantity</strong> column becomes that many individual bottles.</p>' +
            '<div class="cellar-field"><label>CSV file</label><input type="file" id="ci-file" accept=".csv,text/csv"></div>' +
            '<div class="cellar-field"><label>…or paste it</label>' +
            '<textarea id="ci-text" placeholder="Producer,Wine,Vintage,Quantity,Price"></textarea></div>' +
            '<button class="cellar-btn cellar-btn-block" id="ci-parse">Parse</button>' +
            '</div></div><div id="ci-stage"></div>';

        el('ci-file').addEventListener('change', function (e) {
            var f = e.target.files[0];
            if (!f) return;
            var r = new FileReader();
            r.onload = function () { el('ci-text').value = r.result; stage(); };
            r.readAsText(f);
        });
        el('ci-parse').addEventListener('click', stage);

        function parseCsv(text) {
            // Small hand-rolled RFC4180 parser — avoids pulling a CDN dependency
            // onto a page that also holds the token.
            var rows = [], row = [], field = '', q = false;
            for (var i = 0; i < text.length; i++) {
                var c = text[i];
                if (q) {
                    if (c === '"') {
                        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
                    } else field += c;
                } else if (c === '"') q = true;
                else if (c === ',') { row.push(field); field = ''; }
                else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
                else if (c !== '\r') field += c;
            }
            if (field !== '' || row.length) { row.push(field); rows.push(row); }
            return rows.filter(function (r) { return r.some(function (c) { return c.trim() !== ''; }); });
        }

        function stage() {
            var rows = parseCsv(el('ci-text').value);
            if (rows.length < 2) { alert('Need a header row and at least one data row.'); return; }
            var headers = rows[0].map(function (h) { return h.trim(); });
            var objs = rows.slice(1).map(function (r) {
                var o = {};
                headers.forEach(function (h, i) { o[h] = r[i]; });
                return o;
            });
            var mapping = model.guessMapping(headers);

            var opts = '<option value="">— ignore —</option>' + model.IMPORT_FIELDS.map(function (f) {
                return '<option value="' + f.key + '">' + esc(f.label) + '</option>';
            }).join('');

            el('ci-stage').innerHTML =
                '<div class="cellar-card"><div class="cellar-card-head">' +
                '<i class="fa fa-table-columns"></i><h3>Map columns</h3></div>' +
                '<div class="cellar-card-body"><div class="cellar-table-wrap"><table class="cellar-table">' +
                '<tr><th>CSV column</th><th>Maps to</th><th>First value</th></tr>' +
                headers.map(function (h, i) {
                    return '<tr><td>' + esc(h) + '</td><td>' +
                        '<select data-h="' + esc(h) + '">' + opts + '</select></td>' +
                        '<td class="cellar-muted">' + esc(String(objs[0][h] || '').slice(0, 30)) + '</td></tr>';
                }).join('') + '</table></div>' +
                '<p class="cellar-muted" style="margin-top:0.8em;">' + objs.length + ' data row(s).</p>' +
                '<button class="cellar-btn cellar-btn-primary cellar-btn-block" id="ci-go">Preview import</button>' +
                '</div></div><div id="ci-preview"></div>';

            document.querySelectorAll('#ci-stage select[data-h]').forEach(function (sel) {
                sel.value = mapping[sel.getAttribute('data-h')] || '';
                sel.addEventListener('change', function () {
                    mapping[sel.getAttribute('data-h')] = sel.value || null;
                });
            });

            el('ci-go').addEventListener('click', function () {
                var clean = {};
                Object.keys(mapping).forEach(function (k) { if (mapping[k]) clean[k] = mapping[k]; });
                var out = model.buildImport(objs, clean, {
                    currency: app.state.config.currency,
                    defaults: {}
                });
                el('ci-preview').innerHTML =
                    '<div class="cellar-card"><div class="cellar-card-body">' +
                    '<p><strong>' + out.wines.length + '</strong> wines, <strong>' +
                    out.bottles.length + '</strong> bottles' +
                    (out.skipped ? ', ' + out.skipped + ' row(s) skipped (no producer or name)' : '') + '.</p>' +
                    '<ul class="cellar-list">' + out.wines.slice(0, 5).map(function (w) {
                        var n = out.bottles.filter(function (b) { return b.wineId === w.id; }).length;
                        return '<li><a href="#"><span class="cellar-chip ' + colorClass(w) + '"></span>' +
                            '<span class="cellar-list-main"><span class="cellar-list-title">' +
                            esc(model.wineLabel(w)) + '</span><span class="cellar-list-sub">' +
                            n + ' bottle(s)</span></span></a></li>';
                    }).join('') + '</ul>' +
                    (out.wines.length > 5 ? '<p class="cellar-muted">…and ' + (out.wines.length - 5) + ' more.</p>' : '') +
                    '<button class="cellar-btn cellar-btn-primary cellar-btn-block" id="ci-commit">' +
                    'Import ' + out.bottles.length + ' bottles</button>' +
                    '<p class="cellar-field-hint">Imported bottles have no label yet. ' +
                    'Stick labels on and scan them whenever you like.</p>' +
                    '</div></div>';

                el('ci-commit').addEventListener('click', function () {
                    out.wines.forEach(function (w) {
                        enqueue(model.makeOp('ADD_WINE', { wine: w }, app.device));
                    });
                    // Chunked so one op does not carry a 600-element payload.
                    for (var i = 0; i < out.bottles.length; i += 50) {
                        enqueue(model.makeOp('ADD_BOTTLES',
                            { bottles: out.bottles.slice(i, i + 50) }, app.device));
                    }
                    toast('Imported ' + out.bottles.length + ' bottles.');
                    go('#/');
                });
            });
        }
    }

    /* -- settings ----------------------------------------------------- */

    function renderSettings(main) {
        var cfg = app.cfg;
        var expiryWarn = '';
        if (app.tokenExpiresAt) {
            var days = Math.round((new Date(app.tokenExpiresAt) - Date.now()) / 86400000);
            if (days < 21) {
                expiryWarn = '<div class="cellar-banner cellar-banner-warn">This access token ' +
                    (days < 0 ? 'has expired.' : 'expires in ' + days + ' day(s).') +
                    ' Generate a new one on GitHub and paste it below.</div>';
            }
        }

        var html = backLink('#/', 'All fridges') + '<h2>Settings</h2>' + expiryWarn;

        html += '<div class="cellar-card"><div class="cellar-card-head">' +
            '<i class="fa fa-database"></i><h3>Data store</h3></div><div class="cellar-card-body">' +
            '<div class="cellar-field"><label>Backend</label><select id="cf-kind">' +
            ['github', 'local', 'memory'].map(function (k) {
                return '<option value="' + k + '"' + (app.storeKind === k ? ' selected' : '') + '>' +
                    ({ github: 'Private GitHub repo', local: 'Local server (Mac / Pi)',
                       memory: 'Demo — nothing is saved' })[k] + '</option>';
            }).join('') + '</select></div>' +
            '<div id="cf-github">' +
            '<div class="cellar-field-row">' +
            '<div class="cellar-field"><label>Owner</label><input id="cf-owner" value="' + esc(cfg.owner || '') + '"></div>' +
            '<div class="cellar-field"><label>Repo</label><input id="cf-repo" value="' + esc(cfg.repo || '') + '"></div></div>' +
            '<div class="cellar-field-row">' +
            '<div class="cellar-field"><label>Branch</label><input id="cf-branch" value="' + esc(cfg.branch || 'main') + '"></div>' +
            '<div class="cellar-field"><label>Path</label><input id="cf-path" value="' + esc(cfg.basePath || 'data') + '"></div></div>' +
            '<div class="cellar-field"><label>Access token</label>' +
            '<input id="cf-token" type="password" autocomplete="off" value="' + esc(cfg.token || '') + '">' +
            '<div class="cellar-field-hint">Fine-grained token, this repo only, ' +
            '<strong>Contents: Read and write</strong>. It is stored only in this browser.</div></div>' +
            '</div>' +
            '<div id="cf-local" class="cellar-hidden"><div class="cellar-field"><label>Base URL</label>' +
            '<input id="cf-base" value="' + esc(cfg.baseUrl || '') + '" placeholder="https://cellar.local:8443"></div></div>' +
            '<div class="cellar-field"><label>This device is called</label>' +
            '<input id="cf-device" value="' + esc(app.device) + '" placeholder="brian-iphone">' +
            '<div class="cellar-field-hint">Shows up in the change history.</div></div>' +
            '<div class="cellar-actions-row">' +
            '<button class="cellar-btn cellar-btn-primary" id="cf-save">Save</button>' +
            '<button class="cellar-btn" id="cf-verify">Verify</button></div>' +
            '<div id="cf-verify-out"></div>' +
            '</div></div>';

        if (app.state) {
            html += '<div class="cellar-card"><div class="cellar-card-head">' +
                '<i class="fa fa-snowflake"></i><h3>Fridges &amp; shelves</h3></div>' +
                '<div class="cellar-card-body" id="cf-fridges"></div></div>';

            html += '<div class="cellar-card"><div class="cellar-card-head">' +
                '<i class="fa fa-list-check"></i><h3>Pending changes</h3></div>' +
                '<div class="cellar-card-body" id="cf-queue"></div></div>';

            html += '<div class="cellar-card"><div class="cellar-card-head">' +
                '<i class="fa fa-download"></i><h3>Data</h3></div><div class="cellar-card-body">' +
                '<div class="cellar-actions-row">' +
                '<button class="cellar-btn" id="cf-export-json">Export JSON</button>' +
                '<button class="cellar-btn" id="cf-export-csv">Export CSV</button></div>' +
                '<a class="cellar-btn cellar-btn-block" href="#/import" style="margin-top:0.6em;">Import CSV</a>' +
                '<a class="cellar-btn cellar-btn-block" href="labels.html">Print QR labels</a>' +
                '<button class="cellar-btn cellar-btn-sm cellar-btn-danger cellar-btn-block" ' +
                'id="cf-clear" style="margin-top:0.6em;">Clear this device\'s cache</button>' +
                '<p class="cellar-field-hint">Clearing the cache keeps your token and any ' +
                'unsynced changes. Your data lives in the repo — every change is a commit.</p>' +
                '</div></div>';
        }

        main.innerHTML = html;

        function syncKindFields() {
            var kind = el('cf-kind').value;
            el('cf-github').className = kind === 'github' ? '' : 'cellar-hidden';
            el('cf-local').className = kind === 'local' ? '' : 'cellar-hidden';
        }
        el('cf-kind').addEventListener('change', syncKindFields);
        syncKindFields();

        el('cf-save').addEventListener('click', function () {
            var kind = el('cf-kind').value;
            var next = {
                owner: el('cf-owner').value.trim(),
                repo: el('cf-repo').value.trim(),
                branch: el('cf-branch').value.trim() || 'main',
                basePath: el('cf-path').value.trim() || 'data',
                baseUrl: el('cf-base').value.trim(),
                token: el('cf-token').value.trim()
            };
            app.device = el('cf-device').value.trim();
            lsSet(K.device, app.device);
            // The token is stored apart from the rest so "forget token" is a
            // single key delete and never takes the repo config with it.
            lsSet(K.token, next.token);
            var store = { kind: kind, owner: next.owner, repo: next.repo,
                          branch: next.branch, basePath: next.basePath, baseUrl: next.baseUrl };
            lsSet(K.storecfg, store);
            app.cfg = next;
            app.storeKind = kind;
            app.store = stores.create(kind, next);
            toast('Saved.');
            loadAll();
        });

        el('cf-verify').addEventListener('click', function () {
            var out = el('cf-verify-out');
            out.innerHTML = '<p class="cellar-muted">Checking…</p>';
            var probe = stores.create(el('cf-kind').value, {
                owner: el('cf-owner').value.trim(), repo: el('cf-repo').value.trim(),
                branch: el('cf-branch').value.trim() || 'main',
                basePath: el('cf-path').value.trim() || 'data',
                baseUrl: el('cf-base').value.trim(), token: el('cf-token').value.trim()
            });
            probe.verify().then(function (r) {
                out.innerHTML = '<div class="cellar-banner ' +
                    (r.ok ? 'cellar-banner-info' : 'cellar-banner-error') + '">' + esc(r.detail) +
                    (r.expiresAt ? '<br>Token expires ' + esc(String(r.expiresAt)) : '') + '</div>';
            });
        });

        if (app.state) {
            renderFridgeEditor();
            renderQueueInspector();
            el('cf-export-json').addEventListener('click', function () {
                download('cellar-' + new Date().toISOString().slice(0, 10) + '.json',
                    JSON.stringify(app.state, null, 2), 'application/json');
            });
            el('cf-export-csv').addEventListener('click', function () {
                download('cellar-' + new Date().toISOString().slice(0, 10) + '.csv',
                    model.exportCsv(app.state), 'text/csv');
            });
            el('cf-clear').addEventListener('click', function () {
                if (!confirm('Clear the cached copy on this device? Your data stays in the repo.')) return;
                lsDel(K.cache);
                location.reload();
            });
        }
    }

    function renderFridgeEditor() {
        var host = el('cf-fridges');
        if (!host) return;
        var fridges = (app.state.config.fridges || []).slice()
            .sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });

        host.innerHTML = fridges.map(function (f, i) {
            return '<div class="cellar-field-row" data-f="' + esc(f.id) + '">' +
                '<div class="cellar-field"><label>Name</label>' +
                '<input class="cf-fname" value="' + esc(f.name) + '"></div>' +
                '<div class="cellar-field"><label>Shelves</label>' +
                '<input class="cf-fshelves" inputmode="numeric" value="' + (f.shelfCount || 1) + '"></div>' +
                '</div>';
        }).join('') +
        '<div class="cellar-actions-row">' +
        '<button class="cellar-btn cellar-btn-sm" id="cf-fadd">Add fridge</button>' +
        '<button class="cellar-btn cellar-btn-sm cellar-btn-primary" id="cf-fsave">Save fridges</button></div>' +
        (fridges.length ? '' : '<p class="cellar-field-hint">Add your four fridges here first — ' +
            'everything else needs somewhere to put a bottle.</p>');

        el('cf-fadd').addEventListener('click', function () {
            var next = (app.state.config.fridges || []).slice();
            next.push(model.newFridge('Fridge ' + (next.length + 1), 6, next.length + 1));
            enqueue(model.makeOp('SET_CONFIG', { fridges: next }, app.device));
            renderFridgeEditor();
        });

        el('cf-fsave').addEventListener('click', function () {
            var next = [];
            host.querySelectorAll('[data-f]').forEach(function (rowEl, i) {
                var id = rowEl.getAttribute('data-f');
                var orig = model.fridgeById(app.state, id) || {};
                next.push(Object.assign({}, orig, {
                    id: id,
                    name: rowEl.querySelector('.cf-fname').value.trim() || 'Fridge',
                    shelfCount: Math.max(1, parseInt(rowEl.querySelector('.cf-fshelves').value, 10) || 1),
                    sortOrder: i + 1,
                    active: true
                }));
            });
            enqueue(model.makeOp('SET_CONFIG', { fridges: next }, app.device));
            toast('Fridges saved.');
            renderFridgeEditor();
        });
    }

    function renderQueueInspector() {
        var host = el('cf-queue');
        if (!host) return;
        if (!app.queue.length) {
            host.innerHTML = '<p class="cellar-muted">Everything is synced.</p>' +
                (app.lastError ? '<p class="cellar-muted">Last error: ' + esc(app.lastError) + '</p>' : '');
            return;
        }
        host.innerHTML = '<ul class="cellar-list">' + app.queue.map(function (op) {
            return '<li><a href="#" data-op="' + esc(op.opId) + '">' +
                '<span class="cellar-list-main"><span class="cellar-list-title">' + esc(op.type) + '</span>' +
                '<span class="cellar-list-sub">' + esc(op.ts) + '</span></span>' +
                '<span class="cellar-muted"><i class="fa fa-trash"></i></span></a></li>';
        }).join('') + '</ul>' +
        '<button class="cellar-btn cellar-btn-block" id="cf-forcesync" style="margin-top:0.7em;">' +
        'Sync now</button>' +
        (app.lastError ? '<p class="cellar-muted">Last error: ' + esc(app.lastError) + '</p>' : '');

        host.querySelectorAll('[data-op]').forEach(function (a) {
            a.addEventListener('click', function (e) {
                e.preventDefault();
                if (!confirm('Discard this pending change? It has not been saved to the repo.')) return;
                var id = a.getAttribute('data-op');
                app.queue = app.queue.filter(function (o) { return o.opId !== id; });
                recompute(); persistLocal(); renderQueueInspector(); renderSyncPill();
            });
        });
        el('cf-forcesync').addEventListener('click', function () {
            flush().then(function () { renderQueueInspector(); });
        });
    }

    function download(filename, text, mime) {
        var blob = new Blob([text], { type: mime + ';charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    }

    /* -- token handoff ------------------------------------------------ */

    function consumeTokenHandoff(token) {
        if (token) {
            lsSet(K.token, decodeURIComponent(token));
            app.cfg.token = decodeURIComponent(token);
            app.store = stores.create(app.storeKind, app.cfg);
        }
        // Strip it from the URL and from session history immediately.
        history.replaceState(null, '', location.pathname + location.search + '#/settings');
        toast('Token stored on this device.');
        loadAll();
    }

    /* -- modal / toast ------------------------------------------------ */

    function modal(title, html, bind) {
        closeModal();
        var wrap = document.createElement('div');
        wrap.id = 'cellar-modal';
        wrap.className = 'cellar-modal-wrap';
        wrap.innerHTML = '<div class="cellar-modal"><div class="cellar-card-head">' +
            '<h3>' + esc(title) + '</h3>' +
            '<button class="cellar-btn cellar-btn-sm" id="cellar-modal-x">' +
            '<i class="fa fa-xmark"></i></button></div>' +
            '<div class="cellar-card-body" id="cellar-modal-body"></div></div>';
        document.body.appendChild(wrap);
        var body = wrap.querySelector('#cellar-modal-body');
        body.innerHTML = html;
        wrap.querySelector('#cellar-modal-x').addEventListener('click', closeModal);
        wrap.addEventListener('click', function (e) { if (e.target === wrap) closeModal(); });
        if (bind) bind(body);
    }

    function closeModal() {
        var m = el('cellar-modal');
        if (m) m.parentNode.removeChild(m);
    }

    var toastTimer = null;
    function toast(text, actionLabel, action) {
        var old = el('cellar-toast');
        if (old) old.parentNode.removeChild(old);
        clearTimeout(toastTimer);

        var t = document.createElement('div');
        t.id = 'cellar-toast';
        t.className = 'cellar-toast';
        t.innerHTML = '<span>' + esc(text) + '</span>';
        if (actionLabel) {
            var btn = document.createElement('button');
            btn.textContent = actionLabel;
            btn.addEventListener('click', function () {
                clearTimeout(toastTimer);
                t.parentNode && t.parentNode.removeChild(t);
                action();
            });
            t.appendChild(btn);
        }
        document.body.appendChild(t);
        toastTimer = setTimeout(function () {
            if (t.parentNode) t.parentNode.removeChild(t);
        }, actionLabel ? 10000 : 3200);   // 10s undo window
    }

    /* ------------------------------------------------------------ boot */

    function boot() {
        if (app.booted) return;
        app.booted = true;

        var params = new URLSearchParams(location.search);
        var stored = lsGet(K.storecfg, {});
        var forced = params.get('store');

        app.device = lsGet(K.device, '') || '';
        app.storeKind = forced || stored.kind || 'github';
        app.cfg = {
            owner: stored.owner || '',
            repo: stored.repo || '',
            branch: stored.branch || 'main',
            basePath: stored.basePath || 'data',
            baseUrl: stored.baseUrl || '',
            token: lsGet(K.token, '') || ''
        };

        app.queue = lsGet(K.queue, []) || [];
        model.restoreOpCounters(app.queue);

        var cached = lsGet(K.cache, null);
        app.base = (cached && cached.base) || model.emptyState();
        app.revs = (cached && cached.revs) || {};
        recompute();

        if (app.storeKind === 'memory') {
            app.store = stores.create('memory', { seed: demoSeed(), latencyMs: 150 });
        } else {
            app.store = stores.create(app.storeKind, app.cfg);
        }

        // Render immediately from the cache — synchronous, no await, so the page
        // is usable before any network call resolves.
        render();
        renderSyncPill();

        window.addEventListener('hashchange', function () { closeModal(); render(); });
        window.addEventListener('online', function () { setSync('idle'); scheduleFlush(100); });
        window.addEventListener('offline', function () { setSync('offline'); });
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') { scheduleFlush(100); pullIfChanged(); }
        });
        var pill = el('cellar-sync');
        if (pill) pill.addEventListener('click', function () {
            if (app.queue.length) flush(); else loadAll();
        });

        loadAll();
        app.pollTimer = setInterval(function () {
            if (document.visibilityState === 'visible') pullIfChanged();
        }, 90000);
        setInterval(renderSyncPill, 30000);
    }

    // Seed for ?store=memory so the UI can be developed with no repo and no token.
    function demoSeed() {
        var s = model.emptyState();
        var ts = model.nowIso();
        s.config.fridges = [
            { id: 'F1', name: 'Kitchen', shelfCount: 5, shelfLabels: null,
              capacityPerShelf: 12, sortOrder: 1, active: true },
            { id: 'F2', name: 'Basement', shelfCount: 8, shelfLabels: null,
              capacityPerShelf: 14, sortOrder: 2, active: true }
        ];
        var demo = [
            ['Château Margaux', 'Margaux', 2015, 'red', 'Cabernet Sauvignon, Merlot', 'Margaux', 'France', 2028, 2050, 89900],
            ['Domaine Leflaive', 'Puligny-Montrachet', 2019, 'white', 'Chardonnay', 'Burgundy', 'France', 2024, 2032, 24500],
            ['Grüner Veltliner Weingut Hirsch', 'Heiligenstein', 2021, 'white', 'Grüner Veltliner', 'Kamptal', 'Austria', 2023, 2030, 4200],
            ['Ridge', 'Lytton Springs', 2020, 'red', 'Zinfandel, Petite Sirah', 'Sonoma', 'USA', 2024, 2035, 5500],
            ['Bollinger', 'Special Cuvée', null, 'sparkling', 'Pinot Noir, Chardonnay', 'Champagne', 'France', 2022, 2028, 7200]
        ];
        demo.forEach(function (d, i) {
            var wid = 'demo-w' + i;
            s.wines.wines.push({
                id: wid, producer: d[0], name: d[1], vintage: d[2], nv: d[2] == null,
                color: d[3], varietals: d[4].split(', '), region: d[5], appellation: '',
                country: d[6], abv: null, sizeMl: 750, drinkFrom: d[7], drinkTo: d[8],
                notes: '', externalUrl: '', createdAt: ts, updatedAt: ts
            });
            var n = (i % 3) + 1;
            for (var k = 0; k < n; k++) {
                s.bottles.bottles.push({
                    id: 'demo-b' + i + '-' + k, wineId: wid,
                    code: k === 0 ? model.newCode() : null,
                    fridgeId: i % 2 ? 'F2' : 'F1', shelf: (i % 4) + 1, slot: '',
                    acquiredFrom: 'Boulder Wine Merchant', acquiredAt: '2024-11-03',
                    costCents: d[9], currency: 'USD', sizeMl: 750, notes: '',
                    createdAt: ts, updatedAt: ts
                });
            }
        });
        s.codes.batches.push({
            id: 'demo-batch', printedAt: '2026-01-01', stock: '2.625 x 1 in, 30/sheet',
            codes: s.bottles.bottles.filter(function (b) { return b.code; })
                    .map(function (b) { return b.code; })
                    .concat(model.newCodes(20, []))
        });
        return s;
    }

    Cellar.app = app;
    Cellar.boot = boot;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }

})(window, document);
