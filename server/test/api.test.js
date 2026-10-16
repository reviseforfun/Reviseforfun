'use strict';
/**
 * HTTP API tests. Every app runs on an in-memory SQLite database with the
 * mailer silenced, so the suite is fast, isolated and leaves nothing behind.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createApp, FORGOT_REPLY } = require('../index');
const Core = require('../../js/core');

const PUBLIC_URL = 'https://revise.example';
const PASSWORD = 'correct horse';

async function start(options = {}) {
    const opts = { dbPath: ':memory:', silentMail: true, publicUrl: PUBLIC_URL, ...options };
    if (options.dataDir && !options.dbPath) delete opts.dbPath; // use the real file
    const app = createApp(opts);
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const call = async (method, url, { body, token, headers } = {}) => {
        const res = await fetch(base + url, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...headers,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, json, text, headers: res.headers };
    };
    const close = () => new Promise((r) => app.server.close(r));
    return { ...app, base, call, close };
}

async function register(call, username = 'alice', password = PASSWORD, email) {
    const r = await call('POST', '/api/auth/register', { body: { username, password, ...(email ? { email } : {}) } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json;
}

async function registerToken(call, username = 'alice', password = PASSWORD) {
    return (await register(call, username, password)).token;
}

/** Pulls the token out of the last emailed link. */
function mailToken(app, kind = 'verify') {
    const mail = app.mailer.last();
    assert.ok(mail, 'an email was sent');
    const m = new RegExp(`#community\\?${kind}=([A-Za-z0-9_-]+)`).exec(mail.text);
    assert.ok(m, `the mail contains a ${kind} link`);
    return m[1];
}

async function verifiedUser(ctx, username = 'alice', email = 'alice@example.com') {
    const reg = await register(ctx.call, username, PASSWORD, email);
    const token = mailToken(ctx, 'verify');
    const v = await ctx.call('POST', '/api/auth/email/verify', { body: { token } });
    assert.equal(v.status, 200, JSON.stringify(v.json));
    return { ...reg, email };
}

// ------------------------------------------------------------------ basics
test('health and preset library', async () => {
    const ctx = await start();
    try {
        const health = await ctx.call('GET', '/api/health');
        assert.equal(health.status, 200);
        assert.ok(health.json.ok && health.json.decks >= 25 && health.json.cards > 500);
        assert.equal(health.json.emailEnabled, false, 'no webhook configured -> email is off');
        assert.equal(health.json.storage.driver, 'node:sqlite');
        assert.equal(health.json.publicUrl, PUBLIC_URL);

        const list = await ctx.call('GET', '/api/decks');
        assert.ok(list.json.decks.length >= 25);
        assert.ok(!('cards' in list.json.decks[0]), 'listing must not include cards');
        assert.ok(list.json.subjects.includes('Biology'));

        const bio = await ctx.call('GET', '/api/decks?subject=Biology');
        assert.ok(bio.json.decks.length >= 3 && bio.json.decks.every((d) => d.subject === 'Biology'));

        const search = await ctx.call('GET', '/api/decks?q=mitochondria');
        assert.ok(search.json.decks.some((d) => d.id === 'bio-cells'));

        const deck = await ctx.call('GET', '/api/decks/bio-cells');
        assert.equal(deck.json.cards.length, deck.json.cardCount);
        assert.equal((await ctx.call('GET', '/api/decks/nope')).status, 404);
    } finally { await ctx.close(); }
});

test('register / login / me / logout', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        assert.equal((await call('POST', '/api/auth/register', { body: { username: 'a', password: 'longenough' } })).status, 400);
        assert.equal((await call('POST', '/api/auth/register', { body: { username: 'bob', password: 'short' } })).status, 400);
        assert.equal((await call('POST', '/api/auth/register', { body: { username: 'bob', password: 'password123' } })).status, 400, 'common passwords are refused');
        assert.equal((await call('POST', '/api/auth/register', { body: { username: 'has space', password: PASSWORD } })).status, 400);

        const reg = await register(call, 'Alice');
        assert.match(reg.recoveryCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/, 'a recovery code is returned once');
        assert.equal((await call('POST', '/api/auth/register', { body: { username: 'alice', password: 'another pass' } })).status, 409, 'usernames are case-insensitive');

        const me = await call('GET', '/api/auth/me', { token: reg.token });
        assert.equal(me.json.user.username, 'Alice');
        assert.equal(me.json.user.email, null);
        assert.equal(me.json.user.emailVerified, false);
        assert.equal(me.json.user.hasRecoveryCode, true);
        assert.ok(!JSON.stringify(me.json).includes('passwordHash'));
        assert.ok(!JSON.stringify(me.json).includes('recoveryHash'));

        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong password' } })).status, 401);
        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'nobody', password: 'wrong password' } })).status, 401);
        const login = await call('POST', '/api/auth/login', { body: { username: 'ALICE', password: PASSWORD } });
        assert.equal(login.status, 200);
        assert.ok(login.json.token !== reg.token, 'a fresh session token');

        assert.equal((await call('POST', '/api/auth/logout', { token: login.json.token })).status, 200);
        assert.equal((await call('GET', '/api/auth/me', { token: login.json.token })).status, 401);
        assert.equal((await call('GET', '/api/auth/me')).status, 401);
        assert.equal((await call('GET', '/api/auth/me', { token: reg.token })).status, 200, 'other sessions stay valid');
    } finally { await ctx.close(); }
});

test('email is optional at registration', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const noEmail = await register(call, 'noemail');
        assert.equal(noEmail.user.email, null);
        assert.equal(ctx.mailer.outbox.length, 0, 'nothing is sent without an address');

        const withEmail = await register(call, 'withemail', PASSWORD, 'w@example.com');
        assert.equal(withEmail.user.email, 'w@example.com');
        assert.equal(withEmail.user.emailVerified, false);
        assert.equal(ctx.mailer.outbox.length, 1, 'one verification email');
        assert.match(ctx.mailer.last().text, /#community\?verify=/);

        const bad = await call('POST', '/api/auth/register', { body: { username: 'bademail', password: PASSWORD, email: 'not-an-email' } });
        assert.equal(bad.status, 400, 'a malformed address is rejected');
        assert.match(bad.json.error, /email/i);
        const blank = await call('POST', '/api/auth/register', { body: { username: 'blankemail', password: PASSWORD, email: '   ' } });
        assert.equal(blank.status, 201, 'a blank address is treated as none');
        assert.equal(blank.json.user.email, null);
    } finally { await ctx.close(); }
});

