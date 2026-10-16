'use strict';
/**
 * Accounts primitives: password hashing (scrypt), opaque token hashing,
 * password policy, recovery codes and share/challenge codes.
 *
 * Nothing here touches the database – server/db.js owns persistence and
 * server/index.js owns the HTTP surface.
 */
const crypto = require('node:crypto');

const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30 days
const VERIFY_TTL = 24 * 3600 * 1000; // 24 hours
const RESET_TTL = 60 * 60 * 1000; // 1 hour

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/;
// No look-alikes (0/O, 1/I/L) so codes are easy to read out loud.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

const LOCKOUT_AFTER = 5; // wrong passwords
const LOCKOUT_MS = 5 * 60 * 1000; // …locks the account for 5 minutes

// A tiny blocklist: catches the passwords that actually get used.
const COMMON_PASSWORDS = new Set([
    'password', 'password1', 'password123', 'passw0rd', 'p@ssword', 'p@ssw0rd',
    '12345678', '123456789', '1234567890', '12345678910', '11111111', '00000000',
    'qwertyui', 'qwerty123', 'qwe123456', 'abc12345', 'abcd1234', 'abcdefg1',
    'letmein1', 'welcome1', 'welcome123', 'iloveyou', 'iloveyou1', 'princess1',
    'football1', 'baseball1', 'monkey123', 'dragon123', 'master1234', 'sunshine1',
    'superman1', 'batman123', 'starwars1', 'pokemon1', 'michael123', 'charlie123',
    'changeme1', 'whatever1', 'passpass', 'admin123', 'root1234', 'qwerty12345',
    'revision1', 'revision123', 'gcse2024', 'gcse2025', 'gcse2026', 'student123',
]);

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function hashPassword(password) {
    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(String(password), salt, 64);
    return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
    const [scheme, saltHex, hashHex] = String(stored || '').split('$');
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    let expected;
    try { expected = Buffer.from(hashHex, 'hex'); } catch { return false; }
    if (!expected.length) return false;
    const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

// Hashed once so that logins for unknown users cost the same CPU time.
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

/** Constant-time string comparison for recovery codes. */
function safeEqual(a, b) {
    const bufA = Buffer.from(String(a));
    const bufB = Buffer.from(String(b));
    if (bufA.length !== bufB.length) {
        crypto.timingSafeEqual(bufA, bufA); // keep the timing shape
        return false;
    }
    return crypto.timingSafeEqual(bufA, bufB);
}

function randomToken(bytes = 32) {
    return crypto.randomBytes(bytes).toString('base64url');
}

/** 8-character share / challenge code. */
function shareCode() {
    let out = '';
    for (const b of crypto.randomBytes(8)) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return out;
}

/** XXXX-XXXX-XXXX-XXXX – 16 characters from the same unambiguous alphabet. */
function recoveryCode() {
    let out = '';
    for (const b of crypto.randomBytes(16)) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
    return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12)}`;
}

/** Recovery codes are case/space/dash insensitive. */
function normalizeRecovery(input) {
    return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

const hashRecovery = (code) => sha256(normalizeRecovery(code));

function verifyRecovery(input, storedHash) {
    const normalized = normalizeRecovery(input);
    if (normalized.length !== 16 || !storedHash) return false;
    return safeEqual(sha256(normalized), storedHash);
}

/** Why this password is not good enough, or null when it is fine. */
function passwordProblem(password, username) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
        return 'Password must be between 8 and 128 characters.';
    }
    const lower = password.toLowerCase().replace(/\s+/g, '');
    if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(password.toLowerCase())) {
        return 'That password is too common – please pick something less guessable.';
    }
    if (username && lower.includes(String(username).toLowerCase()) && String(username).length >= 4) {
        return 'Your password must not contain your username.';
    }
    if (/^(.)\1{7,}$/.test(password)) return 'That password is too common – please pick something less guessable.';
    return null;
}

function usernameProblem(username) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        return 'Username must be 3–20 characters: letters, numbers or underscores.';
    }
    return null;
}

function emailProblem(email) {
    if (email === undefined || email === null || email === '') return null; // optional
    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || email.trim().length > 254) {
        return 'That does not look like a valid email address.';
    }
    return null;
}

/** Register / password-change validation in one place. */
function validateCredentials({ username, password, email }) {
    return usernameProblem(username) || passwordProblem(password, username) || emailProblem(email);
}

/** A short, non-identifying device label for the sessions list. */
function deviceLabel(userAgent) {
    const ua = String(userAgent || '').slice(0, 160);
    if (!ua) return 'Unknown device';
    const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera'
        : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome'
            : /Safari\//.test(ua) ? 'Safari' : /curl|node|fetch/i.test(ua) ? 'API client' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android'
        : /(iPhone|iPad|iPod)/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS'
            : /Linux/.test(ua) ? 'Linux' : '';
    return os ? `${browser} on ${os}` : browser;
}

module.exports = {
    SESSION_TTL, VERIFY_TTL, RESET_TTL, USERNAME_RE, EMAIL_RE, CODE_ALPHABET,
    LOCKOUT_AFTER, LOCKOUT_MS, COMMON_PASSWORDS,
    sha256, hashPassword, verifyPassword, DUMMY_HASH, safeEqual,
    randomToken, shareCode, recoveryCode, normalizeRecovery, hashRecovery, verifyRecovery,
    passwordProblem, usernameProblem, emailProblem, validateCredentials, deviceLabel,
};
