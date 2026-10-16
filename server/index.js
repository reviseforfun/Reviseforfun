'use strict';
/**
 * ReviseForFun backend – zero dependencies, Node 22.13+ (node:sqlite).
 *
 *   npm start            -> http://localhost:3000 (serves the app AND the API)
 *
 * Environment:
 *   PORT / HOST        where to listen (default 3000 / 0.0.0.0)
 *   DATA_DIR           where rff.sqlite lives (default ./.data)
 *   PUBLIC_URL         absolute URL of the app, used for email links ONLY
 *                      (default http://localhost:PORT). Never taken from the
 *                      Host or Origin header – those can be forged.
 *   MAIL_WEBHOOK_URL   POST {to,subject,text} here to really send email
 *   MAIL_WEBHOOK_TOKEN optional bearer token for the webhook
 *   CORS_ORIGIN        Access-Control-Allow-Origin value (default *)
 *   TRUST_PROXY        set to 1 to use X-Forwarded-For for rate limiting
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const Core = require('../js/core');
const { loadDecks, summarize } = require('../lib/decks');
const { Db } = require('./db');
const { importLegacy } = require('./legacy');
const auth = require('./auth');
const { createMailer, verificationMail, resetMail } = require('./mailer');
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

// Account endpoints that verify a secret: 20 attempts per 10 minutes per IP.
const AUTH_SENSITIVE = new Set([
    '/api/auth/register', '/api/auth/login', '/api/auth/logout-all', '/api/auth/password',
    '/api/auth/recovery-code', '/api/auth/email/verify', '/api/auth/email/resend',
    '/api/auth/forgot', '/api/auth/reset', '/api/auth/recover',
]);
const isAuthSensitive = (pathname, method) => AUTH_SENSITIVE.has(pathname)
    || (pathname === '/api/auth/account' && method === 'DELETE');

const FORGOT_REPLY = 'If that account exists and has a verified email address, a password reset link is on its way.';
const MAX_SHARES = 25;
const MAX_CHALLENGES = 25;
const MIN_CHALLENGE_SECONDS = 0.3; // per question – anything faster is a bot

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

function createApp(options = {}) {
    const port = Number(options.port || process.env.PORT) || 3000;
    const dataDir = options.dataDir !== undefined
        ? options.dataDir
        : (process.env.DATA_DIR || path.join(ROOT, '.data'));
    const dbPath = options.dbPath || (dataDir ? path.join(dataDir, 'rff.sqlite') : ':memory:');
    const db = options.db || new Db(dbPath);
    const mailer = options.mailer || createMailer({ silent: Boolean(options.silentMail) });
    const publicUrl = String(options.publicUrl || process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');

    const decks = loadDecks();
    const deckById = new Map(decks.map((d) => [d.id, d]));
    const limiter = new RateLimiter();
    const corsOrigin = options.corsOrigin || process.env.CORS_ORIGIN || '*';
    const trustProxy = options.trustProxy ?? process.env.TRUST_PROXY === '1';
    const startedAt = Date.now();

    // A 2.x JSON store next to the database is imported exactly once.
    const legacy = importLegacy(db, dataDir);
    if (legacy.imported) {
        console.log(`📥 Imported the old JSON store: ${legacy.users} users, ${legacy.sessions} sessions, `
            + `${legacy.shares} shares, ${legacy.docs} documents.`);
    } else if (legacy.error) {
        console.error(`⚠️  Legacy import failed: ${legacy.error}`);
    }

    const publicUser = (u) => ({
        id: u.id,
        username: u.username,
        createdAt: u.createdAt,
        showOnLeaderboard: u.showOnLeaderboard !== false,
        email: u.email || null,
        emailVerified: Boolean(u.emailVerified),
        hasRecoveryCode: Boolean(u.recoveryHash),
        stats: { xp: u.xp, level: u.level, streak: u.streak, cards: u.cardCount },
    });

    db.purgeExpiredSessions();
    const sweeper = setInterval(() => {
        limiter.sweep();
        db.purgeExpiredSessions();
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

    function sessionFrom(req, now = Date.now()) {
        const token = bearer(req);
        if (!token) return null;
        const tokenHash = auth.sha256(token);
        const session = db.getSession(tokenHash);
        if (!session) return null;
        if (Number(session.expires_at) <= now) {
            db.deleteSession(tokenHash);
            return null;
        }
        const user = db.getUser(session.user_id);
        if (!user) return null;
        // Only touch the row once a minute: it keeps the sync diff measurable.
        if (now - Number(session.last_used) > 60000) db.touchSession(tokenHash, now);
        return { user, tokenHash, session };
    }

    function requireUser(req) {
        const found = sessionFrom(req);
        if (!found) throw new HttpError(401, 'Please log in.');
        return found.user;
    }

    function requireSession(req) {
        const found = sessionFrom(req);
        if (!found) throw new HttpError(401, 'Please log in.');
        return found;
    }

    function limit(req, bucket, max, windowMs) {
        if (!limiter.check(`${bucket}:${clientIp(req)}`, max, windowMs)) {
            throw new HttpError(429, 'Too many requests – please slow down and try again shortly.');
        }
    }

    function newSessionFor(user, req) {
        const token = auth.randomToken(32);
        db.createSession({
            tokenHash: auth.sha256(token),
            userId: user.id,
            device: auth.deviceLabel(req.headers['user-agent']),
            now: Date.now(),
            ttl: auth.SESSION_TTL,
        });
        return token;
    }

    async function sendVerification(user, email) {
        const token = auth.randomToken(32);
        db.createToken({
            tokenHash: auth.sha256(token), userId: user.id, kind: 'verify', email,
            now: Date.now(), ttl: auth.VERIFY_TTL,
        });
        return mailer.send(verificationMail({ publicUrl, token, username: user.username, email }));
    }

    async function sendReset(user) {
        const token = auth.randomToken(32);
        db.createToken({
            tokenHash: auth.sha256(token), userId: user.id, kind: 'reset', email: user.email || '',
            now: Date.now(), ttl: auth.RESET_TTL,
        });
        return mailer.send(resetMail({ publicUrl, token, username: user.username, email: user.email }));
    }

    /** A token only works if it is the newest one of its kind and not expired. */
    function takeToken(rawToken, kind) {
        if (typeof rawToken !== 'string' || !rawToken) throw new HttpError(400, 'Missing token.');
        const tokenHash = auth.sha256(rawToken);
        const row = db.getToken(tokenHash);
        if (!row || row.kind !== kind) throw new HttpError(400, 'That link is not valid.');
        if (Number(row.expires_at) <= Date.now()) {
            db.deleteToken(tokenHash);
            throw new HttpError(400, 'That link has expired – please request a new one.');
        }
        const newest = db.newestToken(row.user_id, kind);
        if (!newest || newest.token_hash !== tokenHash) throw new HttpError(400, 'That link is no longer valid.');
        const user = db.getUser(row.user_id);
        if (!user) throw new HttpError(400, 'That link is not valid.');
        return { tokenHash, row, user };
    }

    const cleanCards = (list, max) => (Array.isArray(list) ? list : [])
        .slice(0, max)
        .map((c) => ({
            front: typeof c?.front === 'string' ? c.front.trim().slice(0, 2000) : '',
            back: typeof c?.back === 'string' ? c.back.trim().slice(0, 2000) : '',
            subject: typeof c?.subject === 'string' ? c.subject.trim().slice(0, 60) : '',
        }))
        .filter((c) => c.front && c.back);

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
            emailEnabled: mailer.enabled,
            publicUrl,
            storage: { driver: 'node:sqlite', schemaVersion: db.userVersion, database: dbPath === ':memory:' ? 'memory' : 'file' },
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
        const body = await readJson(req);
        // An address may be *held* by several accounts; it is only claimed by the
        // first one to verify it (see /api/auth/email/verify). Blank means none.
        const email = typeof body.email === 'string' && body.email.trim() ? body.email.trim() : null;
        const problem = auth.validateCredentials({ ...body, email });
        if (problem) throw new HttpError(400, problem);
        const username = String(body.username).trim();
        if (db.getUserByName(username)) throw new HttpError(409, 'That username is already taken.');

        const recovery = auth.recoveryCode();
        const user = db.createUser({
            id: crypto.randomUUID(),
            username,
            email,
            emailVerified: false,
            passwordHash: auth.hashPassword(body.password),
            recoveryHash: auth.hashRecovery(recovery),
            createdAt: Date.now(),
            showOnLeaderboard: true,
        });
        const token = newSessionFor(user, req);
        if (email) await sendVerification(user, email);
        return { status: 201, body: { token, user: publicUser(user), recoveryCode: recovery } };
    });

    route('POST', '/api/auth/login', async (req) => {
        const body = await readJson(req);
        const identifier = String(body.username ?? body.identifier ?? '').trim();
        const password = String(body.password ?? '');
        const user = db.getUserByName(identifier)
            || (auth.EMAIL_RE.test(identifier) ? db.getUserByVerifiedEmail(identifier) : null);
        // Always hash, so an unknown user costs exactly as much as a known one.
        const ok = auth.verifyPassword(password, user ? user.passwordHash : auth.DUMMY_HASH);

        if (user && Number(user.lockedUntil) > Date.now()) {
            const mins = Math.ceil((Number(user.lockedUntil) - Date.now()) / 60000);
            throw new HttpError(429, `Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`);
        }
        if (!user || !ok) {
            if (user) {
                const failed = Number(user.failedLogins) + 1;
                if (failed >= auth.LOCKOUT_AFTER) {
                    db.updateUser(user.id, { failedLogins: 0, lockedUntil: Date.now() + auth.LOCKOUT_MS });
                    throw new HttpError(429, `Too many failed attempts. Try again in ${Math.round(auth.LOCKOUT_MS / 60000)} minutes.`);
                }
                db.updateUser(user.id, { failedLogins: failed, lockedUntil: 0 });
            }
            throw new HttpError(401, 'Incorrect username or password.');
        }
        if (user.failedLogins || user.lockedUntil) db.updateUser(user.id, { failedLogins: 0, lockedUntil: 0 });
        const token = newSessionFor(user, req);
        return { status: 200, body: { token, user: publicUser(db.getUser(user.id)) } };
    });

    route('POST', '/api/auth/logout', async (req) => {
        const token = bearer(req);
        if (token) db.deleteSession(auth.sha256(token));
        return { status: 200, body: { ok: true } };
    });

    route('POST', '/api/auth/logout-all', async (req) => {
        const user = requireUser(req);
        db.deleteSessionsForUser(user.id);
        return { status: 200, body: { ok: true } };
    });

    route('GET', '/api/auth/me', async (req) => ({ status: 200, body: { user: publicUser(requireUser(req)) } }));

    route('PATCH', '/api/auth/me', async (req) => {
        const user = requireUser(req);
        const body = await readJson(req);
        if (typeof body.showOnLeaderboard === 'boolean') {
            db.updateUser(user.id, { showOnLeaderboard: body.showOnLeaderboard });
        }
        if ('email' in body) {
            if (!auth.verifyPassword(String(body.password || ''), user.passwordHash)) {
                throw new HttpError(403, 'Password is incorrect.');
            }
            const raw = body.email === null || String(body.email || '').trim() === '' ? null : String(body.email).trim();
            const problem = auth.emailProblem(raw);
            if (problem) throw new HttpError(400, problem);
            db.updateUser(user.id, { email: raw, emailVerified: false });
            if (raw) await sendVerification(db.getUser(user.id), raw);
        }
        return { status: 200, body: { user: publicUser(db.getUser(user.id)) } };
    });

    route('DELETE', '/api/auth/account', async (req) => {
        const user = requireUser(req);
        const body = await readJson(req);
        if (!auth.verifyPassword(String(body.password || ''), user.passwordHash)) {
            throw new HttpError(403, 'Password is incorrect.');
        }
        db.deleteUser(user.id); // cascades to every owned row
        return { status: 200, body: { ok: true } };
    });

    route('POST', '/api/auth/password', async (req) => {
        const { user, tokenHash } = requireSession(req);
        const body = await readJson(req);
        if (!auth.verifyPassword(String(body.oldPassword || ''), user.passwordHash)) {
            throw new HttpError(403, 'Your current password is incorrect.');
        }
        const problem = auth.passwordProblem(body.newPassword, user.username);
        if (problem) throw new HttpError(400, problem);
        db.updateUser(user.id, { passwordHash: auth.hashPassword(body.newPassword), failedLogins: 0, lockedUntil: 0 });
        db.deleteSessionsForUser(user.id, { except: tokenHash }); // other devices sign out
        return { status: 200, body: { ok: true, user: publicUser(db.getUser(user.id)) } };
    });

    route('POST', '/api/auth/recovery-code', async (req) => {
        const user = requireUser(req);
        const body = await readJson(req);
        if (!auth.verifyPassword(String(body.password || ''), user.passwordHash)) {
            throw new HttpError(403, 'Password is incorrect.');
        }
        const code = auth.recoveryCode();
        db.updateUser(user.id, { recoveryHash: auth.hashRecovery(code) });
        return { status: 200, body: { recoveryCode: code } };
    });

    route('POST', '/api/auth/email/resend', async (req) => {
        const user = requireUser(req);
        if (!user.email) throw new HttpError(400, 'Add an email address first.');
        const mail = await sendVerification(db.getUser(user.id), user.email);
        return { status: 200, body: { ok: true, delivered: mail.delivered } };
    });

    route('POST', '/api/auth/email/verify', async (req) => {
        const body = await readJson(req);
        const { tokenHash, row, user } = takeToken(body.token, 'verify');
        const email = row.email || user.email;
        const owner = db.findVerifiedEmailOwner(String(email).toLowerCase(), user.id);
        if (owner) {
            db.deleteToken(tokenHash); // the address is taken – this link is dead
            throw new HttpError(409, 'Another account has already verified that email address.');
        }
        db.updateUser(user.id, { email, emailVerified: true });
        db.deleteToken(tokenHash);
        return { status: 200, body: { ok: true, email } };
    });

    route('POST', '/api/auth/forgot', async (req) => {
        limit(req, 'forgot', 5, 3600000);
        const body = await readJson(req);
        const identifier = String(body.identifier || body.username || body.email || '').trim();
        if (identifier) limit(req, `forgot-id:${identifier.toLowerCase()}`, 3, 3600000);
        const user = identifier
            ? (db.getUserByName(identifier) || (auth.EMAIL_RE.test(identifier) ? db.getUserByVerifiedEmail(identifier) : null))
            : null;
        // Identical reply either way: this endpoint must not reveal who exists.
        if (user && user.emailVerified && user.email) await sendReset(db.getUser(user.id));
        else await new Promise((r) => setTimeout(r, 30)); // keep the timing similar
        return { status: 200, body: { ok: true, message: FORGOT_REPLY } };
    });

    route('POST', '/api/auth/reset', async (req) => {
        const body = await readJson(req);
        const { tokenHash, user } = takeToken(body.token, 'reset');
        // A rejected password must not burn the link – the student can retry.
        const problem = auth.passwordProblem(body.newPassword, user.username);
        if (problem) throw new HttpError(400, problem);
        db.updateUser(user.id, {
            passwordHash: auth.hashPassword(body.newPassword), failedLogins: 0, lockedUntil: 0,
        });
        db.deleteSessionsForUser(user.id); // every device signs out
        db.deleteToken(tokenHash); // single use
        return { status: 200, body: { ok: true } };
    });

    route('POST', '/api/auth/recover', async (req) => {
        const body = await readJson(req);
        const username = String(body.username || '').trim();
        const user = db.getUserByName(username);
        if (!user) auth.sha256(auth.normalizeRecovery(body.recoveryCode)); // same work, same timing
        const ok = Boolean(user) && auth.verifyRecovery(body.recoveryCode, user.recoveryHash);
        if (!user || !ok) throw new HttpError(403, 'That recovery code is not valid for this account.');
        const problem = auth.passwordProblem(body.newPassword, user.username);
        if (problem) throw new HttpError(400, problem);
        const code = auth.recoveryCode(); // the old one is burned
        db.updateUser(user.id, {
            passwordHash: auth.hashPassword(body.newPassword),
            recoveryHash: auth.hashRecovery(code),
            failedLogins: 0,
            lockedUntil: 0,
        });
        db.deleteSessionsForUser(user.id);
        const fresh = db.getUser(user.id);
        const token = newSessionFor(fresh, req);
        return { status: 200, body: { token, user: publicUser(fresh), recoveryCode: code } };
    });

    route('GET', '/api/auth/sessions', async (req) => {
        const { user, tokenHash } = requireSession(req);
        return { status: 200, body: { sessions: db.listSessions(user.id, tokenHash) } };
    });

    route('DELETE', '/api/auth/sessions/:id', async (req, res, ctx) => {
        const user = requireUser(req);
        const id = String(ctx.params.id || '').toLowerCase();
        if (!/^[0-9a-f]{16}$/.test(id)) throw new HttpError(404, 'No such device.');
        if (!db.deleteSessionByShortId(user.id, id)) throw new HttpError(404, 'No such device.');
        return { status: 200, body: { ok: true } };
    });

    // --- cloud sync ---
    route('GET', '/api/sync', async (req) => {
        const user = requireUser(req);
        return { status: 200, body: { data: db.buildDoc(user.id) } };
    });

    route('PUT', '/api/sync', async (req) => {
        limit(req, 'sync', 120, 60000);
        const user = requireUser(req);
        const body = await readJson(req, 4 * 1024 * 1024);
        if (!body.data || typeof body.data !== 'object') throw new HttpError(400, 'Missing "data".');
        const incoming = sanitizeDoc(body.data);
        const existing = db.buildDoc(user.id);
        // mergeData already keeps updatedAt at max(stored, incoming) – the server
        // must not push it higher, or "newest wins" would start favouring itself.
        const merged = sanitizeDoc(existing ? Core.mergeData(existing, incoming) : incoming);
        db.writeDoc(user.id, merged, Date.now());
        return { status: 200, body: { data: merged, syncedAt: Date.now() } };
    });

    // --- leaderboard ---
    route('GET', '/api/leaderboard', async (req, res, ctx) => {
        const n = Math.min(Math.max(parseInt(ctx.query.get('limit'), 10) || 20, 1), 100);
        return {
            status: 200,
            body: { leaderboard: db.leaderboard(n) },
            headers: { 'Cache-Control': 'public, max-age=15' },
        };
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
        const cards = cleanCards(body.cards, 500);
        if (!cards.length) throw new HttpError(400, 'No valid cards to share.');
        if (db.sharesByUser(user.id).length >= MAX_SHARES) {
            throw new HttpError(400, `You have reached the limit of ${MAX_SHARES} shared decks. Delete one first.`);
        }
        let code;
        do { code = auth.shareCode(); } while (db.getShare(code));
        db.putShare({ code, userId: user.id, title, cards, createdAt: Date.now() });
        return { status: 201, body: { code, title, cardCount: cards.length } };
    });

    route('GET', '/api/share', async (req) => {
        const user = requireUser(req);
        return {
            status: 200,
            body: {
                shares: db.sharesByUser(user.id)
                    .map((s) => ({ code: s.code, title: s.title, cardCount: s.cards.length, createdAt: s.createdAt })),
            },
        };
    });

    route('GET', '/api/share/:code', async (req, res, ctx) => {
        limit(req, 'share-get', 60, 60000);
        const share = db.getShare(String(ctx.params.code).toUpperCase());
        if (!share) throw new HttpError(404, 'No deck found with that code.');
        return {
            status: 200,
            body: { code: share.code, title: share.title, author: share.author, cards: share.cards, createdAt: share.createdAt },
        };
    });

    route('DELETE', '/api/share/:code', async (req, res, ctx) => {
        const user = requireUser(req);
        const share = db.getShare(String(ctx.params.code).toUpperCase());
        if (!share || share.userId !== user.id) throw new HttpError(404, 'Shared deck not found.');
        db.deleteShare(share.code);
        return { status: 200, body: { ok: true } };
    });

    // --- friend challenges ---
    route('POST', '/api/challenges', async (req) => {
        limit(req, 'challenge', 40, 3600000);
        const user = requireUser(req);
        const body = await readJson(req, 512 * 1024);
        const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
        if (!title) throw new HttpError(400, 'A title is required.');
        if (!Array.isArray(body.cards)) throw new HttpError(400, 'Add some cards to your challenge.');
        if (body.cards.length < 3) throw new HttpError(400, 'A challenge needs at least 3 cards.');
        if (body.cards.length > 50) throw new HttpError(400, 'A challenge can have at most 50 cards.');
        const cards = cleanCards(body.cards, 50);
        if (cards.length < 3) throw new HttpError(400, 'A challenge needs at least 3 valid cards.');
        if (db.countChallenges(user.id) >= MAX_CHALLENGES) {
            throw new HttpError(400, `You have reached the limit of ${MAX_CHALLENGES} challenges. Delete one first.`);
        }
        let code;
        do { code = auth.shareCode(); } while (db.getChallenge(code) || db.getShare(code));
        db.putChallenge({ code, userId: user.id, title, cards, createdAt: Date.now() });
        return { status: 201, body: { code, title, cardCount: cards.length } };
    });

    route('GET', '/api/challenges', async (req) => {
        const user = requireUser(req);
        return {
            status: 200,
            body: {
                challenges: db.challengesByUser(user.id)
                    .map((c) => ({ code: c.code, title: c.title, cardCount: c.cards.length, createdAt: c.createdAt, players: c.players })),
            },
        };
    });

    route('GET', '/api/challenges/:code', async (req, res, ctx) => {
        limit(req, 'challenge-get', 60, 60000);
        const challenge = db.getChallenge(String(ctx.params.code).toUpperCase());
        if (!challenge) throw new HttpError(404, 'No challenge found with that code.');
        return {
            status: 200,
            body: {
                code: challenge.code, title: challenge.title, author: challenge.author,
                cards: challenge.cards, createdAt: challenge.createdAt,
                results: db.resultsFor(challenge.code, 20),
            },
        };
    });

    route('POST', '/api/challenges/:code/results', async (req, res, ctx) => {
        limit(req, 'challenge-result', 60, 60000);
        const user = requireUser(req);
        const challenge = db.getChallenge(String(ctx.params.code).toUpperCase());
        if (!challenge) throw new HttpError(404, 'No challenge found with that code.');
        const body = await readJson(req);
        const total = Math.trunc(Number(body.total));
        const score = Math.trunc(Number(body.score));
        const timeMs = Math.trunc(Number(body.timeMs));
        if (!Number.isFinite(total) || total !== challenge.cards.length) {
            throw new HttpError(400, `This challenge has ${challenge.cards.length} questions.`);
        }
        if (!Number.isFinite(score) || score < 0 || score > total) throw new HttpError(400, 'Score is out of range.');
        if (!Number.isFinite(timeMs) || timeMs < 0 || timeMs > 24 * 3600000) throw new HttpError(400, 'Time is out of range.');
        if (timeMs < total * MIN_CHALLENGE_SECONDS * 1000) {
            throw new HttpError(400, 'That was suspiciously fast – take the challenge properly.');
        }
        const { best } = db.saveResult({ code: challenge.code, userId: user.id, score, total, timeMs, now: Date.now() });
        const results = db.resultsFor(challenge.code, 20);
        const mine = results.findIndex((r) => r.username === user.username);
        const rank = mine >= 0 ? mine + 1 : results.length + 1; // off the top 20
        return { status: 201, body: { results, rank, best } };
    });

    route('DELETE', '/api/challenges/:code', async (req, res, ctx) => {
        const user = requireUser(req);
        const challenge = db.getChallenge(String(ctx.params.code).toUpperCase());
        if (!challenge || challenge.userId !== user.id) throw new HttpError(404, 'Challenge not found.');
        db.deleteChallenge(challenge.code);
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
                // One IP bucket for the endpoints that check a secret, on top of
                // the endpoint-specific limits below. Reading /me or the session
                // list is not credential checking and must not be throttled.
                if (isAuthSensitive(pathname, req.method)) limit(req, 'auth', 20, 10 * 60000);
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
    server.on('close', () => { clearInterval(sweeper); db.close(); });
    return { server, db, mailer, handler, publicUrl, legacy };
}

if (require.main === module) {
    const port = Number(process.env.PORT) || 3000;
    const host = process.env.HOST || '0.0.0.0';
    const { server } = createApp({ port });
    server.listen(port, host, () => console.log(`📚 ReviseForFun running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
    const shutdown = () => {
        console.log('Shutting down…');
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 2000).unref();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}

module.exports = { createApp, FORGOT_REPLY, RATE_LIMITS: { auth: [20, 10 * 60000], forgot: [5, 3600000] } };
