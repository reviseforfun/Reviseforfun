'use strict';
/**
 * ReviseForFun storage – SQLite through Node's built-in `node:sqlite`
 * (DatabaseSync, Node 22.13+). No npm dependencies.
 *
 *   new Db('./.data/rff.sqlite')   file database (WAL)
 *   new Db(':memory:')             in-memory (tests)
 *
 * The study document is *not* stored as one blob: cards, notes, quizzes and
 * tombstones live in their own rows keyed by (user_id, id), and the scalar
 * part of the document lives in user_state.json. That makes /api/sync a
 * row-level diff – a device that changed nothing writes nothing – and lets the
 * leaderboard be a plain SQL query over the denormalised users columns.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const Core = require('../js/core');

const SCHEMA_VERSION = 2;
const MAX_SESSIONS = 10;

// ---------------------------------------------------------------- migrations
const MIGRATIONS = [
    {
        version: 1,
        up: (db) => db.exec(`
            CREATE TABLE users (
                id                  TEXT PRIMARY KEY,
                username            TEXT NOT NULL,
                username_lower      TEXT NOT NULL UNIQUE,
                email               TEXT,
                email_lower         TEXT,
                email_verified      INTEGER NOT NULL DEFAULT 0,
                password_hash       TEXT NOT NULL,
                recovery_hash       TEXT,
                created_at          INTEGER NOT NULL,
                show_on_leaderboard INTEGER NOT NULL DEFAULT 1,
                failed_logins       INTEGER NOT NULL DEFAULT 0,
                locked_until        INTEGER NOT NULL DEFAULT 0,
                xp                  INTEGER NOT NULL DEFAULT 0,
                level               INTEGER NOT NULL DEFAULT 1,
                streak              INTEGER NOT NULL DEFAULT 0,
                card_count          INTEGER NOT NULL DEFAULT 0,
                last_sync           INTEGER NOT NULL DEFAULT 0
            );
            -- An address may only be *claimed* (verified) by one account, but any
            -- number of accounts can hold it while it is still unverified.
            CREATE UNIQUE INDEX users_email_verified ON users(email_lower) WHERE email_verified = 1;

            CREATE TABLE sessions (
                token_hash TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL,
                last_used  INTEGER NOT NULL DEFAULT 0,
                device     TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX sessions_user ON sessions(user_id, created_at);

            CREATE TABLE tokens (
                token_hash TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                kind       TEXT NOT NULL CHECK (kind IN ('verify', 'reset')),
                email      TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL,
                expires_at INTEGER NOT NULL
            );
            CREATE INDEX tokens_user ON tokens(user_id, kind, created_at DESC);

            CREATE TABLE cards (
                user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                id            TEXT NOT NULL,
                subject       TEXT NOT NULL DEFAULT 'General',
                front         TEXT NOT NULL,
                back          TEXT NOT NULL,
                deck_id       TEXT,
                starred       INTEGER NOT NULL DEFAULT 0,
                created_at    INTEGER NOT NULL DEFAULT 0,
                updated_at    INTEGER NOT NULL DEFAULT 0,
                ease          REAL NOT NULL DEFAULT 2.5,
                interval_days INTEGER NOT NULL DEFAULT 0,
                reps          INTEGER NOT NULL DEFAULT 0,
                lapses        INTEGER NOT NULL DEFAULT 0,
                due           INTEGER NOT NULL DEFAULT 0,
                last_review   INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, id)
            );

            CREATE TABLE notes (
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                id         TEXT NOT NULL,
                title      TEXT NOT NULL DEFAULT '',
                content    TEXT NOT NULL DEFAULT '',
                subject    TEXT NOT NULL DEFAULT '',
                created_at INTEGER NOT NULL DEFAULT 0,
                updated_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, id)
            );

            CREATE TABLE quizzes (
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                id         TEXT NOT NULL,
                subject    TEXT NOT NULL DEFAULT 'All Subjects',
                mode       TEXT NOT NULL DEFAULT 'choice',
                score      INTEGER NOT NULL DEFAULT 0,
                total      INTEGER NOT NULL DEFAULT 0,
                percentage INTEGER NOT NULL DEFAULT 0,
                date       INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, id)
            );

            CREATE TABLE tombstones (
                user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                id      TEXT NOT NULL,
                ts      INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (user_id, id)
            );

            CREATE TABLE user_state (
                user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
                json       TEXT NOT NULL DEFAULT '{}',
                updated_at INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE shares (
                code       TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title      TEXT NOT NULL DEFAULT '',
                cards      TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX shares_user ON shares(user_id, created_at DESC);
        `),
    },
    {
        version: 2,
        up: (db) => db.exec(`
            CREATE TABLE challenges (
                code       TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                title      TEXT NOT NULL DEFAULT '',
                cards      TEXT NOT NULL DEFAULT '[]',
                created_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX challenges_user ON challenges(user_id, created_at DESC);

            CREATE TABLE challenge_results (
                code       TEXT NOT NULL REFERENCES challenges(code) ON DELETE CASCADE,
                user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                score      INTEGER NOT NULL DEFAULT 0,
                total      INTEGER NOT NULL DEFAULT 0,
                time_ms    INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (code, user_id)
            );
            CREATE INDEX challenge_results_board ON challenge_results(code, score DESC, time_ms ASC);
        `),
    },
];

// ------------------------------------------------------------------ utilities
const bool = (v) => (v ? 1 : 0);
const int = (v) => (Number.isFinite(Number(v)) ? Math.trunc(Number(v)) : 0);

/** BEGIN IMMEDIATE / COMMIT / ROLLBACK, and safe to nest. */
function makeTx(db) {
    let depth = 0;
    return function tx(fn) {
        if (depth > 0) {
            depth += 1;
            try {
                return fn();
            } finally {
                depth -= 1;
            }
        }
        db.exec('BEGIN IMMEDIATE');
        depth = 1;
        try {
            const out = fn();
            db.exec('COMMIT');
            return out;
        } catch (err) {
            try { db.exec('ROLLBACK'); } catch { /* the transaction is already gone */ }
            throw err;
        } finally {
            depth = 0;
        }
    };
}