test('passwords, tokens and recovery codes are hashed at rest', async () => {
    const ctx = await start();
    try {
        const reg = await register(ctx.call, 'hasher', PASSWORD, 'hash@example.com');
        const row = ctx.db.db.prepare('SELECT * FROM users').all()[0];
        assert.match(row.password_hash, /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
        assert.ok(!row.password_hash.includes(PASSWORD));
        assert.match(row.recovery_hash, /^[0-9a-f]{64}$/, 'only a SHA-256 of the recovery code');
        assert.ok(!JSON.stringify(row).includes(reg.recoveryCode.replace(/-/g, '')));

        const sessions = ctx.db.db.prepare('SELECT * FROM sessions').all();
        assert.equal(sessions.length, 1);
        assert.match(sessions[0].token_hash, /^[0-9a-f]{64}$/, 'session tokens are stored as SHA-256');
        assert.ok(!JSON.stringify(sessions).includes(reg.token));

        const tokens = ctx.db.db.prepare('SELECT * FROM tokens').all();
        assert.equal(tokens.length, 1);
        assert.equal(tokens[0].kind, 'verify');
        assert.match(tokens[0].token_hash, /^[0-9a-f]{64}$/);
        assert.ok(!JSON.stringify(tokens).includes(mailToken(ctx, 'verify')));
    } finally { await ctx.close(); }
});

test('verify the address, then sign in with it', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const reg = await register(call, 'verifier', PASSWORD, 'v@example.com');
        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'v@example.com', password: PASSWORD } })).status, 401,
            'an unverified address cannot sign in');

        const token = mailToken(ctx, 'verify');
        assert.equal((await call('POST', '/api/auth/email/verify', { body: { token: 'nonsense' } })).status, 400);
        const v = await call('POST', '/api/auth/email/verify', { body: { token } });
        assert.equal(v.status, 200);
        assert.equal(v.json.email, 'v@example.com');
        assert.equal((await call('POST', '/api/auth/email/verify', { body: { token } })).status, 400, 'the link is single use');

        const me = await call('GET', '/api/auth/me', { token: reg.token });
        assert.equal(me.json.user.emailVerified, true);

        const login = await call('POST', '/api/auth/login', { body: { username: 'V@EXAMPLE.COM', password: PASSWORD } });
        assert.equal(login.status, 200, 'case-insensitive email login');
        assert.equal(login.json.user.email, 'v@example.com');

        // resending replaces the previous token
        await call('POST', '/api/auth/email/resend', { token: reg.token });
        const second = mailToken(ctx, 'verify');
        assert.ok(second !== token);
        assert.equal(ctx.mailer.outbox.length, 2);
    } finally { await ctx.close(); }
});

test('a verified address can only belong to one account', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        await verifiedUser(ctx, 'owner', 'shared@example.com');
        const second = await register(call, 'copycat', PASSWORD, 'shared@example.com');
        assert.equal(second.user.email, 'shared@example.com', 'holding an address is allowed');
        assert.equal(second.user.emailVerified, false);

        const token = mailToken(ctx, 'verify');
        const v = await call('POST', '/api/auth/email/verify', { body: { token } });
        assert.equal(v.status, 409, 'claiming it is not');
        assert.match(v.json.error, /already/i);

        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'shared@example.com', password: PASSWORD } })).json.user.username, 'owner');
        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'copycat', password: PASSWORD } })).status, 200, 'the username still works');

        // removing it from the first account frees it up
        const ownerLogin = await call('POST', '/api/auth/login', { body: { username: 'owner', password: PASSWORD } });
        const patched = await call('PATCH', '/api/auth/me', { token: ownerLogin.json.token, body: { email: null, password: PASSWORD } });
        assert.equal(patched.status, 200);
        assert.equal(patched.json.user.email, null);
        assert.equal(patched.json.user.emailVerified, false);
    } finally { await ctx.close(); }
});

test('forgot password: identical replies, real mail only for verified addresses', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const known = await verifiedUser(ctx, 'forgetful', 'f@example.com');
        const noMail = await register(call, 'nomail');

        ctx.mailer.outbox.length = 0;
        const a = await call('POST', '/api/auth/forgot', { body: { identifier: 'forgetful' } });
        const b = await call('POST', '/api/auth/forgot', { body: { identifier: 'f@example.com' } });
        const c = await call('POST', '/api/auth/forgot', { body: { identifier: 'nobody-here' } });
        const d = await call('POST', '/api/auth/forgot', { body: { identifier: '' } });
        for (const r of [a, b, c, d]) {
            assert.equal(r.status, 200);
            assert.deepEqual(r.json, { ok: true, message: FORGOT_REPLY }, 'the reply never reveals who exists');
        }
        assert.equal(ctx.mailer.outbox.length, 2, 'one mail per known+verified identifier');
        assert.ok(ctx.mailer.outbox.every((m) => m.to === 'f@example.com'));

        // no mail for an account without a verified address
        ctx.mailer.outbox.length = 0;
        await call('POST', '/api/auth/forgot', { body: { identifier: 'nomail' } });
        assert.equal(ctx.mailer.outbox.length, 0);
        assert.ok(noMail.token && known.token);

        // 3 per hour per identifier
        const limited = [];
        for (let i = 0; i < 4; i++) limited.push((await call('POST', '/api/auth/forgot', { body: { identifier: 'forgetful' } })).status);
        assert.ok(limited.includes(429), 'the per-identifier limit kicks in');
    } finally { await ctx.close(); }
});

