'use strict';
const crypto = require('node:crypto');

const SESSION_TTL = 30 * 24 * 3600 * 1000;
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

// Used so that logins for unknown users take as long as for real ones.
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(store, userId, now = Date.now()) {
    const token = crypto.randomBytes(32).toString('base64url');
    store.putSession(sha256(token), { userId, createdAt: now, expiresAt: now + SESSION_TTL });
    return token;
}

function userFromToken(store, token, now = Date.now()) {
    if (!token) return null;
    const hash = sha256(token);
    const session = store.getSession(hash);
    if (!session) return null;
    if (session.expiresAt <= now) {
        store.deleteSession(hash);
        return null;
    }
    return store.getUser(session.userId);
}

function validateCredentials({ username, password }) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        return 'Username must be 3–20 characters: letters, numbers or underscores.';
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        return 'Password must be between 8 and 128 characters.';
    }
    return null;
}

module.exports = { hashPassword, verifyPassword, createSession, userFromToken, validateCredentials, sha256, DUMMY_HASH, SESSION_TTL };
