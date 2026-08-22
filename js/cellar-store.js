/* cellar-store.js — storage adapters for the wine cellar app.
 *
 * The whole point of this file is that everything above it (cellar-app.js) never
 * learns which backend it is talking to. The contract:
 *
 *   name                          string, for the settings UI
 *   isConfigured()                bool
 *   verify()          -> { ok, detail, expiresAt }
 *   getDoc(name)      -> { data, rev }        missing file -> { skeleton, rev: null }
 *   putDoc(n,d,rev,m) -> { rev }              throws ConflictError on a stale rev
 *   getAll(names)     -> { name: { data, rev } }
 *   manifest()        -> { name: { rev, size } }
 *
 * `rev` is OPAQUE. GitHubStore makes it a blob SHA; a future LocalHttpStore will
 * make it an ETag. App code must never inspect it, and must never see the word
 * "sha". That is what makes the backend swappable without reprinting labels.
 *
 * Exposed as window.Cellar.store (classic script, no modules).
 */
(function (global) {
    'use strict';

    var Cellar = global.Cellar = global.Cellar || {};
    var model = Cellar.model;

    /* ------------------------------------------------------- base64/utf8 */

    // btoa throws InvalidCharacterError on any code point above U+00FF, and wine
    // data is wall-to-wall Château / Grüner / Nuits-Saint-Georges. Three separate
    // landmines are defused here; see selftest.html for the round-trip assertion.
    function utf8ToBase64(str) {
        var bytes = new TextEncoder().encode(str);      // 1. without this: mojibake
        var bin = '';
        var CHUNK = 0x8000;                             // 2. apply() on ~120KB throws RangeError
        for (var i = 0; i < bytes.length; i += CHUNK) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
        }
        return btoa(bin);
    }

    function base64ToUtf8(b64) {
        var bin = atob(String(b64).replace(/\s/g, ''));  // 3. GitHub embeds \n; atob throws on them
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new TextDecoder('utf-8').decode(bytes);
    }

    /* ---------------------------------------------------------- errors */

    function ConflictError(docName, currentRev, currentData) {
        var e = new Error('conflict on ' + docName);
        e.name = 'ConflictError';
        e.isConflict = true;
        e.docName = docName;
        e.currentRev = currentRev;
        e.currentData = currentData;
        return e;
    }

    function StoreError(message, kind, status) {
        var e = new Error(message);
        e.name = 'StoreError';
        e.kind = kind;              // auth | permission | notfound | ratelimit | network | server
        e.status = status || 0;
        return e;
    }

    function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

    /* ------------------------------------------------------- GitHubStore */

    function GitHubStore(cfg) {
        this.name = 'github';
        this.cfg = Object.assign({
            owner: '', repo: '', branch: 'main', basePath: 'data', token: ''
        }, cfg || {});
        this.tokenExpiresAt = null;
        this.rateLimit = null;
        // Simulate "PUT succeeded but the response was lost" — see selftest / §12.
        this.debugDropPutResponse = false;
    }

    GitHubStore.prototype.isConfigured = function () {
        return !!(this.cfg.owner && this.cfg.repo && this.cfg.token);
    };

    GitHubStore.prototype._path = function (docName) {
        var base = String(this.cfg.basePath || '').replace(/^\/+|\/+$/g, '');
        return (base ? base + '/' : '') + docName + '.json';
    };

    GitHubStore.prototype._url = function (docName) {
        return 'https://api.github.com/repos/' +
               encodeURIComponent(this.cfg.owner) + '/' +
               encodeURIComponent(this.cfg.repo) + '/contents/' +
               this._path(docName).split('/').map(encodeURIComponent).join('/');
    };

    GitHubStore.prototype._headers = function () {
        return {
            'Authorization': 'Bearer ' + this.cfg.token,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
    };

    GitHubStore.prototype._noteHeaders = function (res) {
        var exp = res.headers.get('github-authentication-token-expiration');
        // The only way the API tells you when a fine-grained PAT dies.
        if (exp) this.tokenExpiresAt = exp;
        var rem = res.headers.get('x-ratelimit-remaining');
        if (rem != null) {
            this.rateLimit = {
                remaining: parseInt(rem, 10),
                reset: parseInt(res.headers.get('x-ratelimit-reset') || '0', 10)
            };
        }
    };

    GitHubStore.prototype._fail = function (res, body) {
        var msg = (body && body.message) || res.statusText || ('HTTP ' + res.status);
        if (res.status === 401) {
            return StoreError('Token rejected by GitHub. Re-enter it in Settings.', 'auth', 401);
        }
        if (res.status === 403 || res.status === 429) {
            var rem = res.headers.get('x-ratelimit-remaining');
            if (rem === '0' || res.status === 429) {
                return StoreError('GitHub rate limit reached — will retry.', 'ratelimit', res.status);
            }
            return StoreError('Token lacks Contents write permission on ' +
                              this.cfg.owner + '/' + this.cfg.repo + '.', 'permission', 403);
        }
        if (res.status === 404) {
            // GitHub returns 404, not 403, for a private repo the token cannot
            // see — so "not found" and "not authorized" are indistinguishable here.
            return StoreError('Repo ' + this.cfg.owner + '/' + this.cfg.repo +
                              ' not found, or this token cannot see it.', 'notfound', 404);
        }
        return StoreError('GitHub: ' + msg, 'server', res.status);
    };

    GitHubStore.prototype._request = function (url, init) {
        var self = this;
        return fetch(url, init).then(function (res) {
            self._noteHeaders(res);
            return res;
        }, function (netErr) {
            throw StoreError('Network unreachable: ' + netErr.message, 'network', 0);
        });
    };

    GitHubStore.prototype.verify = function () {
        var self = this;
        if (!this.isConfigured()) {
            return Promise.resolve({ ok: false, detail: 'Owner, repo and token are all required.' });
        }
        var url = 'https://api.github.com/repos/' +
                  encodeURIComponent(this.cfg.owner) + '/' + encodeURIComponent(this.cfg.repo);
        return this._request(url, { headers: this._headers() }).then(function (res) {
            if (!res.ok) {
                return res.json().catch(function () { return null; }).then(function (b) {
                    var e = self._fail(res, b);
                    return { ok: false, detail: e.message, expiresAt: self.tokenExpiresAt };
                });
            }
            return res.json().then(function (repo) {
                var perms = repo.permissions || {};
                return {
                    ok: !!perms.push,
                    detail: perms.push
                        ? 'Connected to ' + repo.full_name +
                          (repo.private ? ' (private)' : ' (PUBLIC — this repo should be private!)')
                        : 'Reached ' + repo.full_name + ' but the token has read-only access. ' +
                          'It needs Contents: Read and write.',
                    expiresAt: self.tokenExpiresAt
                };
            });
        });
    };

    GitHubStore.prototype.getDoc = function (docName) {
        var self = this;
        var url = this._url(docName) + '?ref=' + encodeURIComponent(this.cfg.branch) +
                  '&t=' + Date.now();   // defeat any intermediary cache; we need truth
        return this._request(url, { headers: this._headers(), cache: 'no-store' })
            .then(function (res) {
                // A missing file is a normal first-run state, not an error: return a
                // skeleton with rev null, and the first PUT creates it. That is why
                // bootstrapping needs nothing but an empty repo.
                if (res.status === 404) {
                    return { data: model.skeleton(docName), rev: null };
                }
                if (!res.ok) {
                    return res.json().catch(function () { return null; })
                        .then(function (b) { throw self._fail(res, b); });
                }
                return res.json().then(function (body) {
                    if (body.encoding === 'none' || (!body.content && body.download_url)) {
                        // >1MB: the contents API stops inlining base64.
                        return fetch(body.download_url).then(function (r) { return r.text(); })
                            .then(function (text) {
                                return { data: JSON.parse(text), rev: body.sha };
                            });
                    }
                    return { data: JSON.parse(base64ToUtf8(body.content)), rev: body.sha };
                });
            });
    };

    GitHubStore.prototype.putDoc = function (docName, data, rev, message) {
        var self = this;
        var payload = {
            message: message || ('cellar: update ' + docName),
            content: utf8ToBase64(model.serialize(docName, data)),
            branch: this.cfg.branch
        };
        if (rev) payload.sha = rev;     // omitted on create

        return this._request(this._url(docName), {
            method: 'PUT',
            headers: Object.assign({ 'Content-Type': 'application/json' }, this._headers()),
            body: JSON.stringify(payload)
        }).then(function (res) {
            // GitHub uses 409 for most stale-sha cases and 422 for some; treat both
            // as "someone else wrote first". The 409 body does NOT carry current
            // content, so re-GET here and hand the caller a uniform ConflictError.
            if (res.status === 409 || res.status === 422) {
                return self.getDoc(docName).then(function (cur) {
                    throw ConflictError(docName, cur.rev, cur.data);
                });
            }
            if (!res.ok) {
                return res.json().catch(function () { return null; })
                    .then(function (b) { throw self._fail(res, b); });
            }
            if (self.debugDropPutResponse) {
                throw StoreError('debug: dropped PUT response', 'network', 0);
            }
            return res.json().then(function (body) {
                return { rev: body.content && body.content.sha };
            });
        });
    };

    GitHubStore.prototype.getAll = function (names) {
        var self = this;
        return Promise.all(names.map(function (n) {
            return self.getDoc(n).then(function (r) { return [n, r]; });
        })).then(function (pairs) {
            var out = {};
            pairs.forEach(function (p) { out[p[0]] = p[1]; });
            return out;
        });
    };

    GitHubStore.prototype.manifest = function () {
        var self = this;
        var base = String(this.cfg.basePath || '').replace(/^\/+|\/+$/g, '');
        var url = 'https://api.github.com/repos/' +
                  encodeURIComponent(this.cfg.owner) + '/' + encodeURIComponent(this.cfg.repo) +
                  '/contents/' + (base ? base.split('/').map(encodeURIComponent).join('/') : '') +
                  '?ref=' + encodeURIComponent(this.cfg.branch) + '&t=' + Date.now();
        return this._request(url, { headers: this._headers(), cache: 'no-store' })
            .then(function (res) {
                if (res.status === 404) return {};
                if (!res.ok) {
                    return res.json().catch(function () { return null; })
                        .then(function (b) { throw self._fail(res, b); });
                }
                return res.json().then(function (list) {
                    var out = {};
                    (list || []).forEach(function (f) {
                        var m = /^(.+)\.json$/.exec(f.name || '');
                        if (m) out[m[1]] = { rev: f.sha, size: f.size };
                    });
                    return out;
                });
            });
    };

    /* ------------------------------------------------------- MemoryStore */

    // Where almost all UI development happens: no network, no token, no risk.
    // Reached with ?store=memory.
    function MemoryStore(seed, opts) {
        this.name = 'memory';
        this.opts = Object.assign({ latencyMs: 120, failureRate: 0 }, opts || {});
        this.docs = {};
        var self = this;
        var state = seed || model.emptyState();
        model.DOCS.forEach(function (d) {
            self.docs[d] = { data: model.clone(state[d]), rev: 'r1' };
        });
        this._seq = 1;
    }

    MemoryStore.prototype.isConfigured = function () { return true; };

    MemoryStore.prototype._delay = function () {
        var self = this;
        return sleep(this.opts.latencyMs).then(function () {
            if (Math.random() < self.opts.failureRate) {
                throw StoreError('simulated network failure', 'network', 0);
            }
        });
    };

    MemoryStore.prototype.verify = function () {
        return Promise.resolve({ ok: true, detail: 'In-memory demo store (nothing is saved).',
                                 expiresAt: null });
    };

    MemoryStore.prototype.getDoc = function (docName) {
        var self = this;
        return this._delay().then(function () {
            var d = self.docs[docName];
            if (!d) return { data: model.skeleton(docName), rev: null };
            return { data: model.clone(d.data), rev: d.rev };
        });
    };

    MemoryStore.prototype.putDoc = function (docName, data, rev) {
        var self = this;
        return this._delay().then(function () {
            var d = self.docs[docName];
            if (d && d.rev !== rev) throw ConflictError(docName, d.rev, model.clone(d.data));
            // Round-trip through serialize so MemoryStore exercises the same
            // canonicalization path the real store does.
            var stored = JSON.parse(model.serialize(docName, data));
            var next = 'r' + (++self._seq);
            self.docs[docName] = { data: stored, rev: next };
            return { rev: next };
        });
    };

    MemoryStore.prototype.getAll = GitHubStore.prototype.getAll;

    MemoryStore.prototype.manifest = function () {
        var self = this;
        return this._delay().then(function () {
            var out = {};
            Object.keys(self.docs).forEach(function (n) {
                out[n] = { rev: self.docs[n].rev,
                           size: model.serialize(n, self.docs[n].data).length };
            });
            return out;
        });
    };

    /* -------------------------------------------------- LocalHttpStore */

    // Phase 5. Included now so the interface stays honest: if this can be written
    // against the same six methods, the adapter did its job.
    //   GET  {base}/doc/{name}   -> body + ETag
    //   PUT  {base}/doc/{name}   If-Match: <etag> -> 412 when stale
    //   GET  {base}/manifest     -> { name: {rev, size} }
    function LocalHttpStore(cfg) {
        this.name = 'local';
        this.cfg = Object.assign({ baseUrl: '' }, cfg || {});
    }

    LocalHttpStore.prototype.isConfigured = function () { return !!this.cfg.baseUrl; };

    LocalHttpStore.prototype._url = function (p) {
        return String(this.cfg.baseUrl).replace(/\/+$/, '') + p;
    };

    LocalHttpStore.prototype.verify = function () {
        var self = this;
        return fetch(this._url('/manifest')).then(function (res) {
            return { ok: res.ok,
                     detail: res.ok ? 'Connected to ' + self.cfg.baseUrl
                                    : 'HTTP ' + res.status + ' from ' + self.cfg.baseUrl,
                     expiresAt: null };
        }).catch(function (e) {
            return { ok: false, detail: 'Unreachable: ' + e.message, expiresAt: null };
        });
    };

    LocalHttpStore.prototype.getDoc = function (docName) {
        var self = this;
        return fetch(this._url('/doc/' + docName), { cache: 'no-store' }).then(function (res) {
            if (res.status === 404) return { data: model.skeleton(docName), rev: null };
            if (!res.ok) throw StoreError('HTTP ' + res.status + ' from local store', 'server', res.status);
            var rev = res.headers.get('ETag');
            return res.json().then(function (data) { return { data: data, rev: rev }; });
        }, function (e) {
            throw StoreError('Local store unreachable: ' + e.message, 'network', 0);
        });
    };

    LocalHttpStore.prototype.putDoc = function (docName, data, rev, message) {
        var self = this;
        var headers = { 'Content-Type': 'application/json' };
        if (rev) headers['If-Match'] = rev;
        if (message) headers['X-Cellar-Message'] = message;
        return fetch(this._url('/doc/' + docName), {
            method: 'PUT', headers: headers, body: model.serialize(docName, data)
        }).then(function (res) {
            if (res.status === 412) {
                return self.getDoc(docName).then(function (cur) {
                    throw ConflictError(docName, cur.rev, cur.data);
                });
            }
            if (!res.ok) throw StoreError('HTTP ' + res.status + ' from local store', 'server', res.status);
            return { rev: res.headers.get('ETag') };
        });
    };

    LocalHttpStore.prototype.getAll = GitHubStore.prototype.getAll;

    LocalHttpStore.prototype.manifest = function () {
        return fetch(this._url('/manifest'), { cache: 'no-store' })
            .then(function (res) { return res.ok ? res.json() : {}; });
    };

    /* ------------------------------------------------------------ export */

    Cellar.store = {
        GitHubStore: GitHubStore,
        MemoryStore: MemoryStore,
        LocalHttpStore: LocalHttpStore,
        ConflictError: ConflictError,
        StoreError: StoreError,
        utf8ToBase64: utf8ToBase64,
        base64ToUtf8: base64ToUtf8,
        sleep: sleep,

        create: function (kind, cfg) {
            if (kind === 'memory') return new MemoryStore(cfg && cfg.seed, cfg);
            if (kind === 'local')  return new LocalHttpStore(cfg);
            return new GitHubStore(cfg);
        }
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = Cellar.store;

})(typeof window !== 'undefined' ? window : globalThis);
