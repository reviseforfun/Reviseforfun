'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const { Store } = require('../store');
const Core = require('../../js/core');

async function start() {
    const { server } = createApp({ store: new Store(null) });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = async (method, path, { body, token, raw } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (raw) return res;
        const text = await res.text();
        let json = null;
        try { json = JSON.parse(text); } catch { /* not json */ }
        return { status: res.status, json, headers: res.headers };
    };
    return { server, call, close: () => new Promise((r) => server.close(r)) };
}

async function register(call, username = 'alice', password = 'correct horse') {
    const r = await call('POST', '/api/auth/register', { body: { username, password } });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.token;
}

test('health and preset library', async () => {
    const { call, close } = await start();
    try {
        const health = await call('GET', '/api/health');
        assert.equal(health.status, 200);
        assert.ok(health.json.ok && health.json.decks >= 25 && health.json.cards > 500);

        const list = await call('GET', '/api/decks');
        assert.ok(list.json.decks.length >= 25);
        assert.ok(!('cards' in list.json.decks[0]), 'listing must not include cards');
        assert.ok(list.json.subjects.includes('Biology'));

        const bio = await call('GET', '/api/decks?subject=Biology');
        assert.ok(bio.json.decks.length >= 3 && bio.json.decks.every((d) => d.subject === 'Biology'));

        const search = await call('GET', '/api/decks?q=mitochondria');
        assert.ok(search.json.decks.some((d) => d.id === 'bio-cells'));

        const deck = await call('GET', '/api/decks/bio-cells');
        assert.equal(deck.json.cards.length, deck.json.cardCount);
        assert.equal((await call('GET', '/api/decks/nope')).status, 404);
    } finally { await close(); }
});

test('register / login / me / logout', async () => {
    const { call, close } = await start();
    try {
        assert.equal((await call('POST', '/api/auth/register', { body: { username: 'a', password: 'longenough' } })).status, 400);
        assert.equal((await call('POST', '/api/auth/register', { body: { username: 'bob', password: 'short' } })).status, 400);
        const token = await register(call, 'Alice');
        assert.equal((await call('POST', '/api/auth/register', { body: { username: 'alice', password: 'another pass' } })).status, 409, 'usernames are case-insensitive');

        const me = await call('GET', '/api/auth/me', { token });
        assert.equal(me.json.user.username, 'Alice');
        assert.ok(!JSON.stringify(me.json).includes('passwordHash'));

        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong password' } })).status, 401);
        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'nobody', password: 'wrong password' } })).status, 401);
        const login = await call('POST', '/api/auth/login', { body: { username: 'ALICE', password: 'correct horse' } });
        assert.equal(login.status, 200);

        assert.equal((await call('POST', '/api/auth/logout', { token: login.json.token })).status, 200);
        assert.equal((await call('GET', '/api/auth/me', { token: login.json.token })).status, 401);
        assert.equal((await call('GET', '/api/auth/me')).status, 401);
        assert.equal((await call('GET', '/api/auth/me', { token })).status, 200, 'other sessions stay valid');
    } finally { await close(); }
});

test('sync requires auth, merges data and sanitises input', async () => {
    const { call, close } = await start();
    try {
        assert.equal((await call('GET', '/api/sync')).status, 401);
        const token = await register(call);
        assert.equal((await call('GET', '/api/sync', { token })).json.data, null);

        const dev1 = { ...Core.defaultData(), updatedAt: 100, xp: 120,
            flashcards: [{ id: 'c1', front: 'Q1', back: 'A1', subject: 'Bio', updatedAt: 100 }] };
        const put1 = await call('PUT', '/api/sync', { token, body: { data: dev1 } });
        assert.equal(put1.status, 200);
        assert.equal(put1.json.data.flashcards.length, 1);

        // second device, offline edits
        const dev2 = { ...Core.defaultData(), updatedAt: 200, xp: 50,
            flashcards: [{ id: 'c2', front: 'Q2', back: 'A2', updatedAt: 200 }],
            deleted: { c1: 150 } };
        const put2 = await call('PUT', '/api/sync', { token, body: { data: dev2 } });
        assert.deepEqual(put2.json.data.flashcards.map((c) => c.id), ['c2']);
        assert.equal(put2.json.data.xp, 120, 'counters never go backwards');

        const get = await call('GET', '/api/sync', { token });
        assert.deepEqual(get.json.data.flashcards.map((c) => c.id), ['c2']);

        // hostile payload
        const evil = await call('PUT', '/api/sync', { token, body: { data: {
            xp: 'lots', theme: '<script>', flashcards: [{ id: '__proto__', front: 'x', back: 'y' }, { id: 'ok', front: 'f'.repeat(5000), back: 'b', extra: 'drop me' }, null, { id: 'bad id!', front: 'a', back: 'b' }],
            activityLog: { 'not-a-date': 5, '2026-01-01': 1e99 }, deleted: { '__proto__': 1 },
        } } });
        assert.equal(evil.status, 200);
        const d = evil.json.data;
        assert.equal(d.theme, 'light');
        assert.ok(d.flashcards.some((c) => c.id === 'ok' && c.front.length === 2000 && !('extra' in c)));
        assert.ok(!d.flashcards.some((c) => c.id === '__proto__' || c.id === 'bad id!'));
        assert.ok(!('not-a-date' in d.activityLog));
        assert.ok(d.activityLog['2026-01-01'] <= 1e6);

        assert.equal((await call('PUT', '/api/sync', { token, body: { nothing: true } })).status, 400);
    } finally { await close(); }
});

