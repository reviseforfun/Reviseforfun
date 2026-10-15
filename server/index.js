'use strict';
/**
 * ReviseForFun backend – zero dependencies, Node 18+.
 *
 *   npm start            -> http://localhost:3000 (serves the app AND the API)
 *
 * Environment:
 *   PORT          port to listen on (default 3000)
 *   HOST          interface (default 0.0.0.0)
 *   DATA_DIR      where accounts / synced data are stored (default ./.data)
 *   CORS_ORIGIN   Access-Control-Allow-Origin value (default *)
 *   TRUST_PROXY   set to 1 to use X-Forwarded-For for rate limiting
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const Core = require('../js/core');
const { loadDecks, summarize } = require('../lib/decks');
const { Store } = require('./store');
const auth = require('./auth');
const { sanitizeDoc } = require('./sanitize');
const pkg = require('../package.json');

const ROOT = path.join(__dirname, '..');
const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
};
// Only these paths are ever served as static files.
const STATIC_FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js', 'data/library.json']);
const STATIC_DIRS = ['css/', 'js/', 'icons/'];

class HttpError extends Error {
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}

/** Sliding-window rate limiter keyed by string. */
class RateLimiter {
    constructor() { this.hits = new Map(); }
    check(key, limit, windowMs, now = Date.now()) {
        const list = (this.hits.get(key) || []).filter((t) => now - t < windowMs);
        if (list.length >= limit) {
            this.hits.set(key, list);
            return false;
        }
        list.push(now);
        this.hits.set(key, list);
        return true;
    }
    sweep(now = Date.now(), maxAge = 3600000) {
        for (const [k, list] of this.hits) {
            if (!list.length || now - list[list.length - 1] > maxAge) this.hits.delete(k);
        }
    }
}

const SHARE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)
function shareCode() {
    let out = '';
    for (const b of crypto.randomBytes(8)) out += SHARE_ALPHABET[b % SHARE_ALPHABET.length];
    return out;
}

