'use strict';
/**
 * Tiny dependency-free persistence layer.
 *
 *  - <dataDir>/db.json          users, sessions and shared decks
 *  - <dataDir>/docs/<id>.json   one study-data document per user
 *
 * Writes are atomic (temp file + rename) and debounced. Pass dir = null for a
 * purely in-memory store (used by the tests).
 */
const fs = require('node:fs');
const path = require('node:path');

class Store {
    constructor(dir) {
        this.dir = dir;
        this.db = { users: {}, sessions: {}, shares: {} };
        this.docs = new Map();
        this.timer = null;
        this.dirty = false;
        if (dir) {
            fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
            const file = path.join(dir, 'db.json');
            if (fs.existsSync(file)) {
                this.db = { users: {}, sessions: {}, shares: {}, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
            }
        }
    }

    // ----- users -----
    findUserByName(name) {
        const lower = String(name).toLowerCase();
        return Object.values(this.db.users).find((u) => u.usernameLower === lower) || null;
    }
    getUser(id) { return this.db.users[id] || null; }
    putUser(user) { this.db.users[user.id] = user; this.touch(); }
    deleteUser(id) {
        delete this.db.users[id];
        for (const [h, s] of Object.entries(this.db.sessions)) if (s.userId === id) delete this.db.sessions[h];
        for (const [c, s] of Object.entries(this.db.shares)) if (s.userId === id) delete this.db.shares[c];
        this.docs.delete(id);
        if (this.dir) fs.rmSync(this.docFile(id), { force: true });
        this.touch();
    }
    allUsers() { return Object.values(this.db.users); }

    // ----- sessions -----
    getSession(hash) { return this.db.sessions[hash] || null; }
    putSession(hash, session) {
        this.db.sessions[hash] = session;
        // keep at most 10 sessions per user (drop oldest)
        const mine = Object.entries(this.db.sessions)
            .filter(([, s]) => s.userId === session.userId)
            .sort((a, b) => a[1].createdAt - b[1].createdAt);
        while (mine.length > 10) delete this.db.sessions[mine.shift()[0]];
        this.touch();
    }
    deleteSession(hash) { delete this.db.sessions[hash]; this.touch(); }
    purgeExpiredSessions(now = Date.now()) {
        for (const [h, s] of Object.entries(this.db.sessions)) if (s.expiresAt <= now) delete this.db.sessions[h];
        this.touch();
    }

    // ----- shares -----
    getShare(code) { return this.db.shares[code] || null; }
    putShare(share) { this.db.shares[share.code] = share; this.touch(); }
    deleteShare(code) { delete this.db.shares[code]; this.touch(); }
    sharesByUser(id) { return Object.values(this.db.shares).filter((s) => s.userId === id); }

    // ----- per-user documents -----
    docFile(id) { return path.join(this.dir, 'docs', `${id}.json`); }
    getDoc(id) {
        if (this.docs.has(id)) return this.docs.get(id);
        if (this.dir && fs.existsSync(this.docFile(id))) {
            const doc = JSON.parse(fs.readFileSync(this.docFile(id), 'utf8'));
            this.docs.set(id, doc);
            return doc;
        }
        return null;
    }
    putDoc(id, doc) {
        this.docs.set(id, doc);
        if (this.dir) this.writeAtomic(this.docFile(id), JSON.stringify(doc));
    }

    // ----- persistence -----
    touch() {
        this.dirty = true;
        if (!this.dir || this.timer) return;
        this.timer = setTimeout(() => this.flush(), 200);
        this.timer.unref();
    }
    writeAtomic(file, text) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, text);
        fs.renameSync(tmp, file);
    }
    flush() {
        clearTimeout(this.timer);
        this.timer = null;
        if (!this.dir || !this.dirty) return;
        this.dirty = false;
        this.writeAtomic(path.join(this.dir, 'db.json'), JSON.stringify(this.db));
    }
}

module.exports = { Store };