test('reset: weak password keeps the link, then a single successful use', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const reg = await verifiedUser(ctx, 'resetter', 'r@example.com');
        const oldSession = reg.token;
        ctx.mailer.outbox.length = 0;
        await call('POST', '/api/auth/forgot', { body: { identifier: 'resetter' } });
        const token = mailToken(ctx, 'reset');

        const weak = await call('POST', '/api/auth/reset', { body: { token, newPassword: 'password123' } });
        assert.equal(weak.status, 400);

        const good = await call('POST', '/api/auth/reset', { body: { token, newPassword: 'a brand new secret' } });
        assert.equal(good.status, 200, JSON.stringify(good.json));

        assert.equal((await call('POST', '/api/auth/reset', { body: { token, newPassword: 'yet another secret' } })).status, 400, 'single use');
        assert.equal((await call('GET', '/api/auth/me', { token: oldSession })).status, 401, 'every session was revoked');
        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'resetter', password: PASSWORD } })).status, 401);
        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'r@example.com', password: 'a brand new secret' } })).status, 200);
    } finally { await ctx.close(); }
});

test('recovery code: burns the old one and issues a new one', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const reg = await register(call, 'recovering', PASSWORD);
        const first = reg.recoveryCode;

        assert.equal((await call('POST', '/api/auth/recover', { body: { username: 'recovering', recoveryCode: 'AAAA-BBBB-CCCC-DDDD', newPassword: 'a new secret' } })).status, 403);
        assert.equal((await call('POST', '/api/auth/recover', { body: { username: 'nobody', recoveryCode: first, newPassword: 'a new secret' } })).status, 403);

        const r = await call('POST', '/api/auth/recover', { body: { username: 'recovering', recoveryCode: first.toLowerCase().replace(/-/g, ' '), newPassword: 'a new secret' } });
        assert.equal(r.status, 200, 'formatting does not matter');
        assert.ok(r.json.recoveryCode && r.json.recoveryCode !== first, 'a fresh code is issued');
        assert.ok(r.json.token, 'and a session');
        assert.equal((await call('GET', '/api/auth/me', { token: r.json.token })).json.user.username, 'recovering');
        assert.equal((await call('GET', '/api/auth/me', { token: reg.token })).status, 401, 'old sessions are revoked');

        assert.equal((await call('POST', '/api/auth/recover', { body: { username: 'recovering', recoveryCode: first, newPassword: 'another secret' } })).status, 403, 'the old code is burned');
        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'recovering', password: 'a new secret' } })).status, 200);

        // replacing it while signed in
        const login = await call('POST', '/api/auth/login', { body: { username: 'recovering', password: 'a new secret' } });
        assert.equal((await call('POST', '/api/auth/recovery-code', { token: login.json.token, body: { password: 'wrong' } })).status, 403);
        const replaced = await call('POST', '/api/auth/recovery-code', { token: login.json.token, body: { password: 'a new secret' } });
        assert.equal(replaced.status, 200);
        assert.match(replaced.json.recoveryCode, /^[A-Z2-9-]{19}$/);
        assert.equal((await call('POST', '/api/auth/recover', { body: { username: 'recovering', recoveryCode: r.json.recoveryCode, newPassword: 'another secret' } })).status, 403, 'the code it replaced no longer works');
        assert.equal((await call('POST', '/api/auth/recover', { body: { username: 'recovering', recoveryCode: replaced.json.recoveryCode, newPassword: 'x' } })).status, 400, 'a weak password is refused');
        const again = await call('POST', '/api/auth/recover', { body: { username: 'recovering', recoveryCode: replaced.json.recoveryCode, newPassword: 'the newest secret' } });
        assert.equal(again.status, 200, 'and the refused attempt did not burn the code');
    } finally { await ctx.close(); }
});

test('lockout: five wrong passwords lock the account for five minutes', async () => {
    const ctx = await start();
    const { call, db } = ctx;
    try {
        await register(call, 'locked', PASSWORD);
        for (let i = 0; i < 4; i++) {
            const r = await call('POST', '/api/auth/login', { body: { username: 'locked', password: 'not it' } });
            assert.equal(r.status, 401);
        }
        assert.equal(db.getUserByName('locked').failedLogins, 4);

        const fifth = await call('POST', '/api/auth/login', { body: { username: 'locked', password: 'not it' } });
        assert.equal(fifth.status, 429);
        const locked = db.getUserByName('locked');
        assert.ok(locked.lockedUntil > Date.now());
        assert.ok(locked.lockedUntil - Date.now() <= 5 * 60 * 1000);
        assert.equal(locked.failedLogins, 0, 'the counter restarts after a lock');

        const rightPassword = await call('POST', '/api/auth/login', { body: { username: 'locked', password: PASSWORD } });
        assert.equal(rightPassword.status, 429, 'even the correct password is refused while locked');
        assert.match(rightPassword.json.error, /minute/);

        // once the lock expires the correct password works again
        db.updateUser(locked.id, { lockedUntil: Date.now() - 1 });
        const after = await call('POST', '/api/auth/login', { body: { username: 'locked', password: PASSWORD } });
        assert.equal(after.status, 200);
        assert.equal(db.getUserByName('locked').failedLogins, 0);
    } finally { await ctx.close(); }
});

