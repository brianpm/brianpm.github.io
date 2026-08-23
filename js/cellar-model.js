/* cellar-model.js — pure data layer for the wine cellar app.
 *
 * No DOM, no network, no globals beyond window.Cellar.model. Everything here is
 * deterministic and side-effect free so c/selftest.html can assert on it.
 *
 * Exposed as window.Cellar.model (classic script, no modules).
 */
(function (global) {
    'use strict';

    var Cellar = global.Cellar = global.Cellar || {};

    /* ---------------------------------------------------------------- ids */

    // Crockford Base32 minus I, L, O, U. 32 chars exactly, so masking a random
    // byte with 31 is unbiased (256 / 32 = 8) and needs no rejection sampling.
    var ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    var CODE_LENGTH = 6;
    var CODE_RE = /^[0-9A-HJKMNP-TV-Z]{6}$/;

    function randomBytes(n) {
        var buf = new Uint8Array(n);
        if (global.crypto && global.crypto.getRandomValues) {
            global.crypto.getRandomValues(buf);
        } else {
            for (var i = 0; i < n; i++) buf[i] = Math.floor(Math.random() * 256);
        }
        return buf;
    }

    function newCode() {
        var bytes = randomBytes(CODE_LENGTH);
        var out = '';
        for (var i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] & 31];
        return out;
    }

    // Generate n codes that collide with neither each other nor `existing`.
    function newCodes(n, existing) {
        var seen = Object.create(null);
        (existing || []).forEach(function (c) { seen[c] = true; });
        var out = [];
        var guard = 0;
        while (out.length < n) {
            if (++guard > n * 1000) throw new Error('code generation failed to converge');
            var c = newCode();
            if (seen[c]) continue;
            seen[c] = true;
            out.push(c);
        }
        return out;
    }

    // Forgiving parse of a hand-typed or smudged label.
    // Crockford treats I/L as 1 and O as 0; we also drop separators and case.
    function normalizeCode(raw) {
        if (raw == null) return '';
        return String(raw)
            .toUpperCase()
            .replace(/[^0-9A-Z]/g, '')
            .replace(/[IL]/g, '1')
            .replace(/O/g, '0');
    }

    function isCode(s) { return CODE_RE.test(s); }

    // crypto.randomUUID needs a secure context; http://192.168.x.x (phone on the
    // LAN, which is exactly how this gets tested) is not one. Always have a fallback.
    function newId() {
        if (global.crypto && typeof global.crypto.randomUUID === 'function') {
            try { return global.crypto.randomUUID(); } catch (e) { /* fall through */ }
        }
        var b = randomBytes(16);
        b[6] = (b[6] & 0x0f) | 0x40;
        b[8] = (b[8] & 0x3f) | 0x80;
        var hex = '';
        for (var i = 0; i < 16; i++) hex += (b[i] + 0x100).toString(16).slice(1);
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) +
               '-' + hex.slice(16, 20) + '-' + hex.slice(20);
    }

    function nowIso() { return new Date().toISOString(); }

    // Op timestamps must be strictly increasing within a device, because replay
    // sorts by them and ops CAN be causally dependent (ADD_ARCHIVE_NOTE needs the
    // DRINK_BOTTLE that created its entry). Two ops in the same millisecond would
    // otherwise be tie-broken by random opId and could replay out of order.
    // A monotonic clock also absorbs a backwards system-clock adjustment.
    var lastOpTs = '';
    var opSeq = 0;

    function nextOpTs() {
        var t = nowIso();
        if (t <= lastOpTs) {
            t = new Date(new Date(lastOpTs).getTime() + 1).toISOString();
        }
        lastOpTs = t;
        return t;
    }

    // Called on startup with the persisted queue so the counters resume past
    // anything already pending rather than restarting at zero.
    function restoreOpCounters(queue) {
        (queue || []).forEach(function (op) {
            if (op.ts && op.ts > lastOpTs) lastOpTs = op.ts;
            if (typeof op.seq === 'number' && op.seq >= opSeq) opSeq = op.seq + 1;
        });
    }

    /* ------------------------------------------------------------- schema */

    var SCHEMA_VERSION = 1;
    var DOCS = ['config', 'wines', 'bottles', 'archive', 'codes'];

    // Written destination-before-source so a crash mid-flush leaves a recoverable
    // state (a duplicated bottle, which the convergent reducers resolve) rather
    // than a lost one. See flush() in cellar-app.js.
    var WRITE_ORDER = ['codes', 'config', 'wines', 'archive', 'bottles'];

    var COLORS = ['red', 'white', 'rose', 'sparkling', 'fortified', 'other'];
    var DISPOSITIONS = ['drunk', 'gifted', 'traded', 'sold', 'broken', 'corked', 'lost'];

    function skeleton(doc) {
        var base = { schemaVersion: SCHEMA_VERSION, updatedAt: null };
        switch (doc) {
            case 'config':
                base.currency = 'USD';
                base.defaults = { bottleSizeMl: 750, fridgeId: null };
                base.fridges = [];
                return base;
            case 'wines':   base.wines = [];    return base;
            case 'bottles': base.bottles = [];  return base;
            case 'archive': base.entries = [];  return base;
            case 'codes':
                base.alphabet = ALPHABET;
                base.length = CODE_LENGTH;
                base.batches = [];
                return base;
            default:
                throw new Error('unknown doc: ' + doc);
        }
    }

    function emptyState() {
        var s = {};
        DOCS.forEach(function (d) { s[d] = skeleton(d); });
        return s;
    }

    function newFridge(name, shelfCount, sortOrder) {
        return {
            id: 'F' + newCode().slice(0, 4),
            name: name,
            shelfCount: shelfCount,
            shelfLabels: null,
            capacityPerShelf: null,
            sortOrder: sortOrder,
            active: true
        };
    }

    /* ------------------------------------------ canonical serialization */

    // Fixed field order per record type. Not Object.keys — key order must not
    // depend on how an object happened to be constructed, or two clients in the
    // same logical state emit different bytes and the "no diff, skip the PUT"
    // check in flush() breaks.
    var FIELDS = {
        fridge: ['id', 'name', 'shelfCount', 'shelfLabels', 'capacityPerShelf', 'sortOrder', 'active'],
        wine: ['id', 'producer', 'name', 'vintage', 'nv', 'color', 'varietals', 'region',
               'appellation', 'country', 'abv', 'sizeMl', 'drinkFrom', 'drinkTo', 'notes',
               'externalUrl', 'createdAt', 'updatedAt'],
        bottle: ['id', 'wineId', 'code', 'fridgeId', 'shelf', 'slot', 'acquiredFrom',
                 'acquiredAt', 'costCents', 'currency', 'sizeMl', 'notes',
                 'createdAt', 'updatedAt'],
        archive: ['id', 'bottleId', 'wineId', 'code', 'wineSnapshot', 'disposition',
                  'occurredAt', 'lastLocation', 'acquiredFrom', 'acquiredAt', 'costCents',
                  'currency', 'rating', 'notes', 'createdAt', 'updatedAt'],
        note: ['id', 'at', 'author', 'text'],
        batch: ['id', 'printedAt', 'stock', 'codes'],
        snapshot: ['producer', 'name', 'vintage', 'color'],
        location: ['fridgeId', 'shelf', 'slot']
    };

    function ordered(obj, fields) {
        if (obj == null) return null;
        var out = {};
        fields.forEach(function (f) { if (obj[f] !== undefined) out[f] = obj[f]; });
        return out;
    }

    function byKeys() {
        var keys = Array.prototype.slice.call(arguments);
        return function (a, b) {
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i], desc = false;
                if (k.charAt(0) === '-') { desc = true; k = k.slice(1); }
                var av = a[k], bv = b[k];
                if (av === bv) continue;
                // nulls sort last regardless of direction
                if (av == null) return 1;
                if (bv == null) return -1;
                var r = av < bv ? -1 : 1;
                return desc ? -r : r;
            }
            return 0;
        };
    }

    function canonical(doc, data) {
        var out = { schemaVersion: SCHEMA_VERSION, updatedAt: data.updatedAt || null };
        switch (doc) {
            case 'config':
                out.currency = data.currency || 'USD';
                out.defaults = {
                    bottleSizeMl: (data.defaults && data.defaults.bottleSizeMl) || 750,
                    fridgeId: (data.defaults && data.defaults.fridgeId) || null
                };
                out.fridges = (data.fridges || []).slice()
                    .sort(byKeys('sortOrder', 'id'))
                    .map(function (f) { return ordered(f, FIELDS.fridge); });
                return out;
            case 'wines':
                out.wines = (data.wines || []).slice()
                    .sort(byKeys('createdAt', 'id'))
                    .map(function (w) { return ordered(w, FIELDS.wine); });
                return out;
            case 'bottles':
                out.bottles = (data.bottles || []).slice()
                    .sort(byKeys('createdAt', 'id'))
                    .map(function (b) { return ordered(b, FIELDS.bottle); });
                return out;
            case 'archive':
                out.entries = (data.entries || []).slice()
                    .sort(byKeys('-occurredAt', 'id'))
                    .map(function (e) {
                        var o = ordered(e, FIELDS.archive);
                        o.wineSnapshot = ordered(e.wineSnapshot, FIELDS.snapshot);
                        o.lastLocation = ordered(e.lastLocation, FIELDS.location);
                        o.notes = (e.notes || []).slice()
                            .sort(byKeys('at', 'id'))
                            .map(function (n) { return ordered(n, FIELDS.note); });
                        return o;
                    });
                return out;
            case 'codes':
                out.alphabet = data.alphabet || ALPHABET;
                out.length = data.length || CODE_LENGTH;
                out.batches = (data.batches || []).slice()
                    .sort(byKeys('printedAt', 'id'))
                    .map(function (b) { return ordered(b, FIELDS.batch); });
                return out;
            default:
                throw new Error('unknown doc: ' + doc);
        }
    }

    function serialize(doc, data) {
        return JSON.stringify(canonical(doc, data), null, 2) + '\n';
    }

    /* ----------------------------------------------------------- lookups */

    function index(list, key) {
        var m = Object.create(null);
        (list || []).forEach(function (x) { if (x && x[key] != null) m[x[key]] = x; });
        return m;
    }

    function bottleByCode(state, code) {
        var list = state.bottles.bottles || [];
        for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i];
        return null;
    }

    function archiveByCode(state, code) {
        var list = state.archive.entries || [];
        // Most recent first — canonical order is already occurredAt desc, but
        // don't rely on the caller having serialized.
        var best = null;
        for (var i = 0; i < list.length; i++) {
            if (list[i].code !== code) continue;
            if (!best || String(list[i].occurredAt) > String(best.occurredAt)) best = list[i];
        }
        return best;
    }

    function allIssuedCodes(state) {
        var out = [];
        (state.codes.batches || []).forEach(function (b) {
            (b.codes || []).forEach(function (c) { out.push(c); });
        });
        return out;
    }

    // Derived, never stored: storing per-code status would make codes.json a
    // second hot document and double the write-conflict surface for no benefit.
    function codeStatus(state, code) {
        if (bottleByCode(state, code)) return 'assigned';
        if (archiveByCode(state, code)) return 'retired';
        if (allIssuedCodes(state).indexOf(code) !== -1) return 'issued';
        return 'unknown';
    }

    function fridgeById(state, id) {
        return index(state.config.fridges, 'id')[id] || null;
    }

    function wineById(state, id) {
        return index(state.wines.wines, 'id')[id] || null;
    }

    function snapshotOf(wine) {
        if (!wine) return { producer: '', name: '', vintage: null, color: 'other' };
        return {
            producer: wine.producer || '',
            name: wine.name || '',
            vintage: wine.vintage == null ? null : wine.vintage,
            color: wine.color || 'other'
        };
    }

    /* ---------------------------------------------------------- reducers */

    // Every reducer is CONVERGENT: it states what the world should look like,
    // never "add one to what's there". That makes replay idempotent, which is
    // what lets flush() re-run the whole queue against fresh server state after
    // a 409 without an applied-op ledger. Break this in one reducer and the
    // whole concurrency story silently becomes wrong.

    function clone(x) { return JSON.parse(JSON.stringify(x)); }

    function touch(doc, ts) { doc.updatedAt = ts; return doc; }

    var REDUCERS = {

        SET_CONFIG: function (state, op) {
            var p = op.payload;
            var c = state.config;
            if (p.currency !== undefined) c.currency = p.currency;
            if (p.defaults !== undefined) c.defaults = clone(p.defaults);
            if (p.fridges !== undefined) c.fridges = clone(p.fridges);
            touch(c, op.ts);
            return state;
        },

        ISSUE_CODES: function (state, op) {
            var p = op.payload;
            var batches = state.codes.batches;
            for (var i = 0; i < batches.length; i++) {
                // Same batch id already present -> already applied.
                if (batches[i].id === p.batchId) return state;
            }
            batches.push({
                id: p.batchId,
                printedAt: p.printedAt,
                stock: p.stock || '',
                codes: p.codes.slice()
            });
            touch(state.codes, op.ts);
            return state;
        },

        ADD_WINE: function (state, op) {
            var p = op.payload;
            if (wineById(state, p.wine.id)) return state;   // replay
            var w = clone(p.wine);
            w.createdAt = w.createdAt || op.ts;
            w.updatedAt = op.ts;
            state.wines.wines.push(w);
            touch(state.wines, op.ts);
            return state;
        },

        EDIT_WINE: function (state, op) {
            var p = op.payload;
            var w = wineById(state, p.wineId);
            if (!w) return state;
            Object.keys(p.fields).forEach(function (k) { w[k] = clone(p.fields[k]); });
            w.updatedAt = op.ts;
            touch(state.wines, op.ts);
            return state;
        },

        ADD_BOTTLES: function (state, op) {
            var p = op.payload;
            var have = index(state.bottles.bottles, 'id');
            var added = false;
            p.bottles.forEach(function (b) {
                if (have[b.id]) return;                     // replay
                var nb = clone(b);
                nb.createdAt = nb.createdAt || op.ts;
                nb.updatedAt = op.ts;
                state.bottles.bottles.push(nb);
                added = true;
            });
            if (added) touch(state.bottles, op.ts);
            return state;
        },

        EDIT_BOTTLE: function (state, op) {
            var p = op.payload;
            var b = index(state.bottles.bottles, 'id')[p.bottleId];
            if (!b) return state;
            Object.keys(p.fields).forEach(function (k) { b[k] = clone(p.fields[k]); });
            b.updatedAt = op.ts;
            touch(state.bottles, op.ts);
            return state;
        },

        ASSIGN_CODE: function (state, op) {
            var p = op.payload;
            var b = index(state.bottles.bottles, 'id')[p.bottleId];
            if (!b) return state;
            // Absolute set, not a swap — replay is a no-op.
            if (b.code === p.code) return state;
            // Never let two live bottles share a code.
            var holder = bottleByCode(state, p.code);
            if (holder && holder.id !== b.id) return state;
            b.code = p.code;
            b.updatedAt = op.ts;
            touch(state.bottles, op.ts);
            return state;
        },

        MOVE_BOTTLE: function (state, op) {
            var p = op.payload;
            var b = index(state.bottles.bottles, 'id')[p.bottleId];
            if (!b) return state;
            if (b.fridgeId === p.fridgeId && b.shelf === p.shelf &&
                (b.slot || '') === (p.slot || '')) return state;
            b.fridgeId = p.fridgeId;
            b.shelf = p.shelf;
            b.slot = p.slot || '';
            b.updatedAt = op.ts;
            touch(state.bottles, op.ts);
            return state;
        },

        DRINK_BOTTLE: function (state, op) {
            var p = op.payload;
            var entries = state.archive.entries;
            var existing = index(entries, 'id')[p.archiveId];
            var bottles = state.bottles.bottles;
            var idx = -1;
            for (var i = 0; i < bottles.length; i++) {
                if (bottles[i].id === p.bottleId) { idx = i; break; }
            }

            if (existing) {
                // Archive entry already written. Only ensure the bottle is gone —
                // this is the self-heal for a crash between the two doc writes.
                if (idx !== -1) {
                    bottles.splice(idx, 1);
                    touch(state.bottles, op.ts);
                }
                return state;
            }

            if (idx === -1) return state;                   // nothing to archive
            var b = bottles[idx];
            var w = wineById(state, b.wineId);
            entries.push({
                id: p.archiveId,
                bottleId: b.id,
                wineId: b.wineId,
                code: b.code,
                // Denormalized on purpose: the archive must stay readable if the
                // wine record is later edited or deleted, and renders with no join.
                wineSnapshot: snapshotOf(w),
                disposition: p.disposition || 'drunk',
                occurredAt: p.occurredAt || op.ts,
                lastLocation: { fridgeId: b.fridgeId, shelf: b.shelf, slot: b.slot || '' },
                acquiredFrom: b.acquiredFrom || '',
                acquiredAt: b.acquiredAt || null,
                costCents: b.costCents == null ? null : b.costCents,
                currency: b.currency || 'USD',
                rating: p.rating == null ? null : p.rating,
                notes: p.note
                    ? [{ id: p.noteId || newId(), at: op.ts, author: op.actor || '', text: p.note }]
                    : [],
                createdAt: op.ts,
                updatedAt: op.ts
            });
            bottles.splice(idx, 1);
            touch(state.archive, op.ts);
            touch(state.bottles, op.ts);
            return state;
        },

        RESTORE_BOTTLE: function (state, op) {
            var p = op.payload;
            var entries = state.archive.entries;
            var ai = -1;
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].id === p.archiveId) { ai = i; break; }
            }
            var live = index(state.bottles.bottles, 'id');

            if (ai === -1) return state;                    // already restored
            var e = entries[ai];
            if (!live[e.bottleId]) {
                var loc = e.lastLocation || {};
                state.bottles.bottles.push({
                    id: e.bottleId,
                    wineId: e.wineId,
                    code: e.code,
                    fridgeId: p.fridgeId || loc.fridgeId || null,
                    shelf: p.shelf != null ? p.shelf : (loc.shelf != null ? loc.shelf : null),
                    slot: loc.slot || '',
                    acquiredFrom: e.acquiredFrom || '',
                    acquiredAt: e.acquiredAt || null,
                    costCents: e.costCents == null ? null : e.costCents,
                    currency: e.currency || 'USD',
                    sizeMl: p.sizeMl || 750,
                    notes: '',
                    createdAt: e.createdAt || op.ts,
                    updatedAt: op.ts
                });
                touch(state.bottles, op.ts);
            }
            entries.splice(ai, 1);
            touch(state.archive, op.ts);
            return state;
        },

        // Permanent removal, with no archive entry and no history — the fix for a
        // bottle entered by mistake, not for one that was consumed (that is
        // DRINK_BOTTLE). Convergent: it asserts "this id is absent", so replaying
        // it against state where the bottle is already gone is a no-op.
        DELETE_BOTTLE: function (state, op) {
            var p = op.payload;
            var bottles = state.bottles.bottles;
            for (var i = 0; i < bottles.length; i++) {
                if (bottles[i].id !== p.bottleId) continue;
                bottles.splice(i, 1);
                touch(state.bottles, op.ts);
                break;
            }
            // The bottle's code is not retired: codeStatus() will report it as
            // 'issued' again, so the physical label goes back in the pool.
            return state;
        },

        // Removes a wine that nothing references any more — the leftover of
        // deleting the last bottle of a mis-entered wine. The guard is evaluated
        // at replay time against whatever state we are replaying onto, so if
        // another device added a bottle of this wine while we were offline the
        // record is correctly kept.
        DELETE_WINE: function (state, op) {
            var p = op.payload;
            var bottles = state.bottles.bottles || [];
            for (var i = 0; i < bottles.length; i++) {
                if (bottles[i].wineId === p.wineId) return state;
            }
            var entries = state.archive.entries || [];
            for (var j = 0; j < entries.length; j++) {
                if (entries[j].wineId === p.wineId) return state;
            }
            var wines = state.wines.wines;
            for (var k = 0; k < wines.length; k++) {
                if (wines[k].id !== p.wineId) continue;
                wines.splice(k, 1);
                touch(state.wines, op.ts);
                break;
            }
            return state;
        },

        ADD_ARCHIVE_NOTE: function (state, op) {
            var p = op.payload;
            var e = index(state.archive.entries, 'id')[p.archiveId];
            if (!e) return state;
            e.notes = e.notes || [];
            for (var i = 0; i < e.notes.length; i++) {
                if (e.notes[i].id === p.noteId) return state;   // replay
            }
            e.notes.push({
                id: p.noteId,
                at: p.at || op.ts,
                author: op.actor || '',
                text: p.text
            });
            if (p.rating != null) e.rating = p.rating;
            e.updatedAt = op.ts;
            touch(state.archive, op.ts);
            return state;
        }
    };

    function makeOp(type, payload, actor) {
        if (!REDUCERS[type]) throw new Error('unknown op type: ' + type);
        return {
            opId: newId(),
            ts: nextOpTs(),
            seq: opSeq++,
            actor: actor || '',
            type: type,
            payload: payload
        };
    }

    function apply(state, op) {
        var r = REDUCERS[op.type];
        if (!r) throw new Error('unknown op type: ' + op.type);
        return r(state, op);
    }

    // Pure: never mutates `base`. Ops are applied in timestamp order so two
    // devices replaying the same queue land in the same place.
    function replay(base, ops) {
        var state = clone(base);
        ops.slice()
            .sort(function (a, b) {
                // ts first (orders across devices), then the local sequence number
                // (preserves causal order within a device), then opId as a final
                // deterministic tiebreak so any two clients replay identically.
                if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
                var as = a.seq == null ? 0 : a.seq, bs = b.seq == null ? 0 : b.seq;
                if (as !== bs) return as - bs;
                return a.opId < b.opId ? -1 : 1;
            })
            .forEach(function (op) { state = apply(state, op); });
        return state;
    }

    /* --------------------------------------------------------------- CSV */

    // Columns the importer knows how to map onto. Order drives the UI.
    var IMPORT_FIELDS = [
        { key: 'producer',     label: 'Producer / Winery' },
        { key: 'name',         label: 'Wine name' },
        { key: 'vintage',      label: 'Vintage' },
        { key: 'color',        label: 'Color / Type' },
        { key: 'varietals',    label: 'Varietal(s)' },
        { key: 'region',       label: 'Region' },
        { key: 'appellation',  label: 'Appellation' },
        { key: 'country',      label: 'Country' },
        { key: 'sizeMl',       label: 'Bottle size (mL)' },
        { key: 'drinkFrom',    label: 'Drink from (year)' },
        { key: 'drinkTo',      label: 'Drink to (year)' },
        { key: 'quantity',     label: 'Quantity (number of bottles)' },
        { key: 'acquiredFrom', label: 'Bought from' },
        { key: 'acquiredAt',   label: 'Purchase date' },
        { key: 'price',        label: 'Price per bottle' },
        { key: 'notes',        label: 'Notes' }
    ];

    // CellarTracker's export column names, by far the likeliest source.
    var CELLARTRACKER_MAP = {
        'Producer': 'producer', 'Wine': 'name', 'Vintage': 'vintage',
        'Color': 'color', 'Varietal': 'varietals', 'Region': 'region',
        'Appellation': 'appellation', 'Country': 'country', 'Size': 'sizeMl',
        'BeginConsume': 'drinkFrom', 'EndConsume': 'drinkTo',
        'Quantity': 'quantity', 'StoreName': 'acquiredFrom',
        'PurchaseDate': 'acquiredAt', 'Price': 'price', 'PNotes': 'notes'
    };

    function guessMapping(headers) {
        var map = {};
        headers.forEach(function (h) {
            var exact = CELLARTRACKER_MAP[h];
            if (exact) { map[h] = exact; return; }
            var n = String(h).toLowerCase().replace(/[^a-z]/g, '');
            var guess = ({
                producer: 'producer', winery: 'producer', domaine: 'producer',
                wine: 'name', winename: 'name', label: 'name', designation: 'name',
                vintage: 'vintage', year: 'vintage',
                color: 'color', type: 'color', winetype: 'color',
                varietal: 'varietals', varietals: 'varietals', grape: 'varietals',
                grapes: 'varietals', variety: 'varietals',
                region: 'region', appellation: 'appellation', country: 'country',
                size: 'sizeMl', bottlesize: 'sizeMl', format: 'sizeMl',
                beginconsume: 'drinkFrom', drinkfrom: 'drinkFrom',
                endconsume: 'drinkTo', drinkto: 'drinkTo',
                quantity: 'quantity', qty: 'quantity', count: 'quantity',
                bottles: 'quantity', numberofbottles: 'quantity',
                storename: 'acquiredFrom', store: 'acquiredFrom',
                vendor: 'acquiredFrom', merchant: 'acquiredFrom',
                boughtfrom: 'acquiredFrom', source: 'acquiredFrom',
                purchasedate: 'acquiredAt', purchased: 'acquiredAt',
                datepurchased: 'acquiredAt',
                price: 'price', cost: 'price', pricepaid: 'price',
                notes: 'notes', comment: 'notes', comments: 'notes'
            })[n];
            if (guess) map[h] = guess;
        });
        return map;
    }

    // "$89.99" / "89,99" / 89.99 -> 8999. Integer cents throughout: float dollars
    // accumulate visible error once you total a few hundred bottles.
    function parseMoneyCents(raw) {
        if (raw == null || raw === '') return null;
        if (typeof raw === 'number') return Math.round(raw * 100);
        var s = String(raw).replace(/[^0-9.,-]/g, '').trim();
        if (!s) return null;
        // If both separators appear, the last one is the decimal point.
        var lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
        if (lastDot !== -1 && lastComma !== -1) {
            s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
        } else if (lastComma !== -1) {
            // A lone comma is a decimal point only when it leaves 1-2 trailing digits.
            s = (s.length - lastComma - 1) <= 2 ? s.replace(',', '.') : s.replace(/,/g, '');
        }
        var n = parseFloat(s);
        return isFinite(n) ? Math.round(n * 100) : null;
    }

    function parseIntOrNull(raw) {
        if (raw == null || raw === '') return null;
        var n = parseInt(String(raw).replace(/[^0-9-]/g, ''), 10);
        return isFinite(n) ? n : null;
    }

    function normalizeColor(raw) {
        var s = String(raw || '').toLowerCase();
        if (!s) return 'other';
        if (/spark|champ|cremant|cava|prosecco|petnat|pét/.test(s)) return 'sparkling';
        if (/ros[eé]|blush/.test(s)) return 'rose';
        if (/port|sherry|madeira|fortif|marsala|vermouth/.test(s)) return 'fortified';
        if (/white|blanc|bianco|blanco|weiss/.test(s)) return 'white';
        if (/red|rouge|rosso|tinto|rot/.test(s)) return 'red';
        return COLORS.indexOf(s) !== -1 ? s : 'other';
    }

    function normalizeSizeMl(raw) {
        if (raw == null || raw === '') return 750;
        var s = String(raw).toLowerCase();
        if (/magnum/.test(s)) return 1500;
        if (/half|375/.test(s)) return 375;
        if (/double|3\.0|3l|3 l/.test(s)) return 3000;
        var n = parseFloat(s.replace(/[^0-9.]/g, ''));
        if (!isFinite(n)) return 750;
        // "0.75" / "1.5" are litres; anything else is already mL.
        return n <= 20 ? Math.round(n * 1000) : Math.round(n);
    }

    // rows: array of objects keyed by CSV header. mapping: header -> field key.
    // Returns { wines, bottles, skipped } ready to feed ADD_WINE / ADD_BOTTLES.
    function buildImport(rows, mapping, opts) {
        opts = opts || {};
        var ts = opts.ts || nowIso();
        var defaults = opts.defaults || {};
        var wines = [], bottles = [], skipped = 0;

        rows.forEach(function (row) {
            var v = {};
            Object.keys(mapping).forEach(function (header) {
                var field = mapping[header];
                if (!field) return;
                var cell = row[header];
                if (cell === undefined || cell === null) return;
                cell = String(cell).trim();
                if (cell !== '') v[field] = cell;
            });

            if (!v.producer && !v.name) { skipped++; return; }

            var wineId = newId();
            wines.push({
                id: wineId,
                producer: v.producer || '',
                name: v.name || '',
                vintage: parseIntOrNull(v.vintage),
                nv: !v.vintage || /^nv$/i.test(v.vintage),
                color: normalizeColor(v.color),
                varietals: v.varietals
                    ? v.varietals.split(/[,;/]+/).map(function (s) { return s.trim(); })
                                 .filter(Boolean)
                    : [],
                region: v.region || '',
                appellation: v.appellation || '',
                country: v.country || '',
                abv: null,
                sizeMl: normalizeSizeMl(v.sizeMl),
                drinkFrom: parseIntOrNull(v.drinkFrom),
                drinkTo: parseIntOrNull(v.drinkTo),
                notes: v.notes || '',
                externalUrl: '',
                createdAt: ts,
                updatedAt: ts
            });

            var qty = parseIntOrNull(v.quantity);
            if (qty == null || qty < 1) qty = 1;
            for (var i = 0; i < qty; i++) {
                bottles.push({
                    id: newId(),
                    wineId: wineId,
                    code: null,             // labels get stuck on and scanned later
                    fridgeId: defaults.fridgeId || null,
                    shelf: defaults.shelf != null ? defaults.shelf : null,
                    slot: '',
                    acquiredFrom: v.acquiredFrom || '',
                    acquiredAt: v.acquiredAt || null,
                    costCents: parseMoneyCents(v.price),
                    currency: defaults.currency || 'USD',
                    sizeMl: normalizeSizeMl(v.sizeMl),
                    notes: '',
                    createdAt: ts,
                    updatedAt: ts
                });
            }
        });

        return { wines: wines, bottles: bottles, skipped: skipped };
    }

    function csvEscape(v) {
        if (v == null) return '';
        var s = String(v);
        return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }

    function toCsv(headers, rows) {
        var out = [headers.map(csvEscape).join(',')];
        rows.forEach(function (r) {
            out.push(headers.map(function (h) { return csvEscape(r[h]); }).join(','));
        });
        return out.join('\n') + '\n';
    }

    function exportCsv(state) {
        var rows = [];
        var money = function (c) { return c == null ? '' : (c / 100).toFixed(2); };

        (state.bottles.bottles || []).forEach(function (b) {
            var w = wineById(state, b.wineId) || {};
            var f = fridgeById(state, b.fridgeId);
            rows.push({
                status: 'in cellar', code: b.code || '',
                producer: w.producer || '', wine: w.name || '',
                vintage: w.vintage == null ? '' : w.vintage, color: w.color || '',
                varietals: (w.varietals || []).join('; '),
                region: w.region || '', country: w.country || '',
                sizeMl: b.sizeMl || '', fridge: f ? f.name : '',
                shelf: b.shelf == null ? '' : b.shelf,
                acquiredFrom: b.acquiredFrom || '', acquiredAt: b.acquiredAt || '',
                price: money(b.costCents), consumedAt: '', disposition: '',
                rating: '', notes: b.notes || ''
            });
        });

        (state.archive.entries || []).forEach(function (e) {
            var s = e.wineSnapshot || {};
            var w = wineById(state, e.wineId) || {};
            rows.push({
                status: 'archived', code: e.code || '',
                producer: s.producer || '', wine: s.name || '',
                vintage: s.vintage == null ? '' : s.vintage, color: s.color || '',
                varietals: (w.varietals || []).join('; '),
                region: w.region || '', country: w.country || '',
                sizeMl: '', fridge: '', shelf: '',
                acquiredFrom: e.acquiredFrom || '', acquiredAt: e.acquiredAt || '',
                price: money(e.costCents), consumedAt: e.occurredAt || '',
                disposition: e.disposition || '',
                rating: e.rating == null ? '' : e.rating,
                notes: (e.notes || []).map(function (n) { return n.text; }).join(' | ')
            });
        });

        return toCsv(['status', 'code', 'producer', 'wine', 'vintage', 'color', 'varietals',
                      'region', 'country', 'sizeMl', 'fridge', 'shelf', 'acquiredFrom',
                      'acquiredAt', 'price', 'consumedAt', 'disposition', 'rating', 'notes'],
                     rows);
    }

    /* ------------------------------------------------------------- stats */

    function formatMoney(cents, currency) {
        if (cents == null) return '';
        var sym = { USD: '$', EUR: '€', GBP: '£' }[currency || 'USD'] || '';
        return sym + (cents / 100).toFixed(2);
    }

    function wineLabel(w) {
        if (!w) return 'Unknown wine';
        var bits = [];
        if (w.producer) bits.push(w.producer);
        if (w.name && w.name !== w.producer) bits.push(w.name);
        var s = bits.join(' ');
        var vintage = w.nv ? 'NV' : (w.vintage || '');
        return (s + ' ' + vintage).trim() || 'Untitled wine';
    }

    // "Ready now" ranking for the drink-tonight view: inside the window, closest
    // to the end of it first. Bottles with no window sit at the back.
    function drinkWindowState(w, year) {
        if (!w || (w.drinkFrom == null && w.drinkTo == null)) return 'unknown';
        if (w.drinkFrom != null && year < w.drinkFrom) return 'young';
        if (w.drinkTo != null && year > w.drinkTo) return 'past';
        return 'ready';
    }

    function stats(state) {
        var bottles = state.bottles.bottles || [];
        var entries = state.archive.entries || [];
        var byColor = {}, byFridge = {}, byVintage = {}, byRegion = {};
        var valueCents = 0, priced = 0;

        bottles.forEach(function (b) {
            var w = wineById(state, b.wineId) || {};
            var c = w.color || 'other';
            byColor[c] = (byColor[c] || 0) + 1;
            var f = b.fridgeId || 'unassigned';
            byFridge[f] = (byFridge[f] || 0) + 1;
            var v = w.nv ? 'NV' : (w.vintage == null ? 'unknown' : String(w.vintage));
            byVintage[v] = (byVintage[v] || 0) + 1;
            var r = w.region || w.country || 'unknown';
            byRegion[r] = (byRegion[r] || 0) + 1;
            if (b.costCents != null) { valueCents += b.costCents; priced++; }
        });

        var byMonth = {};
        entries.forEach(function (e) {
            if (e.disposition !== 'drunk' || !e.occurredAt) return;
            var m = String(e.occurredAt).slice(0, 7);
            byMonth[m] = (byMonth[m] || 0) + 1;
        });

        var rated = entries.filter(function (e) { return e.rating != null; });
        var avgRating = rated.length
            ? rated.reduce(function (a, e) { return a + e.rating; }, 0) / rated.length
            : null;

        return {
            liveCount: bottles.length,
            archivedCount: entries.length,
            unlabeled: bottles.filter(function (b) { return !b.code; }).length,
            valueCents: valueCents,
            pricedCount: priced,
            avgRating: avgRating,
            byColor: byColor, byFridge: byFridge, byVintage: byVintage,
            byRegion: byRegion, byMonth: byMonth
        };
    }

    /* ------------------------------------------------------------ export */

    Cellar.model = {
        SCHEMA_VERSION: SCHEMA_VERSION,
        ALPHABET: ALPHABET,
        CODE_LENGTH: CODE_LENGTH,
        DOCS: DOCS,
        WRITE_ORDER: WRITE_ORDER,
        COLORS: COLORS,
        DISPOSITIONS: DISPOSITIONS,
        IMPORT_FIELDS: IMPORT_FIELDS,

        newCode: newCode,
        newCodes: newCodes,
        normalizeCode: normalizeCode,
        isCode: isCode,
        newId: newId,
        nowIso: nowIso,
        restoreOpCounters: restoreOpCounters,

        skeleton: skeleton,
        emptyState: emptyState,
        newFridge: newFridge,

        canonical: canonical,
        serialize: serialize,

        index: index,
        bottleByCode: bottleByCode,
        archiveByCode: archiveByCode,
        allIssuedCodes: allIssuedCodes,
        codeStatus: codeStatus,
        fridgeById: fridgeById,
        wineById: wineById,
        snapshotOf: snapshotOf,

        makeOp: makeOp,
        apply: apply,
        replay: replay,
        clone: clone,

        guessMapping: guessMapping,
        buildImport: buildImport,
        parseMoneyCents: parseMoneyCents,
        normalizeColor: normalizeColor,
        normalizeSizeMl: normalizeSizeMl,
        exportCsv: exportCsv,
        toCsv: toCsv,

        formatMoney: formatMoney,
        wineLabel: wineLabel,
        drinkWindowState: drinkWindowState,
        stats: stats
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = Cellar.model;

})(typeof window !== 'undefined' ? window : globalThis);
