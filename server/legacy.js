'use strict';
/**
 * One-time import of the 2.x JSON store (<dataDir>/db.json plus
 * <dataDir>/docs/<userId>.json) into SQLite.
 *
 * It runs only when the users table is empty, and the old file is renamed to
 * db.json.migrated afterwards so it can never be imported twice.
 */
const fs = require('node:fs');
const path = require('node:path');

const { sanitizeDoc } = require('./sanitize');

function importLegacy(db, dataDir) {
    const result = { imported: false, users: 0, sessions: 0, shares: 0, docs: 0 };
    if (!dataDir) return result;
    const file = path.join(dataDir, 'db.json');
    if (!fs.existsSync(file)) return result;
    if (db.countUsers() > 0) return { ...result, skipped: 'the users table is not empty' };

    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
        return { ...result, error: `could not read db.json: ${err.message}` };
    }

    const users = raw && typeof raw.users === 'object' ? raw.users : {};
    const sessions = raw && typeof raw.sessions === 'object' ? raw.sessions : {};
    const shares = raw && typeof raw.shares === 'object' ? raw.shares : {};

    db.tx(() => {
        for (const u of Object.values(users)) {
            if (!u || typeof u.id !== 'string' || typeof u.username !== 'string') continue;
            if (db.getUser(u.id)) continue;
            db.createUser({
                id: u.id,
                username: u.username,
                email: u.email || null,
                emailVerified: Boolean(u.emailVerified),
                passwordHash: u.passwordHash || '',
                recoveryHash: u.recoveryHash || null,
                createdAt: Number(u.createdAt) || Date.now(),
                showOnLeaderboard: u.showOnLeaderboard !== false,
            });
            const stats = u.stats && typeof u.stats === 'object' ? u.stats : {};
            db.updateUser(u.id, {
                xp: stats.xp, level: stats.level, streak: stats.streak, cardCount: stats.cards,
                failedLogins: u.failedLogins, lockedUntil: u.lockedUntil,
            });
            result.users += 1;
        }

        for (const [hash, s] of Object.entries(sessions)) {
            if (!s || !s.userId || !db.getUser(s.userId)) continue;
            db.q('INSERT OR IGNORE INTO sessions (token_hash, user_id, created_at, expires_at, last_used, device) VALUES (?,?,?,?,?,?)')
                .run(hash, s.userId, Number(s.createdAt) || 0, Number(s.expiresAt) || 0,
                    Number(s.createdAt) || 0, 'Imported session');
            result.sessions += 1;
        }

        for (const s of Object.values(shares)) {
            if (!s || !s.code || !s.userId || !db.getUser(s.userId)) continue;
            db.putShare({
                code: String(s.code), userId: s.userId, title: String(s.title || '').slice(0, 80),
                cards: Array.isArray(s.cards) ? s.cards : [], createdAt: Number(s.createdAt) || Date.now(),
            });
            result.shares += 1;
        }

        const docsDir = path.join(dataDir, 'docs');
        if (fs.existsSync(docsDir)) {
            for (const name of fs.readdirSync(docsDir)) {
                if (!name.endsWith('.json')) continue;
                const userId = name.slice(0, -'.json'.length);
                if (!db.getUser(userId)) continue;
                try {
                    const doc = JSON.parse(fs.readFileSync(path.join(docsDir, name), 'utf8'));
                    db.writeDoc(userId, sanitizeDoc(doc));
                    result.docs += 1;
                } catch { /* an unreadable document must not block the import */ }
            }
        }
    });

    fs.renameSync(file, `${file}.migrated`);
    return { ...result, imported: true, file };
}

module.exports = { importLegacy };