test('change password, sessions list and logout-all', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const reg = await register(call, 'multi', PASSWORD);
        const second = await call('POST', '/api/auth/login', { body: { username: 'multi', password: PASSWORD }, headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1' } });
        const third = await call('POST', '/api/auth/login', { body: { username: 'multi', password: PASSWORD }, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120' } });

        const list = await call('GET', '/api/auth/sessions', { token: reg.token });
        assert.equal(list.status, 200);
        assert.equal(list.json.sessions.length, 3);
        assert.equal(list.json.sessions.filter((s) => s.current).length, 1);
        assert.ok(list.json.sessions.every((s) => /^[0-9a-f]{16}$/.test(s.id)), 'ids are hash prefixes');
        assert.ok(list.json.sessions.some((s) => /iPhone|iOS/.test(s.device)), 'a device label is kept');
        assert.ok(!JSON.stringify(list.json).includes(reg.token));

        const other = list.json.sessions.find((s) => !s.current);
        assert.equal((await call('DELETE', `/api/auth/sessions/${other.id}`, { token: reg.token })).status, 200);
        assert.equal((await call('DELETE', `/api/auth/sessions/${other.id}`, { token: reg.token })).status, 404);
        assert.equal((await call('DELETE', '/api/auth/sessions/zzzz', { token: reg.token })).status, 404);
        assert.equal((await call('GET', '/api/auth/sessions', { token: reg.token })).json.sessions.length, 2);

        // changing the password signs the other devices out
        assert.equal((await call('POST', '/api/auth/password', { token: reg.token, body: { oldPassword: 'wrong', newPassword: 'a new secret' } })).status, 403);
        assert.equal((await call('POST', '/api/auth/password', { token: reg.token, body: { oldPassword: PASSWORD, newPassword: 'password123' } })).status, 400);
        const changed = await call('POST', '/api/auth/password', { token: reg.token, body: { oldPassword: PASSWORD, newPassword: 'a new secret' } });
        assert.equal(changed.status, 200);
        assert.equal((await call('GET', '/api/auth/me', { token: reg.token })).status, 200, 'this device stays signed in');
        assert.equal((await call('GET', '/api/auth/me', { token: second.json.token })).status, 401, 'the others do not');
        assert.equal((await call('GET', '/api/auth/me', { token: third.json.token })).status, 401);
        const fresh = await call('POST', '/api/auth/login', { body: { username: 'multi', password: 'a new secret' } });
        assert.equal(fresh.status, 200);
        assert.equal((await call('GET', '/api/auth/sessions', { token: fresh.json.token })).json.sessions.length, 2,
            'this device plus the one that was signed in all along');
        assert.equal((await call('POST', '/api/auth/logout-all', { token: fresh.json.token })).status, 200);
        assert.equal((await call('GET', '/api/auth/me', { token: fresh.json.token })).status, 401);
        assert.equal((await call('GET', '/api/auth/me', { token: reg.token })).status, 401, 'every device is signed out');
        assert.equal((await call('POST', '/api/auth/logout-all')).status, 401);
    } finally { await ctx.close(); }
});

test('PATCH /api/auth/me: leaderboard opt-out and email changes need the password', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const reg = await register(call, 'patcher', PASSWORD);
        const off = await call('PATCH', '/api/auth/me', { token: reg.token, body: { showOnLeaderboard: false } });
        assert.equal(off.json.user.showOnLeaderboard, false);
        assert.equal((await call('PATCH', '/api/auth/me', { token: reg.token, body: { showOnLeaderboard: true } })).json.user.showOnLeaderboard, true);

        assert.equal((await call('PATCH', '/api/auth/me', { token: reg.token, body: { email: 'new@example.com' } })).status, 403, 'no password');
        assert.equal((await call('PATCH', '/api/auth/me', { token: reg.token, body: { email: 'nonsense', password: PASSWORD } })).status, 400);
        ctx.mailer.outbox.length = 0;
        const set = await call('PATCH', '/api/auth/me', { token: reg.token, body: { email: 'new@example.com', password: PASSWORD } });
        assert.equal(set.status, 200);
        assert.equal(set.json.user.email, 'new@example.com');
        assert.equal(set.json.user.emailVerified, false, 'a new address starts unverified');
        assert.equal(ctx.mailer.outbox.length, 1, 'a verification mail goes out');

        const token = mailToken(ctx, 'verify');
        assert.equal((await call('POST', '/api/auth/email/verify', { body: { token } })).status, 200);
        assert.equal((await call('GET', '/api/auth/me', { token: reg.token })).json.user.emailVerified, true);

        const cleared = await call('PATCH', '/api/auth/me', { token: reg.token, body: { email: '', password: PASSWORD } });
        assert.equal(cleared.json.user.email, null);
        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'new@example.com', password: PASSWORD } })).status, 401);
        assert.equal((await call('POST', '/api/auth/email/resend', { token: reg.token })).status, 400, 'nothing to resend');
    } finally { await ctx.close(); }
});

// -------------------------------------------------------------------- sync
test('sync requires auth, merges data and sanitises input', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        assert.equal((await call('GET', '/api/sync')).status, 401);
        const token = await registerToken(call);
        assert.equal((await call('GET', '/api/sync', { token })).json.data, null);

        const dev1 = { ...Core.defaultData(), updatedAt: 100, xp: 120,
            flashcards: [{ id: 'c1', front: 'Q1', back: 'A1', subject: 'Bio', updatedAt: 100 }] };
        const put1 = await call('PUT', '/api/sync', { token, body: { data: dev1 } });
        assert.equal(put1.status, 200);
        assert.equal(put1.json.data.flashcards.length, 1);

        const dev2 = { ...Core.defaultData(), updatedAt: 200, xp: 50,
            flashcards: [{ id: 'c2', front: 'Q2', back: 'A2', updatedAt: 200 }],
            deleted: { c1: 150 } };
        const put2 = await call('PUT', '/api/sync', { token, body: { data: dev2 } });
        assert.deepEqual(put2.json.data.flashcards.map((c) => c.id), ['c2']);
        assert.equal(put2.json.data.xp, 120, 'counters never go backwards');

        const get = await call('GET', '/api/sync', { token });
        assert.deepEqual(get.json.data.flashcards.map((c) => c.id), ['c2']);

        const evil = await call('PUT', '/api/sync', { token, body: { data: {
            xp: 'lots', theme: '<script>', flashcards: [{ id: '__proto__', front: 'x', back: 'y' }, { id: 'ok', front: 'f'.repeat(5000), back: 'b', extra: 'drop me' }, null, { id: 'bad id!', front: 'a', back: 'b' }],
            activityLog: { 'not-a-date': 5, '2026-01-01': 1e99 }, deleted: { '__proto__': 1 },
            exams: { Biology: '2026-05-01', Nope: 'tomorrow' }, freezesEarned: 'many', updatedAt: 5000,
        } } });
        assert.equal(evil.status, 200);
        const d = evil.json.data;
        assert.equal(d.theme, 'light');
        assert.ok(d.flashcards.some((c) => c.id === 'ok' && c.front.length === 2000 && !('extra' in c)));
        assert.ok(!d.flashcards.some((c) => c.id === '__proto__' || c.id === 'bad id!'));
        assert.ok(!('not-a-date' in d.activityLog));
        assert.ok(d.activityLog['2026-01-01'] <= 1e6);
        assert.deepEqual(d.exams, { Biology: '2026-05-01' });
        assert.equal(d.freezesEarned, 0);

        assert.equal((await call('PUT', '/api/sync', { token, body: { nothing: true } })).status, 400);
    } finally { await ctx.close(); }
});