class Db {
    constructor(dbPath = ':memory:', options = {}) {
        this.path = dbPath;
        if (dbPath !== ':memory:') {
            fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
        }
        this.db = new DatabaseSync(dbPath);
        this.stmt = new Map();
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec('PRAGMA busy_timeout = 5000');
        if (dbPath !== ':memory:') {
            this.db.exec('PRAGMA journal_mode = WAL');
            this.db.exec('PRAGMA synchronous = NORMAL');
        }
        this.migrate();
        this.tx = makeTx(this.db);
        this.options = options;
    }

    // ---------------------------------------------------------------- plumbing
    q(sql) {
        let s = this.stmt.get(sql);
        if (!s) { s = this.db.prepare(sql); this.stmt.set(sql, s); }
        return s;
    }

    migrate() {
        let version = int(this.db.prepare('PRAGMA user_version').get().user_version);
        for (const m of MIGRATIONS) {
            if (version >= m.version) continue;
            const tx = makeTx(this.db);
            tx(() => {
                m.up(this.db);
                this.db.exec(`PRAGMA user_version = ${m.version}`);
            });
            version = m.version;
        }
        this.userVersion = version;
        return version;
    }

    get schemaVersion() { return SCHEMA_VERSION; }

    journalMode() {
        const row = this.db.prepare('PRAGMA journal_mode').get();
        return String(row.journal_mode || '');
    }

    foreignKeysOn() { return int(this.db.prepare('PRAGMA foreign_keys').get().foreign_keys) === 1; }

    /** Rows changed since the connection opened – used to prove the sync diff. */
    totalChanges() { return int(this.db.prepare('SELECT total_changes() AS n').get().n); }

    close() {
        this.stmt.clear();
        try { this.db.close(); } catch { /* already closed */ }
    }