test('sync data is private per user', async () => {
    const { call, close } = await start();
    try {
        const a = await register(call, 'alice');
        const b = await register(call, 'bobby');
        await call('PUT', '/api/sync', { token: a, body: { data: { flashcards: [{ id: 'secret', front: 'f', back: 'b' }] } } });
        assert.equal((await call('GET', '/api/sync', { token: b })).json.data, null);
    } finally { await close(); }
});

test('leaderboard ranks by xp and respects opt-out', async () => {
    const { call, close } = await start();
    try {
        const a = await register(call, 'alice');
        const b = await register(call, 'bobby');
        const c = await register(call, 'carol');
        await call('PUT', '/api/sync', { token: a, body: { data: { xp: 300 } } });
        await call('PUT', '/api/sync', { token: b, body: { data: { xp: 900 } } });
        await call('PUT', '/api/sync', { token: c, body: { data: { xp: 5000 } } });
        await call('PATCH', '/api/auth/me', { token: c, body: { showOnLeaderboard: false } });
        const lb = (await call('GET', '/api/leaderboard')).json.leaderboard;
        assert.deepEqual(lb.map((r) => r.username), ['bobby', 'alice']);
        assert.equal(lb[0].rank, 1);
        assert.ok(lb[0].level >= 4);
    } finally { await close(); }
});

test('shared decks: create, fetch by code, list, delete, owner only', async () => {
    const { call, close } = await start();
    try {
        const a = await register(call, 'alice');
        const b = await register(call, 'bobby');
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
    } finally { await close(); }
});

test('delete account removes data and sessions', async () => {
    const { call, close } = await start();
    try {
        const token = await register(call);
        assert.equal((await call('DELETE', '/api/auth/account', { token, body: { password: 'nope nope' } })).status, 403);
        assert.equal((await call('DELETE', '/api/auth/account', { token, body: { password: 'correct horse' } })).status, 200);
        assert.equal((await call('GET', '/api/auth/me', { token })).status, 401);
        assert.equal((await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'correct horse' } })).status, 401);
    } finally { await close(); }
});

test('rate limiting on auth endpoints', async () => {
    const { call, close } = await start();
    try {
        let last;
        for (let i = 0; i < 25; i++) last = await call('POST', '/api/auth/login', { body: { username: 'x', password: 'y' } });
        assert.equal(last.status, 429);
    } finally { await close(); }
});

test('errors: bad JSON, wrong content type, unknown route, method not allowed', async () => {
    const { server, call, close } = await start();
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const bad = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{nope' });
        assert.equal(bad.status, 400);
        const wrongType = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
        assert.equal(wrongType.status, 415);
        assert.equal((await call('GET', '/api/nothing')).status, 404);
        assert.equal((await call('DELETE', '/api/health')).status, 405);
    } finally { await close(); }
});

test('CORS headers and preflight', async () => {
    const { server, close } = await start();
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const pre = await fetch(`${base}/api/sync`, { method: 'OPTIONS' });
        assert.equal(pre.status, 204);
        assert.equal(pre.headers.get('access-control-allow-origin'), '*');
        assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
    } finally { await close(); }
});

test('static files: app is served, everything else is not', async () => {
    const { server, close } = await start();
    try {
        const base = `http://127.0.0.1:${server.address().port}`;
        const index = await fetch(`${base}/`);
        assert.equal(index.status, 200);
        assert.match(await index.text(), /ReviseForFun/);
        assert.equal((await fetch(`${base}/js/core.js`)).status, 200);
        assert.equal((await fetch(`${base}/data/library.json`)).status, 200);
        for (const p of ['/package.json', '/server/store.js', '/.git/HEAD', '/%2e%2e/package.json', '/js/../package.json', '/data/decks/bio-cells.deck', '/.data/db.json']) {
            const r = await fetch(`${base}${p}`);
            assert.equal(r.status, 404, `${p} must not be served`);
        }
    } finally { await close(); }
});

test('persistent store survives a restart', async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rff-'));
    try {
        let app = createApp({ dataDir: dir });
        await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
        let base = `http://127.0.0.1:${app.server.address().port}`;
        const reg = await (await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'dave', password: 'password123' }) })).json();
        await fetch(`${base}/api/sync`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${reg.token}` }, body: JSON.stringify({ data: { flashcards: [{ id: 'p1', front: 'f', back: 'b' }] } }) });
        await new Promise((r) => app.server.close(r));

        app = createApp({ dataDir: dir });
        await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${app.server.address().port}`;
        const got = await (await fetch(`${base}/api/sync`, { headers: { Authorization: `Bearer ${reg.token}` } })).json();
        assert.equal(got.data.flashcards[0].id, 'p1');
        await new Promise((r) => app.server.close(r));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