test('sync writes only the rows that changed (SELECT total_changes())', async () => {
    const ctx = await start();
    const { call, db } = ctx;
    try {
        const token = await registerToken(call);
        const doc = {
            ...Core.defaultData(), updatedAt: 1000, xp: 250, streak: 4,
            exams: { Biology: '2026-05-12' },
            flashcards: [
                { id: 'a', front: 'Q a', back: 'A a', subject: 'Bio', updatedAt: 900, ease: 2.5, interval: 3, due: 5 },
                { id: 'b', front: 'Q b', back: 'A b', subject: 'Bio', updatedAt: 900 },
            ],
            notes: [{ id: 'n', title: 'T', content: 'C', updatedAt: 900 }],
            quizHistory: [{ id: 'q', subject: 'Bio', mode: 'choice', score: 1, total: 2, percentage: 50, date: 900 }],
        };
        const first = await call('PUT', '/api/sync', { token, body: { data: doc } });
        assert.equal(first.status, 200);
        assert.ok(db.cardsForUser(db.getUserByName('alice').id).length === 2);

        const before = db.totalChanges();
        const again = await call('PUT', '/api/sync', { token, body: { data: doc } });
        assert.equal(again.status, 200);
        assert.equal(db.totalChanges(), before, 'an unchanged document writes no rows at all');
        assert.deepEqual(again.json.data.flashcards.map((c) => c.id), ['a', 'b']);

        // one edited card = one UPDATE
        const edited = { ...doc, flashcards: [{ ...doc.flashcards[0], back: 'A a v2', updatedAt: 1200 }, doc.flashcards[1]] };
        const mid = db.totalChanges();
        await call('PUT', '/api/sync', { token, body: { data: edited } });
        assert.equal(db.totalChanges() - mid, 2, 'the changed card row plus the denormalised user row (last_sync)');
        assert.equal(db.buildDoc(db.getUserByName('alice').id).flashcards[0].back, 'A a v2');

        // one deleted card = one DELETE
        const removed = { ...edited, flashcards: [edited.flashcards[1]], deleted: { a: 1300 } };
        const mid2 = db.totalChanges();
        const r = await call('PUT', '/api/sync', { token, body: { data: removed } });
        assert.equal(db.totalChanges() - mid2, 3, 'one card row, one tombstone and the user row');
        assert.deepEqual(r.json.data.flashcards.map((c) => c.id), ['b']);
        assert.equal(r.json.data.deleted.a, 1300);
    } finally { await ctx.close(); }
});

test('sync merges exams and freezes, and never bumps updatedAt past the documents', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const token = await registerToken(call, 'planner');
        const oldDoc = { ...Core.defaultData(), updatedAt: 2000, exams: { Biology: '2026-05-12', Maths: '2026-05-20' }, freezesEarned: 3, freezesUsed: 1 };
        const first = await call('PUT', '/api/sync', { token, body: { data: oldDoc } });
        assert.deepEqual(first.json.data.exams, { Biology: '2026-05-12', Maths: '2026-05-20' });
        assert.equal(first.json.data.updatedAt, 2000, 'the server must not push updatedAt forward');
        assert.ok(first.json.data.updatedAt < Date.now());

        const newer = { ...Core.defaultData(), updatedAt: 3000, exams: { Biology: '2026-05-12' }, freezesEarned: 1, freezesUsed: 2 };
        const second = await call('PUT', '/api/sync', { token, body: { data: newer } });
        assert.deepEqual(second.json.data.exams, { Biology: '2026-05-12' }, 'the newer document wins, so a cleared date stays cleared');
        assert.equal(second.json.data.freezesEarned, 3, 'freeze counters keep the maximum');
        assert.equal(second.json.data.freezesUsed, 2);
        assert.equal(second.json.data.updatedAt, 3000);

        // an old device syncing again must not resurrect the deleted exam date
        const third = await call('PUT', '/api/sync', { token, body: { data: oldDoc } });
        assert.deepEqual(third.json.data.exams, { Biology: '2026-05-12' });
        assert.equal(third.json.data.updatedAt, 3000);
        assert.equal((await call('GET', '/api/sync', { token })).json.data.updatedAt, 3000);
    } finally { await ctx.close(); }
});

test('sync data is private per user', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const a = await registerToken(call, 'alice');
        const b = await registerToken(call, 'bobby');
        await call('PUT', '/api/sync', { token: a, body: { data: { flashcards: [{ id: 'secret', front: 'f', back: 'b' }] } } });
        assert.equal((await call('GET', '/api/sync', { token: b })).json.data, null);
    } finally { await ctx.close(); }
});

test('leaderboard ranks by xp and respects opt-out', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const a = await registerToken(call, 'alice');
        const b = await registerToken(call, 'bobby');
        const c = await registerToken(call, 'carol');
        await call('PUT', '/api/sync', { token: a, body: { data: { xp: 300 } } });
        await call('PUT', '/api/sync', { token: b, body: { data: { xp: 900 } } });
        await call('PUT', '/api/sync', { token: c, body: { data: { xp: 5000 } } });
        await call('PATCH', '/api/auth/me', { token: c, body: { showOnLeaderboard: false } });
        const lb = (await call('GET', '/api/leaderboard')).json.leaderboard;
        assert.deepEqual(lb.map((r) => r.username), ['bobby', 'alice']);
        assert.equal(lb[0].rank, 1);
        assert.ok(lb[0].level >= 4);
    } finally { await ctx.close(); }
});