    // ------------------------------------------------------------------- users
    createUser(u) {
        this.q(`INSERT INTO users (id, username, username_lower, email, email_lower, email_verified,
                password_hash, recovery_hash, created_at, show_on_leaderboard, failed_logins, locked_until,
                xp, level, streak, card_count, last_sync)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            u.id, u.username, String(u.username).toLowerCase(), u.email || null,
            u.email ? String(u.email).toLowerCase() : null, bool(u.emailVerified),
            u.passwordHash, u.recoveryHash || null, int(u.createdAt),
            u.showOnLeaderboard === false ? 0 : 1, 0, 0, 0, 1, 0, 0, 0,
        );
        return this.getUser(u.id);
    }

    getUser(id) {
        const row = this.q('SELECT * FROM users WHERE id = ?').get(id);
        return row ? userFromRow(row) : null;
    }

    getUserByName(name) {
        const row = this.q('SELECT * FROM users WHERE username_lower = ?').get(String(name || '').toLowerCase());
        return row ? userFromRow(row) : null;
    }

    /** Only a *verified* address may be used to sign in. */
    getUserByVerifiedEmail(email) {
        const row = this.q('SELECT * FROM users WHERE email_lower = ? AND email_verified = 1')
            .get(String(email || '').toLowerCase());
        return row ? userFromRow(row) : null;
    }

    findVerifiedEmailOwner(emailLower, exceptId = null) {
        const row = this.q('SELECT * FROM users WHERE email_lower = ? AND email_verified = 1 AND id <> ?')
            .get(String(emailLower || '').toLowerCase(), exceptId || '');
        return row ? userFromRow(row) : null;
    }

    updateUser(id, patch) {
        // column -> how to coerce the value
        const COLUMNS = {
            username: (v) => String(v),
            usernameLower: (v) => String(v).toLowerCase(),
            email: (v) => (v ? String(v) : null),
            emailLower: (v) => (v ? String(v).toLowerCase() : null),
            emailVerified: (v) => bool(v),
            passwordHash: (v) => String(v),
            recoveryHash: (v) => (v ? String(v) : null),
            showOnLeaderboard: (v) => bool(v),
            failedLogins: int,
            lockedUntil: int,
            xp: int,
            level: int,
            streak: int,
            cardCount: int,
            lastSync: int,
        };
        const fields = [];
        const values = [];
        const p = { ...patch };
        // keep the lookup columns in step with the display values
        if ('username' in p && !('usernameLower' in p)) p.usernameLower = String(p.username).toLowerCase();
        if ('email' in p && !('emailLower' in p)) p.emailLower = p.email ? String(p.email).toLowerCase() : null;
        for (const [key, coerce] of Object.entries(COLUMNS)) {
            if (!(key in p)) continue;
            const column = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
            fields.push(`${column} = ?`);
            values.push(coerce(p[key]));
        }
        if (!fields.length) return this.getUser(id);
        values.push(id);
        this.q(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        return this.getUser(id);
    }

    deleteUser(id) { this.q('DELETE FROM users WHERE id = ?').run(id); }

    countUsers() { return int(this.q('SELECT COUNT(*) AS n FROM users').get().n); }

    /** The leaderboard is a query over the denormalised columns. */
    leaderboard(limit = 20) {
        const rows = this.q(`SELECT username, xp, level, streak FROM users
            WHERE show_on_leaderboard = 1 AND xp > 0
            ORDER BY xp DESC, created_at ASC, username ASC LIMIT ?`).all(int(limit));
        return rows.map((r, i) => ({ rank: i + 1, username: r.username, xp: int(r.xp), level: int(r.level), streak: int(r.streak) }));
    }

    // ---------------------------------------------------------------- sessions
    createSession({ tokenHash, userId, device = '', now = Date.now(), ttl }) {
        return this.tx(() => {
            this.q('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_used, device) VALUES (?,?,?,?,?,?)')
                .run(tokenHash, userId, int(now), int(now + ttl), int(now), String(device).slice(0, 160));
            this.pruneSessions(userId, now);
            return this.getSession(tokenHash);
        });
    }

    /** At most MAX_SESSIONS per user – the oldest ones go first. */
    pruneSessions(userId, now = Date.now()) {
        this.q('DELETE FROM sessions WHERE expires_at <= ?').run(int(now));
        const rows = this.q('SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, token_hash DESC')
            .all(userId);
        for (const r of rows.slice(MAX_SESSIONS)) this.q('DELETE FROM sessions WHERE token_hash = ?').run(r.token_hash);
        return rows.length - Math.min(rows.length, MAX_SESSIONS);
    }

    getSession(tokenHash) {
        const row = this.q('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash);
        return row ? { ...row } : null;
    }

    touchSession(tokenHash, now = Date.now()) {
        this.q('UPDATE sessions SET last_used = ? WHERE token_hash = ?').run(int(now), tokenHash);
    }

    deleteSession(tokenHash) { this.q('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); }

    deleteSessionsForUser(userId, { except = null } = {}) {
        if (except) this.q('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, except);
        else this.q('DELETE FROM sessions WHERE user_id = ?').run(userId);
    }

    listSessions(userId, currentHash = null) {
        return this.q('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(userId)
            .map((r) => ({
                id: String(r.token_hash).slice(0, 16),
                device: r.device || '',
                createdAt: int(r.created_at),
                lastUsed: int(r.last_used),
                expiresAt: int(r.expires_at),
                current: currentHash === r.token_hash,
            }));
    }

    /** `id` is the first 16 characters of the token hash. */
    deleteSessionByShortId(userId, shortId) {
        const hash = `${shortId}%`;
        const row = this.q('SELECT token_hash FROM sessions WHERE user_id = ? AND token_hash LIKE ?').get(userId, hash);
        if (!row) return false;
        this.q('DELETE FROM sessions WHERE token_hash = ?').run(row.token_hash);
        return true;
    }

    purgeExpiredSessions(now = Date.now()) {
        this.q('DELETE FROM sessions WHERE expires_at <= ?').run(int(now));
    }

    // ------------------------------------------------------------------ tokens
    /** Only the newest token per (user, kind) ever works – older ones are dropped. */
    createToken({ tokenHash, userId, kind, email = '', now = Date.now(), ttl }) {
        return this.tx(() => {
            this.q("DELETE FROM tokens WHERE user_id = ? AND kind = ?").run(userId, kind);
            this.q('INSERT INTO tokens (token_hash, user_id, kind, email, created_at, expires_at) VALUES (?,?,?,?,?,?)')
                .run(tokenHash, userId, kind, email || '', int(now), int(now + ttl));
            return this.getToken(tokenHash);
        });
    }

    getToken(tokenHash) {
        const row = this.q('SELECT * FROM tokens WHERE token_hash = ?').get(tokenHash);
        return row ? { ...row, createdAt: int(row.created_at), expiresAt: int(row.expires_at), userId: row.user_id } : null;
    }

    newestToken(userId, kind) {
        const row = this.q('SELECT * FROM tokens WHERE user_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1')
            .get(userId, kind);
        return row ? { ...row } : null;
    }

    deleteToken(tokenHash) { this.q('DELETE FROM tokens WHERE token_hash = ?').run(tokenHash); }

    // ------------------------------------------------------- study data tables
    cardsForUser(userId) {
        return this.q('SELECT * FROM cards WHERE user_id = ? ORDER BY rowid').all(userId).map(cardFromRow);
    }

    notesForUser(userId) {
        return this.q('SELECT * FROM notes WHERE user_id = ? ORDER BY rowid').all(userId).map(noteFromRow);
    }

    quizzesForUser(userId) {
        return this.q('SELECT * FROM quizzes WHERE user_id = ? ORDER BY date, rowid').all(userId).map(quizFromRow);
    }

    tombstonesForUser(userId) {
        const out = {};
        for (const r of this.q('SELECT id, ts FROM tombstones WHERE user_id = ?').all(userId)) out[r.id] = int(r.ts);
        return out;
    }

    getState(userId) {
        const row = this.q('SELECT * FROM user_state WHERE user_id = ?').get(userId);
        return row ? { json: row.json, updatedAt: int(row.updated_at) } : null;
    }

    setState(userId, state, updatedAt) {
        this.q(`INSERT INTO user_state (user_id, json, updated_at) VALUES (?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`)
            .run(userId, JSON.stringify(state), int(updatedAt));
    }

    /** Rebuilds the whole study document for a user from the rows. */
    buildDoc(userId) {
        const state = this.getState(userId);
        const flashcards = this.cardsForUser(userId);
        const notes = this.notesForUser(userId);
        const quizHistory = this.quizzesForUser(userId);
        const deleted = this.tombstonesForUser(userId);
        if (!state && !flashcards.length && !notes.length && !quizHistory.length && !Object.keys(deleted).length) return null;
        let parsed = {};
        try { parsed = state ? JSON.parse(state.json) : {}; } catch { parsed = {}; }
        const doc = { ...Core.defaultData(), ...parsed, flashcards, notes, quizHistory, deleted };
        return doc;
    }

    /**
     * Writes a merged document back, touching only the rows that actually
     * changed. Returns the number of SQLite row changes (0 = nothing to do).
     */
    writeDoc(userId, doc, now = Date.now()) {
        const before = this.totalChanges();
        this.tx(() => {
            // ---- cards
            const have = new Map(this.cardsForUser(userId).map((c) => [c.id, c]));
            for (const c of doc.flashcards || []) {
                const old = have.get(c.id);
                if (!old) insertCard(this, userId, c);
                else if (!sameCard(old, c)) updateCard(this, userId, c);
                have.delete(c.id);
            }
            for (const id of have.keys()) this.q('DELETE FROM cards WHERE user_id = ? AND id = ?').run(userId, id);

            // ---- notes
            const haveNotes = new Map(this.notesForUser(userId).map((n) => [n.id, n]));
            for (const n of doc.notes || []) {
                const old = haveNotes.get(n.id);
                if (!old) insertNote(this, userId, n);
                else if (!sameNote(old, n)) updateNote(this, userId, n);
                haveNotes.delete(n.id);
            }
            for (const id of haveNotes.keys()) this.q('DELETE FROM notes WHERE user_id = ? AND id = ?').run(userId, id);

            // ---- quiz history
            const haveQuiz = new Map(this.quizzesForUser(userId).map((q) => [q.id, q]));
            for (const q of doc.quizHistory || []) {
                const old = haveQuiz.get(q.id);
                if (!old) insertQuiz(this, userId, q);
                else if (!sameQuiz(old, q)) updateQuiz(this, userId, q);
                haveQuiz.delete(q.id);
            }
            for (const id of haveQuiz.keys()) this.q('DELETE FROM quizzes WHERE user_id = ? AND id = ?').run(userId, id);

            // ---- tombstones
            const haveTomb = this.tombstonesForUser(userId);
            const want = doc.deleted || {};
            for (const [id, ts] of Object.entries(want)) {
                if (!(id in haveTomb)) this.q('INSERT INTO tombstones (user_id, id, ts) VALUES (?,?,?)').run(userId, id, int(ts));
                else if (int(haveTomb[id]) !== int(ts)) this.q('UPDATE tombstones SET ts = ? WHERE user_id = ? AND id = ?').run(int(ts), userId, id);
                delete haveTomb[id];
            }
            for (const id of Object.keys(haveTomb)) this.q('DELETE FROM tombstones WHERE user_id = ? AND id = ?').run(userId, id);

            // ---- scalar state + denormalised user columns
            const state = docState(doc);
            const json = JSON.stringify(state);
            const current = this.getState(userId);
            if (!current || current.json !== json) this.setState(userId, state, doc.updatedAt);

            const user = this.getUser(userId);
            const level = Core.levelInfo(doc.xp).level;
            const cards = (doc.flashcards || []).length;
            const changed = this.totalChanges() - before;
            if (user && (int(user.xp) !== int(doc.xp) || int(user.level) !== level
                || int(user.streak) !== int(doc.streak) || int(user.cardCount) !== cards || changed > 0)) {
                this.updateUser(userId, { xp: doc.xp, level, streak: doc.streak, cardCount: cards, lastSync: now });
            }
        });
        return this.totalChanges() - before;
    }

    // ------------------------------------------------------------------ shares
    putShare(share) {
        this.q(`INSERT INTO shares (code, user_id, title, cards, created_at) VALUES (?,?,?,?,?)
            ON CONFLICT(code) DO UPDATE SET user_id = excluded.user_id, title = excluded.title,
                cards = excluded.cards, created_at = excluded.created_at`)
            .run(share.code, share.userId, share.title, JSON.stringify(share.cards), int(share.createdAt));
        return this.getShare(share.code);
    }

    getShare(code) { return shareFromRow(this.q('SELECT * FROM shares WHERE code = ?').get(code), this); }

    deleteShare(code) { this.q('DELETE FROM shares WHERE code = ?').run(code); }

    sharesByUser(userId) {
        return this.q('SELECT * FROM shares WHERE user_id = ? ORDER BY created_at DESC').all(userId)
            .map((r) => shareFromRow(r, this));
    }

    // -------------------------------------------------------------- challenges
    putChallenge(ch) {
        this.q(`INSERT INTO challenges (code, user_id, title, cards, created_at) VALUES (?,?,?,?,?)
            ON CONFLICT(code) DO UPDATE SET user_id = excluded.user_id, title = excluded.title,
                cards = excluded.cards, created_at = excluded.created_at`)
            .run(ch.code, ch.userId, ch.title, JSON.stringify(ch.cards), int(ch.createdAt));
        return this.getChallenge(ch.code);
    }

    getChallenge(code) { return challengeFromRow(this.q('SELECT * FROM challenges WHERE code = ?').get(code), this); }

    deleteChallenge(code) { this.q('DELETE FROM challenges WHERE code = ?').run(code); }

    challengesByUser(userId) {
        const rows = this.q(`SELECT c.*, (SELECT COUNT(*) FROM challenge_results r WHERE r.code = c.code) AS players,
                (SELECT COUNT(*) FROM challenge_results r WHERE r.code = c.code AND r.user_id = c.user_id) AS played
            FROM challenges c WHERE c.user_id = ? ORDER BY c.created_at DESC`).all(userId);
        return rows.map((r) => ({ ...challengeFromRow(r, this), players: int(r.players), playedByMe: int(r.played) > 0 }));
    }

    countChallenges(userId) {
        return int(this.q('SELECT COUNT(*) AS n FROM challenges WHERE user_id = ?').get(userId).n);
    }

    resultsFor(code, limit = 20) {
        const rows = this.q(`SELECT r.*, u.username FROM challenge_results r
            JOIN users u ON u.id = r.user_id
            WHERE r.code = ? ORDER BY r.score DESC, r.time_ms ASC, r.created_at ASC LIMIT ?`)
            .all(code, int(limit));
        return rows.map((r, i) => ({
            rank: i + 1, username: r.username, score: int(r.score), total: int(r.total),
            timeMs: int(r.time_ms), createdAt: int(r.created_at),
        }));
    }

    resultFor(code, userId) {
        const row = this.q('SELECT * FROM challenge_results WHERE code = ? AND user_id = ?').get(code, userId);
        return row ? { score: int(row.score), total: int(row.total), timeMs: int(row.time_ms), createdAt: int(row.created_at) } : null;
    }

    /** Keeps each player's best attempt (highest score, then fastest). */
    saveResult({ code, userId, score, total, timeMs, now = Date.now() }) {
        const best = this.resultFor(code, userId);
        const better = !best || score > best.score || (score === best.score && timeMs < best.timeMs);
        if (better) {
            this.q(`INSERT INTO challenge_results (code, user_id, score, total, time_ms, created_at) VALUES (?,?,?,?,?,?)
                ON CONFLICT(code, user_id) DO UPDATE SET score = excluded.score, total = excluded.total,
                    time_ms = excluded.time_ms, created_at = excluded.created_at`)
                .run(code, userId, int(score), int(total), int(timeMs), int(now));
        }
        return { improved: better, best: this.resultFor(code, userId) };
    }
}

// --------------------------------------------------------------- row mapping
function userFromRow(r) {
    return {
        id: r.id,
        username: r.username,
        usernameLower: r.username_lower,
        email: r.email || null,
        emailLower: r.email_lower || null,
        emailVerified: int(r.email_verified) === 1,
        passwordHash: r.password_hash,
        recoveryHash: r.recovery_hash || null,
        createdAt: int(r.created_at),
        showOnLeaderboard: int(r.show_on_leaderboard) === 1,
        failedLogins: int(r.failed_logins),
        lockedUntil: int(r.locked_until),
        xp: int(r.xp),
        level: int(r.level),
        streak: int(r.streak),
        cardCount: int(r.card_count),
        lastSync: int(r.last_sync),
    };
}

function cardFromRow(r) {
    const card = {
        id: r.id,
        subject: r.subject,
        front: r.front,
        back: r.back,
        starred: int(r.starred) === 1,
        createdAt: int(r.created_at),
        updatedAt: int(r.updated_at),
        ease: Number(r.ease),
        interval: int(r.interval_days),
        reps: int(r.reps),
        lapses: int(r.lapses),
        due: int(r.due),
        lastReview: int(r.last_review),
    };
    if (r.deck_id) card.deckId = r.deck_id;
    return card;
}

const cardValues = (userId, c) => [
    userId, c.id, c.subject || 'General', c.front, c.back, c.deckId || null, bool(c.starred),
    int(c.createdAt), int(c.updatedAt), Number(c.ease) || 2.5, int(c.interval), int(c.reps),
    int(c.lapses), int(c.due), int(c.lastReview),
];

const CARD_COLUMNS = `(user_id, id, subject, front, back, deck_id, starred, created_at, updated_at,
    ease, interval_days, reps, lapses, due, last_review)`;

function insertCard(db, userId, c) {
    db.q(`INSERT INTO cards ${CARD_COLUMNS} VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...cardValues(userId, c));
}

function updateCard(db, userId, c) {
    db.q(`UPDATE cards SET subject=?, front=?, back=?, deck_id=?, starred=?, created_at=?, updated_at=?,
        ease=?, interval_days=?, reps=?, lapses=?, due=?, last_review=? WHERE user_id=? AND id=?`)
        .run(...cardValues(userId, c).slice(2), userId, c.id);
}

function sameCard(row, c) {
    return row.subject === (c.subject || 'General') && row.front === c.front && row.back === c.back
        && (row.deckId || null) === (c.deckId || null) && Boolean(row.starred) === Boolean(c.starred)
        && int(row.createdAt) === int(c.createdAt) && int(row.updatedAt) === int(c.updatedAt)
        && Number(row.ease) === Number(c.ease || 2.5) && int(row.interval) === int(c.interval)
        && int(row.reps) === int(c.reps) && int(row.lapses) === int(c.lapses)
        && int(row.due) === int(c.due) && int(row.lastReview) === int(c.lastReview);
}

function noteFromRow(r) {
    return {
        id: r.id, title: r.title, content: r.content, subject: r.subject,
        createdAt: int(r.created_at), updatedAt: int(r.updated_at),
    };
}

const noteValues = (userId, n) => [userId, n.id, n.title || '', n.content || '', n.subject || '', int(n.createdAt), int(n.updatedAt)];

function insertNote(db, userId, n) {
    db.q('INSERT INTO notes (user_id, id, title, content, subject, created_at, updated_at) VALUES (?,?,?,?,?,?,?)')
        .run(...noteValues(userId, n));
}

function updateNote(db, userId, n) {
    db.q('UPDATE notes SET title=?, content=?, subject=?, created_at=?, updated_at=? WHERE user_id=? AND id=?')
        .run(...noteValues(userId, n).slice(2), userId, n.id);
}

function sameNote(row, n) {
    return row.title === (n.title || '') && row.content === (n.content || '') && row.subject === (n.subject || '')
        && int(row.createdAt) === int(n.createdAt) && int(row.updatedAt) === int(n.updatedAt);
}

function quizFromRow(r) {
    return {
        id: r.id, subject: r.subject, mode: r.mode, score: int(r.score), total: int(r.total),
        percentage: int(r.percentage), date: int(r.date),
    };
}

const quizValues = (userId, q) => [userId, q.id, q.subject || 'All Subjects', q.mode || 'choice',
    int(q.score), int(q.total), int(q.percentage), int(q.date)];

function insertQuiz(db, userId, q) {
    db.q('INSERT INTO quizzes (user_id, id, subject, mode, score, total, percentage, date) VALUES (?,?,?,?,?,?,?,?)')
        .run(...quizValues(userId, q));
}

function updateQuiz(db, userId, q) {
    db.q('UPDATE quizzes SET subject=?, mode=?, score=?, total=?, percentage=?, date=? WHERE user_id=? AND id=?')
        .run(...quizValues(userId, q).slice(2), userId, q.id);
}

function sameQuiz(row, q) {
    return row.subject === (q.subject || 'All Subjects') && row.mode === (q.mode || 'choice')
        && int(row.score) === int(q.score) && int(row.total) === int(q.total)
        && int(row.percentage) === int(q.percentage) && int(row.date) === int(q.date);
}

function shareFromRow(row, db) {
    if (!row) return null;
    const author = db.getUser(row.user_id);
    let cards = [];
    try { cards = JSON.parse(row.cards); } catch { cards = []; }
    return {
        code: row.code, userId: row.user_id, author: author ? author.username : '',
        title: row.title, cards, createdAt: int(row.created_at),
    };
}

function challengeFromRow(row, db) {
    if (!row) return null;
    const author = db.getUser(row.user_id);
    let cards = [];
    try { cards = JSON.parse(row.cards); } catch { cards = []; }
    return {
        code: row.code, userId: row.user_id, author: author ? author.username : '',
        title: row.title, cards, createdAt: int(row.created_at),
    };
}

/** The scalar part of a study document (everything that is not a row table). */
function docState(doc) {
    const { flashcards, notes, quizHistory, deleted, ...state } = doc; // eslint-disable-line no-unused-vars
    return state;
}

function openDb({ dbPath, dataDir } = {}) {
    let file = dbPath;
    if (!file) {
        const dir = dataDir || path.join(process.cwd(), '.data');
        file = path.join(dir, 'rff.sqlite');
    }
    return new Db(file);
}

module.exports = { Db, openDb, MIGRATIONS, SCHEMA_VERSION, MAX_SESSIONS, docState };