function createApp(options = {}) {
    const store = options.store || new Store(options.dataDir === undefined ? path.join(ROOT, '.data') : options.dataDir);
    const decks = loadDecks();
    const deckById = new Map(decks.map((d) => [d.id, d]));
    const limiter = new RateLimiter();
    const corsOrigin = options.corsOrigin || process.env.CORS_ORIGIN || '*';
    const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
    const startedAt = Date.now();
    const publicUser = (u) => ({
        id: u.id,
        username: u.username,
        createdAt: u.createdAt,
        showOnLeaderboard: u.showOnLeaderboard !== false,
    });

    store.purgeExpiredSessions();
    const sweeper = setInterval(() => {
        limiter.sweep();
        store.purgeExpiredSessions();
    }, 600000);
    sweeper.unref();

    // ---------- helpers ----------
    function clientIp(req) {
        if (trustProxy && req.headers['x-forwarded-for']) return String(req.headers['x-forwarded-for']).split(',')[0].trim();
        return req.socket.remoteAddress || 'unknown';
    }

    function send(res, status, body, headers = {}) {
        const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(payload),
            'Cache-Control': 'no-store',
            ...headers,
        });
        res.end(payload);
    }

    function readJson(req, limit = 64 * 1024) {
        return new Promise((resolve, reject) => {
            const type = String(req.headers['content-type'] || '');
            if (!type.includes('application/json')) return reject(new HttpError(415, 'Content-Type must be application/json.'));
            const chunks = [];
            let size = 0;
            req.on('data', (c) => {
                size += c.length;
                if (size > limit) {
                    reject(new HttpError(413, 'Request body too large.'));
                    req.destroy();
                    return;
                }
                chunks.push(c);
            });
            req.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf8');
                    const parsed = text ? JSON.parse(text) : {};
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
                    resolve(parsed);
                } catch {
                    reject(new HttpError(400, 'Invalid JSON body.'));
                }
            });
            req.on('error', reject);
        });
    }

    function bearer(req) {
        const h = String(req.headers.authorization || '');
        return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    }

    function requireUser(req) {
        const user = auth.userFromToken(store, bearer(req));
        if (!user) throw new HttpError(401, 'Please log in.');
        return user;
    }

    function limit(req, bucket, max, windowMs) {
        if (!limiter.check(`${bucket}:${clientIp(req)}`, max, windowMs)) {
            throw new HttpError(429, 'Too many requests – please slow down and try again shortly.');
        }
    }

    // ---------- API routes ----------
    const routes = [];
    const route = (method, pattern, handler) => {
        const keys = [];
        const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
        routes.push({ method, re, keys, handler });
    };

    route('GET', '/api/health', async () => ({
        status: 200,
        body: {
            ok: true,
            name: pkg.name,
            version: pkg.version,
            decks: decks.length,
            cards: decks.reduce((n, d) => n + d.cardCount, 0),
            uptime: Math.round((Date.now() - startedAt) / 1000),
        },
    }));

    // --- preset library ---
    route('GET', '/api/decks', async (req, res, ctx) => {
        const q = (ctx.query.get('q') || '').toLowerCase().trim();
        const subject = ctx.query.get('subject') || '';
        let list = decks;
        if (subject) list = list.filter((d) => d.subject === subject);
        if (q) {
            list = list.filter((d) =>
                `${d.title} ${d.subject} ${d.description} ${d.level}`.toLowerCase().includes(q) ||
                d.cards.some((c) => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q)));
        }
        return {
            status: 200,
            body: { decks: list.map(summarize), subjects: [...new Set(decks.map((d) => d.subject))].sort() },
            headers: { 'Cache-Control': 'public, max-age=300' },
        };
    });

    route('GET', '/api/decks/:id', async (req, res, ctx) => {
        const deck = deckById.get(ctx.params.id);
        if (!deck) throw new HttpError(404, 'Deck not found.');
        return { status: 200, body: deck, headers: { 'Cache-Control': 'public, max-age=300' } };
    });

    // --- accounts ---
    route('POST', '/api/auth/register', async (req) => {
        limit(req, 'auth', 20, 10 * 60000);
        const body = await readJson(req);
        const problem = auth.validateCredentials(body);
        if (problem) throw new HttpError(400, problem);
        if (store.findUserByName(body.username)) throw new HttpError(409, 'That username is already taken.');
        const user = {
            id: crypto.randomUUID(),
            username: body.username,
            usernameLower: body.username.toLowerCase(),
            passwordHash: auth.hashPassword(body.password),
            createdAt: Date.now(),
            showOnLeaderboard: true,
            stats: { xp: 0, level: 1, streak: 0, cards: 0 },
        };
        store.putUser(user);
        const token = auth.createSession(store, user.id);
        return { status: 201, body: { token, user: publicUser(user) } };
    });

    route('POST', '/api/auth/login', async (req) => {
        limit(req, 'auth', 20, 10 * 60000);
        const body = await readJson(req);
        const user = typeof body.username === 'string' ? store.findUserByName(body.username) : null;
        const ok = auth.verifyPassword(String(body.password || ''), user ? user.passwordHash : auth.DUMMY_HASH);
        if (!user || !ok) throw new HttpError(401, 'Incorrect username or password.');
        return { status: 200, body: { token: auth.createSession(store, user.id), user: publicUser(user) } };
    });

    route('POST', '/api/auth/logout', async (req) => {
        const token = bearer(req);
        if (token) store.deleteSession(auth.sha256(token));
        return { status: 200, body: { ok: true } };
    });

    route('GET', '/api/auth/me', async (req) => ({ status: 200, body: { user: publicUser(requireUser(req)) } }));

    route('PATCH', '/api/auth/me', async (req) => {
        const user = requireUser(req);
        const body = await readJson(req);
        if (typeof body.showOnLeaderboard === 'boolean') user.showOnLeaderboard = body.showOnLeaderboard;
        store.putUser(user);
        return { status: 200, body: { user: publicUser(user) } };
    });

    route('DELETE', '/api/auth/account', async (req) => {
        limit(req, 'auth', 20, 10 * 60000);
        const user = requireUser(req);
        const body = await readJson(req);
        if (!auth.verifyPassword(String(body.password || ''), user.passwordHash)) {
            throw new HttpError(403, 'Password is incorrect.');
        }
        store.deleteUser(user.id);
        return { status: 200, body: { ok: true } };
    });

    // --- cloud sync ---
    route('GET', '/api/sync', async (req) => {
        const user = requireUser(req);
        return { status: 200, body: { data: store.getDoc(user.id) } };
    });

    route('PUT', '/api/sync', async (req) => {
        limit(req, 'sync', 120, 60000);
        const user = requireUser(req);
        const body = await readJson(req, 4 * 1024 * 1024);
        if (!body.data || typeof body.data !== 'object') throw new HttpError(400, 'Missing "data".');
        const incoming = sanitizeDoc(body.data);
        const existing = store.getDoc(user.id);
        const merged = sanitizeDoc(existing ? Core.mergeData(existing, incoming) : incoming);
        merged.updatedAt = Math.max(merged.updatedAt, Date.now());
        store.putDoc(user.id, merged);
        user.stats = {
            xp: merged.xp,
            level: Core.levelInfo(merged.xp).level,
            streak: merged.streak,
            cards: merged.flashcards.length,
        };
        store.putUser(user);
        return { status: 200, body: { data: merged, syncedAt: Date.now() } };
    });

    // --- leaderboard ---
    route('GET', '/api/leaderboard', async (req, res, ctx) => {
        const n = Math.min(Math.max(parseInt(ctx.query.get('limit'), 10) || 20, 1), 100);
        const rows = store
            .allUsers()
            .filter((u) => u.showOnLeaderboard !== false && u.stats && u.stats.xp > 0)
            .sort((a, b) => b.stats.xp - a.stats.xp || a.createdAt - b.createdAt)
            .slice(0, n)
            .map((u, i) => ({ rank: i + 1, username: u.username, xp: u.stats.xp, level: u.stats.level, streak: u.stats.streak }));
        return { status: 200, body: { leaderboard: rows }, headers: { 'Cache-Control': 'public, max-age=15' } };
    });

    // --- shared decks ---
    route('POST', '/api/share', async (req) => {
        limit(req, 'share', 20, 3600000);
        const user = requireUser(req);
        const body = await readJson(req, 512 * 1024);
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
        if (!title) throw new HttpError(400, 'A title is required.');
        if (!Array.isArray(body.cards) || !body.cards.length) throw new HttpError(400, 'Add at least one card to share.');
        if (body.cards.length > 500) throw new HttpError(400, 'You can share up to 500 cards at once.');
        const cards = body.cards
            .map((c) => ({
                front: typeof c?.front === 'string' ? c.front.trim().slice(0, 2000) : '',
                back: typeof c?.back === 'string' ? c.back.trim().slice(0, 2000) : '',
                subject: typeof c?.subject === 'string' ? c.subject.trim().slice(0, 60) : '',
            }))
            .filter((c) => c.front && c.back);
        if (!cards.length) throw new HttpError(400, 'No valid cards to share.');
        if (store.sharesByUser(user.id).length >= 25) throw new HttpError(400, 'You have reached the limit of 25 shared decks. Delete one first.');
        let code;
        do { code = shareCode(); } while (store.getShare(code));
        const share = { code, userId: user.id, author: user.username, title, cards, createdAt: Date.now() };
        store.putShare(share);
        return { status: 201, body: { code, title, cardCount: cards.length } };
    });

    route('GET', '/api/share', async (req) => {
        const user = requireUser(req);
        return {
            status: 200,
            body: { shares: store.sharesByUser(user.id).map((s) => ({ code: s.code, title: s.title, cardCount: s.cards.length, createdAt: s.createdAt })) },
        };
    });

    route('GET', '/api/share/:code', async (req, res, ctx) => {
        limit(req, 'share-get', 60, 60000);
        const share = store.getShare(ctx.params.code.toUpperCase());
        if (!share) throw new HttpError(404, 'No deck found with that code.');
        return { status: 200, body: { code: share.code, title: share.title, author: share.author, cards: share.cards, createdAt: share.createdAt } };
    });

    route('DELETE', '/api/share/:code', async (req, res, ctx) => {
        const user = requireUser(req);
        const share = store.getShare(ctx.params.code.toUpperCase());
        if (!share || share.userId !== user.id) throw new HttpError(404, 'Shared deck not found.');
        store.deleteShare(share.code);
        return { status: 200, body: { ok: true } };
    });

    // ---------- static files ----------
    function serveStatic(req, res, pathname) {
        let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
        if (rel === '') rel = 'index.html';
        const allowed = STATIC_FILES.has(rel) || STATIC_DIRS.some((d) => rel.startsWith(d));
        const file = path.resolve(ROOT, rel);
        if (!allowed || !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            return send(res, 404, { error: 'Not found.' });
        }
        const type = MIME[path.extname(file)] || 'application/octet-stream';
        const body = fs.readFileSync(file);
        res.writeHead(200, {
            'Content-Type': type,
            'Content-Length': body.length,
            'Cache-Control': rel === 'sw.js' || rel === 'index.html' ? 'no-cache' : 'public, max-age=300',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
    }

    // ---------- request handler ----------
    async function handler(req, res) {
        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;
        const securityHeaders = {
            'X-Content-Type-Options': 'nosniff',
            'X-Frame-Options': 'DENY',
            'Referrer-Policy': 'strict-origin-when-cross-origin',
        };
        for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);

        if (pathname.startsWith('/api/')) {
            res.setHeader('Access-Control-Allow-Origin', corsOrigin);
            res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
            res.setHeader('Access-Control-Max-Age', '600');
            if (req.method === 'OPTIONS') {
                res.writeHead(204);
                return res.end();
            }
            try {
                limit(req, 'api', 600, 60000);
                let matchedPath = false;
                for (const r of routes) {
                    const m = pathname.match(r.re);
                    if (!m) continue;
                    matchedPath = true;
                    if (r.method !== req.method) continue;
                    const params = {};
                    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
                    const out = await r.handler(req, res, { params, query: url.searchParams });
                    return send(res, out.status, out.body, out.headers);
                }
                throw new HttpError(matchedPath ? 405 : 404, matchedPath ? 'Method not allowed.' : 'Unknown API endpoint.');
            } catch (err) {
                if (!(err instanceof HttpError)) console.error(err);
                const status = err instanceof HttpError ? err.status : 500;
                return send(res, status, { error: err instanceof HttpError ? err.message : 'Internal server error.' });
            }
        }

        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed.' });
        try {
            return serveStatic(req, res, pathname);
        } catch {
            return send(res, 400, { error: 'Bad request.' });
        }
    }

    const server = http.createServer(handler);
    server.on('close', () => { clearInterval(sweeper); store.flush(); });
    return { server, store, handler };
}

if (require.main === module) {
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';
    const { server, store } = createApp({ dataDir: process.env.DATA_DIR || path.join(ROOT, '.data') });
    server.listen(port, host, () => console.log(`📚 ReviseForFun running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
    const shutdown = () => {
        console.log('Shutting down…');
        store.flush();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = { createApp };