// ------------------------------------------------------------------ shares
test('shared decks: create, fetch by code, list, delete, owner only', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const a = await registerToken(call, 'alice');
        const b = await registerToken(call, 'bobby');
        assert.equal((await call('POST', '/api/share', { body: { title: 'x', cards: [] } })).status, 401);
        assert.equal((await call('POST', '/api/share', { token: a, body: { title: '', cards: [{ front: 'a', back: 'b' }] } })).status, 400);
        assert.equal((await call('POST', '/api/share', { token: a, body: { title: 'T', cards: [{ front: '', back: '' }] } })).status, 400);

        const made = await call('POST', '/api/share', { token: a, body: { title: 'My deck', cards: [{ front: 'Q', back: 'A', subject: 'Bio' }, { front: 'Q2', back: 'A2' }] } });
        assert.equal(made.status, 201);
        assert.match(made.json.code, /^[A-Z2-9]{8}$/);

        const got = await call('GET', `/api/share/${made.json.code.toLowerCase()}`);
        assert.equal(got.status, 200);
        assert.equal(got.json.author, 'alice');
        assert.equal(got.json.cards.length, 2);
        assert.ok(!('userId' in got.json));

        assert.equal((await call('GET', '/api/share/ZZZZZZZZ')).status, 404);
        assert.equal((await call('GET', '/api/share', { token: a })).json.shares.length, 1);
        assert.equal((await call('DELETE', `/api/share/${made.json.code}`, { token: b })).status, 404);
        assert.equal((await call('DELETE', `/api/share/${made.json.code}`, { token: a })).status, 200);
        assert.equal((await call('GET', `/api/share/${made.json.code}`)).status, 404);
    } finally { await ctx.close(); }
});

// -------------------------------------------------------------- challenges
test('friend challenges, end to end', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const author = await registerToken(call, 'author');
        const cards = [
            { front: 'Powerhouse of the cell?', back: 'Mitochondria', subject: 'Biology' },
            { front: 'Control centre?', back: 'Nucleus', subject: 'Biology' },
            { front: 'Site of photosynthesis?', back: 'Chloroplast', subject: 'Biology' },
            { front: 'What carries genetic information?', back: 'DNA', subject: 'Biology' },
        ];
        assert.equal((await call('POST', '/api/challenges', { body: { title: 'Cells', cards } })).status, 401, 'login required');
        assert.equal((await call('POST', '/api/challenges', { token: author, body: { title: 'Too few', cards: cards.slice(0, 2) } })).status, 400);
        assert.equal((await call('POST', '/api/challenges', { token: author, body: { title: 'Too many', cards: Array.from({ length: 51 }, (_, i) => ({ front: `q${i}`, back: `a${i}` })) } })).status, 400);
        assert.equal((await call('POST', '/api/challenges', { token: author, body: { title: '', cards } })).status, 400);

        const made = await call('POST', '/api/challenges', { token: author, body: { title: 'Cell race', cards } });
        assert.equal(made.status, 201);
        assert.match(made.json.code, /^[A-Z2-9]{8}$/);
        assert.equal(made.json.cardCount, 4);

        // public read
        const pub = await call('GET', `/api/challenges/${made.json.code.toLowerCase()}`);
        assert.equal(pub.status, 200);
        assert.equal(pub.json.author, 'author');
        assert.equal(pub.json.cards.length, 4);
        assert.deepEqual(pub.json.results, []);
        assert.ok(!('userId' in pub.json));
        assert.equal((await call('GET', '/api/challenges/ZZZZZZZZ')).status, 404);

        // mine
        const mine = await call('GET', '/api/challenges', { token: author });
        assert.equal(mine.json.challenges.length, 1);
        assert.equal(mine.json.challenges[0].players, 0);
        assert.equal((await call('GET', '/api/challenges')).status, 401);

        // results
        const player = await registerToken(call, 'player');
        const post = (token, body) => call('POST', `/api/challenges/${made.json.code}/results`, { token, body });
        assert.equal((await post(null, { score: 4, total: 4, timeMs: 20000 })).status, 401);
        assert.equal((await post(player, { score: 4, total: 3, timeMs: 20000 })).status, 400, 'total must match the card count');
        assert.equal((await post(player, { score: 9, total: 4, timeMs: 20000 })).status, 400, 'score out of range');
        assert.equal((await post(player, { score: 4, total: 4, timeMs: 100 })).status, 400, 'impossibly fast');
        assert.equal((await post(player, { score: 4, total: 4, timeMs: 4 * 300 - 1 })).status, 400, 'just under the minimum');

        const first = await post(player, { score: 3, total: 4, timeMs: 15000 });
        assert.equal(first.status, 201);
        assert.equal(first.json.rank, 1);
        assert.deepEqual(first.json.best, { score: 3, total: 4, timeMs: 15000, createdAt: first.json.best.createdAt });

        const worse = await post(player, { score: 1, total: 4, timeMs: 30000 });
        assert.equal(worse.json.best.score, 3, 'only the best attempt is kept');
        const better = await post(player, { score: 4, total: 4, timeMs: 12000 });
        assert.equal(better.json.best.score, 4);

        const authorRun = await post(author, { score: 4, total: 4, timeMs: 11000 });
        assert.equal(authorRun.json.rank, 1, 'same score, faster time wins');
        assert.deepEqual(authorRun.json.results.map((r) => r.username), ['author', 'player']);
        assert.equal((await call('GET', `/api/challenges/${made.json.code}`)).json.results.length, 2);
        assert.equal((await call('GET', '/api/challenges', { token: author })).json.challenges[0].players, 2);

        // delete: owner only
        assert.equal((await call('DELETE', `/api/challenges/${made.json.code}`, { token: player })).status, 404);
        assert.equal((await call('DELETE', `/api/challenges/${made.json.code}`, { token: author })).status, 200);
        assert.equal((await call('GET', `/api/challenges/${made.json.code}`)).status, 404);
        assert.equal(ctx.db.q('SELECT COUNT(*) AS n FROM challenge_results').get().n, 0, 'the results went with it');
    } finally { await ctx.close(); }
});

