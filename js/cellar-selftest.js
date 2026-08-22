/* cellar-selftest.js — assertions over the pure parts of the cellar app.
 *
 * This is the no-npm answer to unit tests. It runs two ways:
 *   browser: c/selftest.html renders the results as a pass/fail table
 *   node:    node js/cellar-selftest.js   (exits non-zero on failure)
 *
 * Everything asserted here is deterministic and offline — the only store touched
 * is MemoryStore.
 */
(function (global) {
    'use strict';

    var Cellar = global.Cellar = global.Cellar || {};
    var model = Cellar.model;
    var store = Cellar.store;

    var tests = [];
    function test(name, fn) { tests.push({ name: name, fn: fn }); }

    function eq(a, b, msg) {
        var sa = JSON.stringify(a), sb = JSON.stringify(b);
        if (sa !== sb) throw new Error((msg || 'not equal') + '\n  actual:   ' + sa + '\n  expected: ' + sb);
    }
    function ok(v, msg) { if (!v) throw new Error(msg || 'expected truthy, got ' + JSON.stringify(v)); }
    function throws(fn, msg) {
        try { fn(); } catch (e) { return; }
        throw new Error(msg || 'expected a throw');
    }

    /* ------------------------------------------------------------- codes */

    test('code alphabet excludes I, L, O and U', function () {
        ok(model.ALPHABET.length === 32, 'alphabet must be exactly 32 chars for unbiased masking');
        ['I', 'L', 'O', 'U'].forEach(function (c) {
            ok(model.ALPHABET.indexOf(c) === -1, c + ' must not be in the alphabet');
        });
    });

    test('generated codes are well-formed and unique', function () {
        var codes = model.newCodes(2000, []);
        eq(codes.length, 2000);
        var seen = {};
        codes.forEach(function (c) {
            ok(model.isCode(c), 'malformed code: ' + c);
            ok(!seen[c], 'duplicate code: ' + c);
            seen[c] = true;
        });
    });

    test('newCodes dedupes against previously issued codes', function () {
        var first = model.newCodes(500, []);
        var second = model.newCodes(500, first);
        second.forEach(function (c) {
            ok(first.indexOf(c) === -1, 'batch 2 reissued ' + c);
        });
    });

    test('code generation is uniform across the alphabet', function () {
        // Guards the `byte & 31` trick: a 32-char alphabet divides 256 exactly, so
        // no character should be systematically over-represented.
        var counts = {};
        var n = 20000;
        for (var i = 0; i < n; i++) {
            var c = model.newCode();
            for (var j = 0; j < c.length; j++) counts[c[j]] = (counts[c[j]] || 0) + 1;
        }
        var expected = (n * model.CODE_LENGTH) / 32;
        Object.keys(counts).forEach(function (ch) {
            var ratio = counts[ch] / expected;
            ok(ratio > 0.85 && ratio < 1.15, 'char ' + ch + ' skewed: ratio ' + ratio.toFixed(3));
        });
    });

    test('normalizeCode rescues a smudged or hand-typed label', function () {
        eq(model.normalizeCode('k7m2qp'), 'K7M2QP');
        eq(model.normalizeCode('K7M-2QP'), 'K7M2QP');
        eq(model.normalizeCode(' k7 m2 qp '), 'K7M2QP');
        eq(model.normalizeCode('KIM2QP'), 'K1M2QP', 'I must fold to 1');
        eq(model.normalizeCode('KLM2QP'), 'K1M2QP', 'L must fold to 1');
        eq(model.normalizeCode('K7MOQP'), 'K7M0QP', 'O must fold to 0');
        eq(model.normalizeCode(null), '');
    });

    test('isCode rejects near-misses', function () {
        ok(model.isCode('K7M2QP'));
        ok(!model.isCode('K7M2Q'), 'too short');
        ok(!model.isCode('K7M2QPX'), 'too long');
        ok(!model.isCode('K7M2QI'), 'I is not in the alphabet');
        ok(!model.isCode('k7m2qp'), 'lowercase must be normalized first');
    });

    test('newId returns distinct uuid-shaped ids', function () {
        var a = model.newId(), b = model.newId();
        ok(a !== b);
        ok(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(a), 'bad shape: ' + a);
    });

    /* -------------------------------------------------------- base64 */

    test('base64 round-trips accented wine names', function () {
        var nasty = 'Château Grüner Ürziger ½ — Nuits-St-Georges «Réserve» 🍷 Ægir';
        eq(store.base64ToUtf8(store.utf8ToBase64(nasty)), nasty);
    });

    test('base64 round-trips a payload larger than the apply() stack limit', function () {
        // Without chunking this throws RangeError somewhere around 120 KB.
        var big = new Array(30000).join('Château Margaux 2015 — ');
        ok(big.length > 200000, 'test payload too small to be meaningful');
        eq(store.base64ToUtf8(store.utf8ToBase64(big)).length, big.length);
    });

    test('base64 decoder tolerates the newlines GitHub embeds', function () {
        var s = 'Grüner Veltliner';
        var b64 = store.utf8ToBase64(s);
        var wrapped = b64.replace(/(.{4})/g, '$1\n');   // how the contents API returns it
        eq(store.base64ToUtf8(wrapped), s);
    });

    /* ----------------------------------------------- serialization */

    test('serialize is stable regardless of key insertion order', function () {
        var a = { schemaVersion: 1, updatedAt: 'T', wines: [
            { id: 'w1', producer: 'A', name: 'B', vintage: 2015, createdAt: '1' }
        ] };
        var b = { wines: [
            { vintage: 2015, name: 'B', createdAt: '1', producer: 'A', id: 'w1' }
        ], updatedAt: 'T', schemaVersion: 1 };
        eq(model.serialize('wines', a), model.serialize('wines', b));
    });

    test('serialize is stable regardless of array order', function () {
        var w1 = { id: 'w1', producer: 'A', createdAt: '2020-01-01' };
        var w2 = { id: 'w2', producer: 'B', createdAt: '2021-01-01' };
        eq(model.serialize('wines', { wines: [w1, w2] }),
           model.serialize('wines', { wines: [w2, w1] }));
    });

    test('serialize ends with exactly one trailing newline', function () {
        var s = model.serialize('bottles', model.skeleton('bottles'));
        ok(/[^\n]\n$/.test(s), 'expected a single trailing newline');
    });

    test('archive serializes newest-first', function () {
        var mk = function (id, at) {
            return { id: id, occurredAt: at, notes: [], wineSnapshot: {}, lastLocation: {} };
        };
        var out = JSON.parse(model.serialize('archive', {
            entries: [mk('a', '2024-01-01T00:00:00Z'), mk('b', '2026-01-01T00:00:00Z')]
        }));
        eq(out.entries.map(function (e) { return e.id; }), ['b', 'a']);
    });

    /* ----------------------------------------------------- reducers */

    function seeded() {
        var s = model.emptyState();
        var ts = '2026-01-01T00:00:00.000Z';
        s.config.fridges = [
            { id: 'F1', name: 'Basement', shelfCount: 6, shelfLabels: null,
              capacityPerShelf: 12, sortOrder: 1, active: true }
        ];
        s.wines.wines = [
            { id: 'w1', producer: 'Château Margaux', name: 'Margaux', vintage: 2015,
              nv: false, color: 'red', varietals: ['Cabernet Sauvignon'], region: 'Margaux',
              appellation: '', country: 'France', abv: 13.5, sizeMl: 750,
              drinkFrom: 2028, drinkTo: 2050, notes: '', externalUrl: '',
              createdAt: ts, updatedAt: ts }
        ];
        s.bottles.bottles = [
            { id: 'b1', wineId: 'w1', code: 'K7M2QP', fridgeId: 'F1', shelf: 4, slot: '',
              acquiredFrom: 'Boulder Wine Merchant', acquiredAt: '2024-11-03',
              costCents: 8999, currency: 'USD', sizeMl: 750, notes: '',
              createdAt: ts, updatedAt: ts },
            { id: 'b2', wineId: 'w1', code: '3XR9TB', fridgeId: 'F1', shelf: 4, slot: '',
              acquiredFrom: '', acquiredAt: null, costCents: 8999, currency: 'USD',
              sizeMl: 750, notes: '', createdAt: ts, updatedAt: ts }
        ];
        s.codes.batches = [
            { id: 'batch-1', printedAt: '2026-01-01', stock: '2.625 x 1 in, 30/sheet',
              codes: ['K7M2QP', '3XR9TB', 'ZZ99ZZ'] }
        ];
        return s;
    }

    test('DRINK_BOTTLE archives the bottle and removes it from the cellar', function () {
        var s = seeded();
        var op = model.makeOp('DRINK_BOTTLE', {
            bottleId: 'b1', archiveId: 'a1', disposition: 'drunk',
            occurredAt: '2026-08-22T02:14:00Z', rating: 4
        }, 'tester');
        var out = model.replay(s, [op]);
        eq(out.bottles.bottles.length, 1, 'bottle should be gone');
        eq(out.archive.entries.length, 1);
        eq(out.archive.entries[0].code, 'K7M2QP');
        eq(out.archive.entries[0].wineSnapshot.producer, 'Château Margaux',
           'archive must carry a wine snapshot');
        eq(out.archive.entries[0].lastLocation.shelf, 4);
        eq(out.archive.entries[0].costCents, 8999);
    });

    test('DRINK_BOTTLE is idempotent under replay', function () {
        var s = seeded();
        var op = model.makeOp('DRINK_BOTTLE', { bottleId: 'b1', archiveId: 'a1' }, 'tester');
        var once = model.replay(s, [op]);
        var twice = model.replay(once, [op]);
        eq(model.serialize('bottles', twice.bottles), model.serialize('bottles', once.bottles));
        eq(model.serialize('archive', twice.archive), model.serialize('archive', once.archive));
    });

    test('DRINK_BOTTLE self-heals a crash between the archive and bottles writes', function () {
        // Simulate: archive.json was written, bottles.json was not. Replaying the
        // same op against that half-state must finish the job, not duplicate it.
        var s = seeded();
        var op = model.makeOp('DRINK_BOTTLE', { bottleId: 'b1', archiveId: 'a1' }, 'tester');
        var full = model.replay(s, [op]);
        var half = model.clone(s);
        half.archive = model.clone(full.archive);       // archive landed, bottles didn't
        ok(half.bottles.bottles.length === 2, 'precondition: bottle still live');
        var healed = model.replay(half, [op]);
        eq(healed.bottles.bottles.length, 1, 'replay must remove the stranded bottle');
        eq(healed.archive.entries.length, 1, 'replay must not duplicate the archive entry');
    });

    test('MOVE_BOTTLE sets an absolute location and replays cleanly', function () {
        var s = seeded();
        var op = model.makeOp('MOVE_BOTTLE', { bottleId: 'b1', fridgeId: 'F1', shelf: 2 }, 't');
        var once = model.replay(s, [op]);
        var twice = model.replay(once, [op]);
        eq(once.bottles.bottles[0].shelf, 2);
        eq(model.serialize('bottles', twice.bottles), model.serialize('bottles', once.bottles));
    });

    test('ADD_BOTTLES skips ids that already exist', function () {
        var s = seeded();
        var op = model.makeOp('ADD_BOTTLES', { bottles: [
            { id: 'b3', wineId: 'w1', code: null, fridgeId: 'F1', shelf: 1, slot: '',
              acquiredFrom: '', acquiredAt: null, costCents: null, currency: 'USD',
              sizeMl: 750, notes: '' }
        ] }, 't');
        var once = model.replay(s, [op]);
        var twice = model.replay(once, [op]);
        eq(once.bottles.bottles.length, 3);
        eq(twice.bottles.bottles.length, 3, 'replay must not duplicate');
    });

    test('ASSIGN_CODE refuses to give two live bottles the same code', function () {
        var s = seeded();
        var op = model.makeOp('ASSIGN_CODE', { bottleId: 'b2', code: 'K7M2QP' }, 't');
        var out = model.replay(s, [op]);
        eq(out.bottles.bottles[1].code, '3XR9TB', 'b2 must keep its own code');
    });

    test('ADD_ARCHIVE_NOTE appends once per note id', function () {
        var s = seeded();
        var drink = model.makeOp('DRINK_BOTTLE', { bottleId: 'b1', archiveId: 'a1' }, 't');
        var note = model.makeOp('ADD_ARCHIVE_NOTE', {
            archiveId: 'a1', noteId: 'n1', text: 'Great with the lamb.'
        }, 't');
        var once = model.replay(s, [drink, note]);
        var twice = model.replay(once, [note]);
        eq(once.archive.entries[0].notes.length, 1);
        eq(twice.archive.entries[0].notes.length, 1, 'replay must not duplicate the note');
        eq(twice.archive.entries[0].notes[0].text, 'Great with the lamb.');
    });

    test('causally dependent ops keep their order inside one millisecond', function () {
        // Regression: DRINK_BOTTLE and ADD_ARCHIVE_NOTE created in the same tick
        // used to tie on ts and get reordered by random opId, silently dropping
        // the note. Op timestamps are monotonic and `seq` breaks any remaining tie.
        for (var trial = 0; trial < 200; trial++) {
            var drink = model.makeOp('DRINK_BOTTLE', { bottleId: 'b1', archiveId: 'a1' }, 't');
            var note = model.makeOp('ADD_ARCHIVE_NOTE',
                { archiveId: 'a1', noteId: 'n' + trial, text: 'later thought' }, 't');
            ok(drink.ts < note.ts || (drink.ts === note.ts && drink.seq < note.seq),
               'note must sort after the drink that created its entry');
            var out = model.replay(seeded(), [note, drink]);   // deliberately shuffled
            eq(out.archive.entries[0].notes.length, 1,
               'note lost on trial ' + trial + ' (ts ' + drink.ts + ' vs ' + note.ts + ')');
        }
    });

    test('restoreOpCounters resumes past a persisted queue', function () {
        // Only a second ahead: restoreOpCounters ratchets a module-level clock
        // forward, and a far-future value would leak into every later test's ops.
        var ahead = new Date(Date.now() + 1000).toISOString();
        var queued = [{ opId: 'x', ts: ahead, seq: 500, type: 'MOVE_BOTTLE', payload: {} }];
        model.restoreOpCounters(queued);
        var next = model.makeOp('MOVE_BOTTLE', { bottleId: 'b1', fridgeId: 'F1', shelf: 1 }, 't');
        ok(next.ts > queued[0].ts, 'new op must sort after anything already pending');
        ok(next.seq > queued[0].seq, 'seq must resume past the persisted maximum');
    });

    test('RESTORE_BOTTLE undoes a drink and is idempotent', function () {
        var s = seeded();
        var drink = model.makeOp('DRINK_BOTTLE', { bottleId: 'b1', archiveId: 'a1' }, 't');
        var restore = model.makeOp('RESTORE_BOTTLE', { archiveId: 'a1' }, 't');
        var once = model.replay(s, [drink, restore]);
        eq(once.bottles.bottles.length, 2, 'bottle should be back');
        eq(once.archive.entries.length, 0);
        var twice = model.replay(once, [restore]);
        eq(twice.bottles.bottles.length, 2, 'replay must not duplicate the bottle');
    });

    test('ISSUE_CODES is idempotent by batch id', function () {
        var s = seeded();
        var op = model.makeOp('ISSUE_CODES', {
            batchId: 'batch-2', printedAt: '2026-02-01', stock: '2.625 x 1 in, 30/sheet',
            codes: ['AAAAAA', 'BBBBBB']
        }, 't');
        var once = model.replay(s, [op]);
        var twice = model.replay(once, [op]);
        eq(once.codes.batches.length, 2);
        eq(twice.codes.batches.length, 2, 'replay must not duplicate the batch');
    });

    test('replay is order-independent for concurrent independent ops', function () {
        // The real-world case: two phones each drink a different bottle offline.
        var s = seeded();
        var a = model.makeOp('DRINK_BOTTLE', { bottleId: 'b1', archiveId: 'a1' }, 'phone-a');
        a.ts = '2026-08-22T10:00:00.000Z';
        var b = model.makeOp('DRINK_BOTTLE', { bottleId: 'b2', archiveId: 'a2' }, 'phone-b');
        b.ts = '2026-08-22T10:00:01.000Z';
        var ab = model.replay(s, [a, b]);
        var ba = model.replay(s, [b, a]);
        eq(model.serialize('bottles', ba.bottles), model.serialize('bottles', ab.bottles));
        eq(model.serialize('archive', ba.archive), model.serialize('archive', ab.archive));
        eq(ab.bottles.bottles.length, 0, 'both bottles should be gone');
        eq(ab.archive.entries.length, 2, 'both should be archived');
    });

    test('makeOp rejects an unknown op type', function () {
        throws(function () { model.makeOp('DRINK_ALL_OF_IT', {}); });
    });

    /* ------------------------------------------------------- lookups */

    test('codeStatus derives assigned / retired / issued / unknown', function () {
        var s = seeded();
        eq(model.codeStatus(s, 'K7M2QP'), 'assigned');
        eq(model.codeStatus(s, 'ZZ99ZZ'), 'issued');
        eq(model.codeStatus(s, 'QQQQQQ'), 'unknown');
        var drunk = model.replay(s, [model.makeOp('DRINK_BOTTLE',
            { bottleId: 'b1', archiveId: 'a1' }, 't')]);
        eq(model.codeStatus(drunk, 'K7M2QP'), 'retired');
    });

    /* ----------------------------------------------------- CSV import */

    test('parseMoneyCents handles the formats a wine shop actually emits', function () {
        eq(model.parseMoneyCents('$89.99'), 8999);
        eq(model.parseMoneyCents('89.99'), 8999);
        eq(model.parseMoneyCents(89.99), 8999);
        eq(model.parseMoneyCents('1,234.56'), 123456, 'comma as thousands separator');
        eq(model.parseMoneyCents('1.234,56'), 123456, 'European format');
        eq(model.parseMoneyCents('89,99'), 8999, 'lone comma as decimal point');
        eq(model.parseMoneyCents('1,234'), 123400, 'lone comma as thousands separator');
        eq(model.parseMoneyCents(''), null);
        eq(model.parseMoneyCents(null), null);
    });

    test('money stays exact across many bottles', function () {
        // The reason costCents is an integer: 600 x $89.99 in floats drifts.
        var total = 0;
        for (var i = 0; i < 600; i++) total += model.parseMoneyCents('89.99');
        eq(total, 5399400);
    });

    test('normalizeColor maps real-world type strings', function () {
        eq(model.normalizeColor('Red'), 'red');
        eq(model.normalizeColor('White - Sweet/Dessert'), 'white');
        eq(model.normalizeColor('Champagne'), 'sparkling');
        eq(model.normalizeColor('Rosé'), 'rose');
        eq(model.normalizeColor('Port'), 'fortified');
        eq(model.normalizeColor(''), 'other');
    });

    test('normalizeSizeMl handles litres, millilitres and words', function () {
        eq(model.normalizeSizeMl('750ml'), 750);
        eq(model.normalizeSizeMl('0.75'), 750);
        eq(model.normalizeSizeMl('1.5L'), 1500);
        eq(model.normalizeSizeMl('Magnum'), 1500);
        eq(model.normalizeSizeMl('375'), 375);
        eq(model.normalizeSizeMl(''), 750);
    });

    test('guessMapping recognizes CellarTracker headers', function () {
        var m = model.guessMapping(['Producer', 'Wine', 'Vintage', 'Quantity', 'Price', 'Nonsense']);
        eq(m.Producer, 'producer');
        eq(m.Wine, 'name');
        eq(m.Vintage, 'vintage');
        eq(m.Quantity, 'quantity');
        eq(m.Price, 'price');
        eq(m.Nonsense, undefined, 'unknown columns stay unmapped');
    });

    test('guessMapping recognizes plain spreadsheet headers', function () {
        var m = model.guessMapping(['Winery', 'Wine Name', 'Year', '# of Bottles', 'Bought From']);
        eq(m.Winery, 'producer');
        eq(m['Wine Name'], 'name');
        eq(m.Year, 'vintage');
        eq(m['Bought From'], 'acquiredFrom');
    });

    test('buildImport expands a quantity column into individual bottles', function () {
        var rows = [
            { Producer: 'Château Margaux', Wine: 'Margaux', Vintage: '2015',
              Quantity: '12', Price: '$89.99', Color: 'Red' },
            { Producer: 'Domaine Leflaive', Wine: 'Puligny', Vintage: '2019',
              Quantity: '', Price: '', Color: 'White' }
        ];
        var mapping = model.guessMapping(Object.keys(rows[0]));
        var out = model.buildImport(rows, mapping, {});
        eq(out.wines.length, 2);
        eq(out.bottles.length, 13, '12 + a blank quantity defaulting to 1');
        eq(out.wines[0].color, 'red');
        eq(out.bottles[0].costCents, 8999);
        eq(out.bottles[0].code, null, 'imported bottles are unlabeled until scanned');
        var ids = {};
        out.bottles.forEach(function (b) {
            ok(!ids[b.id], 'duplicate bottle id in import');
            ids[b.id] = true;
        });
    });

    test('buildImport skips rows with neither producer nor wine name', function () {
        var out = model.buildImport(
            [{ Producer: '', Wine: '' }, { Producer: 'X', Wine: 'Y' }],
            { Producer: 'producer', Wine: 'name' }, {});
        eq(out.wines.length, 1);
        eq(out.skipped, 1);
    });

    test('exportCsv escapes commas and quotes', function () {
        var s = seeded();
        s.wines.wines[0].name = 'Margaux, "Grand Vin"';
        var csv = model.exportCsv(s);
        ok(csv.indexOf('"Margaux, ""Grand Vin"""') !== -1, 'bad CSV escaping:\n' + csv);
    });

    test('exportCsv covers both live and archived bottles', function () {
        var s = model.replay(seeded(), [model.makeOp('DRINK_BOTTLE',
            { bottleId: 'b1', archiveId: 'a1' }, 't')]);
        var csv = model.exportCsv(s);
        ok(csv.indexOf('in cellar') !== -1);
        ok(csv.indexOf('archived') !== -1);
    });

    /* --------------------------------------------------------- stats */

    test('stats counts live, archived and unlabeled bottles', function () {
        var s = seeded();
        s.bottles.bottles.push({ id: 'b3', wineId: 'w1', code: null, fridgeId: 'F1',
            shelf: 1, slot: '', costCents: null, currency: 'USD', sizeMl: 750,
            createdAt: 'x', updatedAt: 'x' });
        var st = model.stats(s);
        eq(st.liveCount, 3);
        eq(st.unlabeled, 1);
        eq(st.valueCents, 17998);
        eq(st.byColor.red, 3);
    });

    test('drinkWindowState classifies against the current year', function () {
        var w = { drinkFrom: 2028, drinkTo: 2050 };
        eq(model.drinkWindowState(w, 2026), 'young');
        eq(model.drinkWindowState(w, 2030), 'ready');
        eq(model.drinkWindowState(w, 2051), 'past');
        eq(model.drinkWindowState({}, 2030), 'unknown');
    });

    /* ------------------------------------------------- MemoryStore */

    test('MemoryStore round-trips a document', function () {
        var ms = new store.MemoryStore(seeded(), { latencyMs: 0 });
        return ms.getDoc('bottles').then(function (r) {
            eq(r.data.bottles.length, 2);
            r.data.bottles[0].shelf = 6;
            return ms.putDoc('bottles', r.data, r.rev, 'test').then(function (put) {
                ok(put.rev && put.rev !== r.rev, 'rev must advance');
                return ms.getDoc('bottles');
            });
        }).then(function (r2) {
            eq(r2.data.bottles[0].shelf, 6);
        });
    });

    test('MemoryStore raises ConflictError on a stale rev', function () {
        var ms = new store.MemoryStore(seeded(), { latencyMs: 0 });
        return ms.getDoc('bottles').then(function (r) {
            return ms.putDoc('bottles', r.data, r.rev, 'first').then(function () {
                // r.rev is now stale — this is exactly the two-phones case.
                return ms.putDoc('bottles', r.data, r.rev, 'second');
            });
        }).then(function () {
            throw new Error('expected a ConflictError');
        }, function (e) {
            ok(e.isConflict, 'expected isConflict, got ' + e.name + ': ' + e.message);
            ok(e.currentData, 'ConflictError must carry current data for the replay');
        });
    });

    test('MemoryStore creates a skeleton for an unknown document', function () {
        var ms = new store.MemoryStore(model.emptyState(), { latencyMs: 0 });
        return ms.getDoc('wines').then(function (r) {
            eq(r.data.wines, []);
        });
    });

    /* ---------------------------------------------- conflict replay */

    test('a stale client replays onto fresh state without losing either change', function () {
        // The test that matters: window 1 drinks bottle A and syncs; window 2 is
        // holding a pre-drink copy and drinks bottle B. Both must survive.
        var server = new store.MemoryStore(seeded(), { latencyMs: 0 });
        var stale = null;

        return server.getAll(model.DOCS).then(function (snapshot) {
            stale = snapshot;                                 // window 2's stale copy

            // Window 1 drinks b1 and writes.
            var base = {};
            model.DOCS.forEach(function (d) { base[d] = model.clone(snapshot[d].data); });
            var next = model.replay(base, [model.makeOp('DRINK_BOTTLE',
                { bottleId: 'b1', archiveId: 'a1' }, 'phone-1')]);
            return server.putDoc('archive', next.archive, snapshot.archive.rev, 'w1')
                .then(function () {
                    return server.putDoc('bottles', next.bottles, snapshot.bottles.rev, 'w1');
                });
        }).then(function () {
            // Window 2 tries to write its own drink using the stale rev.
            var base = {};
            model.DOCS.forEach(function (d) { base[d] = model.clone(stale[d].data); });
            var op = model.makeOp('DRINK_BOTTLE', { bottleId: 'b2', archiveId: 'a2' }, 'phone-2');
            var next = model.replay(base, [op]);
            return server.putDoc('bottles', next.bottles, stale.bottles.rev, 'w2')
                .then(function () { throw new Error('expected a conflict'); },
                      function (e) {
                          ok(e.isConflict, 'expected a conflict, got ' + e.message);
                          // Retry the way flush() does: re-fetch, replay, re-write.
                          return server.getAll(model.DOCS).then(function (fresh) {
                              var b2 = {};
                              model.DOCS.forEach(function (d) { b2[d] = model.clone(fresh[d].data); });
                              var merged = model.replay(b2, [op]);
                              return server.putDoc('archive', merged.archive, fresh.archive.rev, 'w2')
                                  .then(function () {
                                      return server.putDoc('bottles', merged.bottles,
                                                           fresh.bottles.rev, 'w2');
                                  });
                          });
                      });
        }).then(function () {
            return server.getAll(model.DOCS);
        }).then(function (final) {
            eq(final.bottles.data.bottles.length, 0, 'both bottles should be gone');
            eq(final.archive.data.entries.length, 2, 'BOTH drinks must be recorded');
            var ids = final.archive.data.entries.map(function (e) { return e.id; }).sort();
            eq(ids, ['a1', 'a2']);
        });
    });

    /* ----------------------------------------------------------- runner */

    function run() {
        var results = [];
        var chain = Promise.resolve();
        tests.forEach(function (t) {
            chain = chain.then(function () {
                var started = Date.now();
                var done = function (err) {
                    results.push({
                        name: t.name,
                        pass: !err,
                        error: err ? (err.message || String(err)) : null,
                        ms: Date.now() - started
                    });
                };
                try {
                    var r = t.fn();
                    if (r && typeof r.then === 'function') {
                        return r.then(function () { done(null); }, function (e) { done(e); });
                    }
                    done(null);
                } catch (e) {
                    done(e);
                }
            });
        });
        return chain.then(function () {
            return {
                results: results,
                passed: results.filter(function (r) { return r.pass; }).length,
                failed: results.filter(function (r) { return !r.pass; }).length,
                total: results.length
            };
        });
    }

    Cellar.selftest = { run: run, tests: tests };

    // node: node js/cellar-selftest.js
    if (typeof module !== 'undefined' && require.main === module) {
        run().then(function (s) {
            s.results.forEach(function (r) {
                if (r.pass) {
                    console.log('  ✓ ' + r.name + ' (' + r.ms + 'ms)');
                } else {
                    console.log('  ✗ ' + r.name + '\n      ' +
                                String(r.error).replace(/\n/g, '\n      '));
                }
            });
            console.log('\n' + s.passed + '/' + s.total + ' passed, ' + s.failed + ' failed');
            process.exit(s.failed ? 1 : 0);
        });
    }

})(typeof window !== 'undefined' ? window : globalThis);