test('challenges are capped at 25 per user', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const token = await registerToken(call, 'spammer');
        const cards = Array.from({ length: 3 }, (_, i) => ({ front: `q${i}`, back: `a${i}` }));
        for (let i = 0; i < 25; i++) assert.equal((await call('POST', '/api/challenges', { token, body: { title: `c${i}`, cards } })).status, 201);
        const extra = await call('POST', '/api/challenges', { token, body: { title: 'one too many', cards } });
        assert.equal(extra.status, 400);
        assert.match(extra.json.error, /25/);
    } finally { await ctx.close(); }
});

// ---------------------------------------------------------------- accounts
test('delete account removes data and sessions', async () => {
    const ctx = await start();
    const { call } = ctx;
    try {
        const token = await registerToken(call);
        assert.equal((await call('DELETE', '/api/auth/account', { token, body: { password: 'nope nope' } })).status, 403);
        assert.equal((await call('DELETE', '/api/auth/account', { token, body: { password: PASSWORD } })).status, 200);
        assert.equal((await call('GET', '/api/auth/me', { token })).status, 401);
        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'alice', password: PASSWORD } })).status, 401);
    } finally { await ctx.close(); }
});

test('deleting an account cascades across every table', async () => {
    const ctx = await start();
    const { call, db } = ctx;
    try {
        const reg = await register(call, 'eraser', PASSWORD, 'erase@example.com');
        const token = reg.token;
        await call('PUT', '/api/sync', { token, body: { data: {
            ...Core.defaultData(), updatedAt: 10, xp: 90,
            flashcards: [{ id: 'x1', front: 'f', back: 'b', updatedAt: 10 }],
            notes: [{ id: 'n1', title: 't', content: 'c', updatedAt: 10 }],
            quizHistory: [{ id: 'q1', subject: 'Bio', mode: 'choice', score: 1, total: 2, percentage: 50, date: 10 }],
            deleted: { old: 5 },
        } } });
        const share = await call('POST', '/api/share', { token, body: { title: 'S', cards: [{ front: 'a', back: 'b' }] } });
        const challenge = await call('POST', '/api/challenges', { token, body: { title: 'C', cards: [{ front: 'a', back: 'b' }, { front: 'c', back: 'd' }, { front: 'e', back: 'f' }] } });
        await call('POST', `/api/challenges/${challenge.json.code}/results`, { token, body: { score: 3, total: 3, timeMs: 5000 } });
        await call('POST', '/api/auth/login', { body: { username: 'eraser', password: PASSWORD } });
        const userId = reg.user.id;

        assert.equal(db.cardsForUser(userId).length, 1);
        assert.equal(db.listSessions(userId).length, 2);
        assert.ok(db.getShare(share.json.code) && db.getChallenge(challenge.json.code));

        assert.equal((await call('DELETE', '/api/auth/account', { token, body: { password: PASSWORD } })).status, 200);

        assert.equal(db.getUser(userId), null);
        assert.equal(db.cardsForUser(userId).length, 0);
        assert.equal(db.notesForUser(userId).length, 0);
        assert.equal(db.quizzesForUser(userId).length, 0);
        assert.deepEqual(db.tombstonesForUser(userId), {});
        assert.equal(db.getState(userId), null);
        assert.equal(db.listSessions(userId).length, 0);
        assert.equal(db.getShare(share.json.code), null);
        assert.equal(db.getChallenge(challenge.json.code), null);
        assert.equal(db.buildDoc(userId), null);
        const counts = ['sessions', 'tokens', 'cards', 'notes', 'quizzes', 'tombstones', 'user_state', 'shares', 'challenges', 'challenge_results']
            .map((t) => db.q(`SELECT COUNT(*) AS n FROM ${t}`).get().n);
        assert.deepEqual(counts, counts.map(() => 0), 'no orphaned rows anywhere');
    } finally { await ctx.close(); }
});

test('rate limiting on auth endpoints', async () => {
    const ctx = await start();
    try {
        let last;
        for (let i = 0; i < 25; i++) last = await ctx.call('POST', '/api/auth/login', { body: { username: 'x', password: 'y' } });
        assert.equal(last.status, 429);
        assert.match(last.json.error, /Too many/i);
    } finally { await ctx.close(); }
});

test('email links are built from PUBLIC_URL, never from Host or Origin', async () => {
    const ctx = await start();
    try {
        // A raw request so we can forge Host and Origin (fetch would normalise them).
        const forged = await new Promise((resolve, reject) => {
            const req = http.request({
                host: '127.0.0.1',
                port: ctx.server.address().port,
                path: '/api/auth/register',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Host: 'evil.example',
                    Origin: 'https://evil.example',
                    'X-Forwarded-Host': 'evil.example',
                    Referer: 'https://evil.example/steal',
                },
            }, (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => resolve({ status: res.statusCode, body }));
            });
            req.on('error', reject);
            req.end(JSON.stringify({ username: 'forged', password: PASSWORD, email: 'victim@example.com' }));
        });
        assert.equal(forged.status, 201);

        const mail = ctx.mailer.last();
        assert.ok(mail, 'the verification mail was produced');
        assert.ok(mail.text.includes(`${PUBLIC_URL}/#community?verify=`), 'the link uses PUBLIC_URL');
        assert.ok(!mail.text.includes('evil.example'), 'no trace of the forged headers');
        assert.ok(!mail.text.includes('127.0.0.1'), 'and no trace of the request host either');
        assert.equal(ctx.publicUrl, PUBLIC_URL);

        // the same for a reset link
        const verify = mailToken(ctx, 'verify');
        await ctx.call('POST', '/api/auth/email/verify', { body: { token: verify } });
        ctx.mailer.outbox.length = 0;
        await ctx.call('POST', '/api/auth/forgot', { body: { identifier: 'forged' }, headers: { Origin: 'https://evil.example' } });
        const reset = ctx.mailer.last();
        assert.ok(reset.text.includes(`${PUBLIC_URL}/#community?reset=`));
        assert.ok(!reset.text.includes('evil.example'));

        // PUBLIC_URL comes from the environment when it is not passed in
        const envApp = createApp({ dbPath: ':memory:', silentMail: true });
        assert.equal(envApp.publicUrl, 'http://localhost:3000');
        await new Promise((r) => envApp.server.close(r));
        envApp.db.close();
    } finally { await ctx.close(); }
});

test('errors: bad JSON, wrong content type, unknown route, method not allowed', async () => {
    const ctx = await start();
    try {
        const bad = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
        assert.equal(bad.status, 400);
        const wrongType = await fetch(`${ctx.base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
        assert.equal(wrongType.status, 415);
        assert.equal((await ctx.call('GET', '/api/nothing')).status, 404);
        assert.equal((await ctx.call('DELETE', '/api/health')).status, 405);
        const err = await ctx.call('GET', '/api/nothing');
        assert.ok(err.json && typeof err.json.error === 'string', 'every error body is {error}');
    } finally { await ctx.close(); }
});

test('CORS headers, preflight and security headers', async () => {
    const ctx = await start();
    try {
        const pre = await fetch(`${ctx.base}/api/sync`, { method: 'OPTIONS' });
        assert.equal(pre.status, 204);
        assert.equal(pre.headers.get('access-control-allow-origin'), '*');
        assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);

        const health = await fetch(`${ctx.base}/api/health`);
        assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(health.headers.get('x-frame-options'), 'DENY');

        const scoped = await start({ corsOrigin: 'https://revise.example' });
        try {
            const res = await fetch(`${scoped.base}/api/health`);
            assert.equal(res.headers.get('access-control-allow-origin'), 'https://revise.example');
        } finally { await scoped.close(); }
    } finally { await ctx.close(); }
});

test('static files: app is served, everything else is not', async () => {
    const ctx = await start();
    try {
        const index = await fetch(`${ctx.base}/`);
        assert.equal(index.status, 200);
        assert.match(await index.text(), /ReviseForFun/);
        assert.equal((await fetch(`${ctx.base}/js/core.js`)).status, 200);
        assert.equal((await fetch(`${ctx.base}/js/plan.js`)).status, 200, 'the new page is served');
        assert.equal((await fetch(`${ctx.base}/data/library.json`)).status, 200);
        for (const p of ['/package.json', '/server/db.js', '/server/index.js', '/.git/HEAD', '/%2e%2e/package.json',
            '/js/../package.json', '/data/decks/bio-cells.deck', '/.data/rff.sqlite', '/README.md']) {
            const r = await fetch(`${ctx.base}${p}`);
            assert.equal(r.status, 404, `${p} must not be served`);
        }
    } finally { await ctx.close(); }
});

test('a file database survives a restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rff-'));
    try {
        let ctx = await start({ dataDir: dir, silentMail: true });
        const reg = await register(ctx.call, 'dave', 'a durable secret');
        await ctx.call('PUT', '/api/sync', { token: reg.token, body: { data: { flashcards: [{ id: 'p1', front: 'f', back: 'b' }] } } });
        await ctx.call('POST', '/api/share', { token: reg.token, body: { title: 'Kept', cards: [{ front: 'a', back: 'b' }] } });
        await ctx.close();
        ctx.db.close();
        assert.ok(fs.existsSync(path.join(dir, 'rff.sqlite')));
        assert.ok(fs.existsSync(path.join(dir, 'rff.sqlite-wal')) || fs.existsSync(path.join(dir, 'rff.sqlite')), 'WAL files');

        ctx = await start({ dataDir: dir, silentMail: true });
        const got = await ctx.call('GET', '/api/sync', { token: reg.token });
        assert.equal(got.json.data.flashcards[0].id, 'p1', 'the session token still works after a restart');
        assert.equal((await ctx.call('GET', '/api/share', { token: reg.token })).json.shares.length, 1);
        assert.equal((await ctx.call('POST', '/api/auth/login', { body: { username: 'dave', password: 'a durable secret' } })).status, 200);
        await ctx.close();
        ctx.db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a 2.x JSON store is imported on first boot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rff-legacy-'));
    try {
        const userId = 'legacy-id-123';
        const legacyTokenHash = require('node:crypto').createHash('sha256').update('legacy-token').digest('hex');
        fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
            users: { [userId]: { id: userId, username: 'OldOne', usernameLower: 'oldone', passwordHash: null, createdAt: 1, showOnLeaderboard: true, stats: { xp: 10, level: 1, streak: 1, cards: 1 } } },
            sessions: {},
            shares: { LEGACY01: { code: 'LEGACY01', userId, author: 'OldOne', title: 'Old deck', cards: [{ front: 'q', back: 'a' }], createdAt: 1 } },
        }));
        fs.mkdirSync(path.join(dir, 'docs'));
        fs.writeFileSync(path.join(dir, 'docs', `${userId}.json`), JSON.stringify({ ...Core.defaultData(), updatedAt: 7, xp: 42, flashcards: [{ id: 'old1', front: 'f', back: 'b', updatedAt: 7 }] }));

        const ctx = await start({ dataDir: dir });
        assert.equal(ctx.legacy.imported, true);
        assert.equal(ctx.legacy.users, 1);
        assert.equal(ctx.legacy.docs, 1);
        assert.equal(fs.existsSync(path.join(dir, 'db.json')), false);
        assert.ok(fs.existsSync(path.join(dir, 'db.json.migrated')));
        assert.equal((await ctx.call('GET', '/api/share/LEGACY01')).status, 200);

        // the legacy password hash was unusable, so log in is refused but the account exists
        assert.equal((await ctx.call('POST', '/api/auth/login', { body: { username: 'oldone', password: 'anything' } })).status, 401);
        assert.ok(ctx.db.getUserByName('oldone'));
        const doc = ctx.db.buildDoc(userId);
        assert.equal(doc.xp, 42, 'the study document came across');
        assert.equal(doc.flashcards[0].id, 'old1');
        assert.equal(ctx.db.leaderboard(10).length, 1, 'and the denormalised xp with it');
        assert.ok(legacyTokenHash);
        await ctx.close();
        ctx.db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
