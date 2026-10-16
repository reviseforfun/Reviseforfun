'use strict';
/**
 * Storage tests: migrations, pragmas, transactions, cascades and the
 * row-level document diff. All of it runs on node:sqlite – no npm packages.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const crypto = require('node:crypto');
const { Db, SCHEMA_VERSION, MAX_SESSIONS } = require('../db');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const { importLegacy } = require('../legacy');
const { sanitizeDoc } = require('../sanitize');
const Core = require('../../js/core');

const TABLES = ['users', 'sessions', 'tokens', 'cards', 'notes', 'quizzes', 'tombstones',
    'user_state', 'shares', 'challenges', 'challenge_results'];

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'rff-db-'));
}

function makeUser(db, id = 'u1', extra = {}) {
    db.createUser({ id, username: extra.username || 'Alice', passwordHash: 'scrypt$aa$bb', createdAt: 1000, ...extra });
    return db.getUser(id);
}

function sampleDoc(over = {}) {
    return sanitizeDoc({
        ...Core.defaultData(),
        updatedAt: 500,
        xp: 120,
        streak: 3,
        exams: { Biology: '2026-05-12' },
        freezesEarned: 2,
        freezesUsed: 1,
        flashcards: [
            { id: 'c1', subject: 'Biology', front: 'Q1', back: 'A1', createdAt: 1, updatedAt: 10, ease: 2.5, interval: 3, reps: 2, lapses: 0, due: 99, lastReview: 5 },
            { id: 'c2', subject: 'Chemistry', front: 'Q2', back: 'A2', createdAt: 2, updatedAt: 20, starred: true, deckId: 'chem-atoms' },
        ],
        notes: [{ id: 'n1', title: 'Cells', content: '# Hi', subject: 'Biology', createdAt: 1, updatedAt: 2 }],
        quizHistory: [{ id: 'q1', subject: 'Biology', mode: 'choice', score: 4, total: 5, percentage: 80, date: 3 }],
        deleted: { gone: 77 },
        ...over,
    });
}

test('migrations create every table and bump user_version', () => {
    const db = new Db(':memory:');
    try {
        assert.equal(db.userVersion, SCHEMA_VERSION);
        assert.equal(db.schemaVersion, SCHEMA_VERSION);
        const names = db.db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index')").all().map((r) => r.name);
        for (const t of TABLES) assert.ok(names.includes(t), `missing table ${t}`);
        assert.ok(names.includes('users_email_verified'), 'the partial unique index exists');
        const ddl = db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'users_email_verified'").get().sql;
        assert.match(ddl, /WHERE\s+"?email_verified"?\s*=\s*1/i);
        assert.match(db.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'cards'").get().sql, /ON DELETE CASCADE/);
        assert.equal(db.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    } finally { db.close(); }
});

test('a fresh file database uses WAL, foreign keys and a busy timeout', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'nested', 'rff.sqlite');
        const db = new Db(file);
        assert.equal(db.journalMode(), 'wal');
        assert.equal(db.foreignKeysOn(), true);
        assert.equal(db.db.prepare('PRAGMA busy_timeout').get().timeout, 5000);
        db.close();
        assert.ok(fs.existsSync(path.join(dir, 'nested', 'rff.sqlite')), 'the directory is created on demand');

        const mem = new Db(':memory:');
        assert.equal(mem.journalMode(), 'memory', 'no WAL for an in-memory database');
        assert.equal(mem.foreignKeysOn(), true);
        mem.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('migrations are idempotent and survive a reopen', () => {
    const dir = tempDir();
    try {
        const file = path.join(dir, 'rff.sqlite');
        const first = new Db(file);
        makeUser(first, 'u1');
        first.writeDoc('u1', sampleDoc());
        first.close();

        const second = new Db(file);
        assert.equal(second.userVersion, SCHEMA_VERSION);
        assert.equal(second.countUsers(), 1);
        assert.equal(second.cardsForUser('u1').length, 2);
        // running the migration step again must not duplicate anything
        second.migrate();
        assert.equal(second.userVersion, SCHEMA_VERSION);
        assert.equal(second.countUsers(), 1);
        second.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tx() commits, rolls back and nests', () => {
    const db = new Db(':memory:');
    try {
        db.tx(() => makeUser(db, 'u1', { username: 'ann' }));
        assert.equal(db.countUsers(), 1, 'committed');

        assert.throws(() => db.tx(() => {
            makeUser(db, 'u2', { username: 'bob' });
            throw new Error('boom');
        }), /boom/);
        assert.equal(db.countUsers(), 1, 'rolled back');
        assert.equal(db.getUser('u2'), null);

        // A nested tx joins the outer one: its work is kept…
        db.tx(() => {
            makeUser(db, 'u3', { username: 'cat' });
            db.tx(() => makeUser(db, 'u4', { username: 'dee' }));
        });
        assert.deepEqual([db.getUser('u3').id, db.getUser('u4').id], ['u3', 'u4']);

        // …and an inner failure takes the whole outer transaction with it.
        assert.throws(() => db.tx(() => {
            makeUser(db, 'u5', { username: 'eve' });
            db.tx(() => {
                makeUser(db, 'u6', { username: 'fay' });
                throw new Error('inner boom');
            });
        }), /inner boom/);
        assert.equal(db.getUser('u5'), null);
        assert.equal(db.getUser('u6'), null);

        // The connection is still usable afterwards.
        db.tx(() => makeUser(db, 'u7', { username: 'gus' }));
        assert.equal(db.getUser('u7').id, 'u7');
    } finally { db.close(); }
});

test('deleting a user cascades to every owned table', () => {
    const db = new Db(':memory:');
    try {
        makeUser(db, 'u1');
        db.updateUser('u1', { email: 'a@b.com', emailVerified: true, recoveryHash: 'deadbeef' });
        db.createSession({ tokenHash: 'sess1', userId: 'u1', device: 'Chrome', now: 1, ttl: 1000 });
        db.createToken({ tokenHash: 'tok1', userId: 'u1', kind: 'reset', email: 'a@b.com', now: 1, ttl: 1000 });
        db.writeDoc('u1', sampleDoc());
        db.putShare({ code: 'SHARE001', userId: 'u1', title: 'Bio', cards: [{ front: 'q', back: 'a' }], createdAt: 1 });
        db.putChallenge({ code: 'CHAL0001', userId: 'u1', title: 'Bio race', cards: [{ front: 'q', back: 'a' }], createdAt: 1 });
        db.saveResult({ code: 'CHAL0001', userId: 'u1', score: 5, total: 5, timeMs: 9000 });
        makeUser(db, 'other', { username: 'Bobby' });
        db.saveResult({ code: 'CHAL0001', userId: 'other', score: 3, total: 5, timeMs: 8000 });

        // everything is there
        assert.ok(db.getSession('sess1') && db.getToken('tok1') && db.getState('u1'));
        assert.equal(db.cardsForUser('u1').length, 2);
        assert.equal(db.notesForUser('u1').length, 1);
        assert.equal(db.quizzesForUser('u1').length, 1);
        assert.equal(Object.keys(db.tombstonesForUser('u1')).length, 1);
        assert.equal(db.resultsFor('CHAL0001').length, 2);

        db.deleteUser('u1');

        assert.equal(db.getUser('u1'), null);
        assert.equal(db.getSession('sess1'), null, 'sessions cascade');
        assert.equal(db.getToken('tok1'), null, 'tokens cascade');
        assert.equal(db.cardsForUser('u1').length, 0, 'cards cascade');
        assert.equal(db.notesForUser('u1').length, 0, 'notes cascade');
        assert.equal(db.quizzesForUser('u1').length, 0, 'quizzes cascade');
        assert.deepEqual(db.tombstonesForUser('u1'), {}, 'tombstones cascade');
        assert.equal(db.getState('u1'), null, 'user_state cascades');
        assert.equal(db.getShare('SHARE001'), null, 'shares cascade');
        assert.equal(db.getChallenge('CHAL0001'), null, 'challenges cascade');
        assert.equal(db.resultFor('CHAL0001', 'u1'), null, 'challenge_results cascade with the user');
        assert.equal(db.buildDoc('u1'), null);

        // the other account is untouched
        assert.equal(db.getUser('other').id, 'other');
        assert.equal(db.q('SELECT COUNT(*) AS n FROM challenge_results').get().n, 0,
            'and with the challenge itself');
    } finally { db.close(); }
});

test('deleting a challenge cascades to its results', () => {
    const db = new Db(':memory:');
    try {
        makeUser(db, 'u1', { username: 'ann' });
        makeUser(db, 'u2', { username: 'bob' });
        db.putChallenge({ code: 'CHAL0002', userId: 'u1', title: 'T', cards: [], createdAt: 1 });
        db.saveResult({ code: 'CHAL0002', userId: 'u2', score: 4, total: 5, timeMs: 9000 });
        assert.equal(db.resultsFor('CHAL0002').length, 1);
        db.deleteChallenge('CHAL0002');
        assert.equal(db.q('SELECT COUNT(*) AS n FROM challenge_results').get().n, 0);
        assert.equal(db.getUser('u2').id, 'u2', 'the player survives');
    } finally { db.close(); }
});

test('emails are only unique once verified', () => {
    const db = new Db(':memory:');
    try {
        makeUser(db, 'a', { username: 'ann' });
        makeUser(db, 'b', { username: 'bob' });
        db.updateUser('a', { email: 'same@example.com' });
        db.updateUser('b', { email: 'same@example.com' });
        assert.equal(db.countUsers(), 2, 'two unverified accounts may hold the same address');
        assert.equal(db.getUserByVerifiedEmail('same@example.com'), null, 'unverified addresses cannot sign in');

        db.updateUser('a', { emailVerified: true });
        assert.equal(db.getUserByVerifiedEmail('same@example.com').id, 'a');
        assert.equal(db.findVerifiedEmailOwner('same@example.com', 'a'), null);
        assert.throws(() => db.updateUser('b', { emailVerified: true }), /UNIQUE/i,
            'the partial unique index stops a second account claiming it');

        db.updateUser('a', { email: null, emailVerified: false });
        db.updateUser('b', { emailVerified: true });
        assert.equal(db.getUserByVerifiedEmail('same@example.com').id, 'b', 'clearing frees the address');
    } finally { db.close(); }
});

test('sessions: capped per user, expirable, addressable by short id', () => {
    const db = new Db(':memory:');
    try {
        makeUser(db, 'u1');
        for (let i = 0; i < MAX_SESSIONS + 4; i++) {
            db.createSession({ tokenHash: sha(`hash${String(i).padStart(3, '0')}`), userId: 'u1', device: `dev ${i}`, now: 100 + i, ttl: 100000 });
        }
        const sessions = db.listSessions('u1');
        assert.equal(sessions.length, MAX_SESSIONS, 'only the newest ten are kept');
        assert.equal(db.getSession(sha('hash000')), null, 'the oldest were dropped');
        assert.ok(db.getSession(sha('hash013')));

        const current = sessions[sessions.length - 1];
        assert.equal(current.id.length, 16, 'the public id is the first 16 characters of the hash');
        assert.equal(db.listSessions('u1', sha('hash013'))[0].current, true);
        assert.equal(db.deleteSessionByShortId('u1', current.id), true);
        assert.equal(db.deleteSessionByShortId('u1', current.id), false, 'already gone');

        db.purgeExpiredSessions(Date.now());
        assert.equal(db.listSessions('u1').length, 0, 'expired sessions are purged');

        db.createSession({ tokenHash: 'keep', userId: 'u1', device: 'x', now: Date.now(), ttl: 1000 });
        db.createSession({ tokenHash: 'drop', userId: 'u1', device: 'y', now: Date.now(), ttl: 1000 });
        db.deleteSessionsForUser('u1', { except: 'keep' });
        assert.ok(db.getSession('keep'));
        assert.equal(db.getSession('drop'), null);
        db.deleteSessionsForUser('u1');
        assert.equal(db.listSessions('u1').length, 0);
    } finally { db.close(); }
});

test('tokens: only the newest per user and kind is usable', () => {
    const db = new Db(':memory:');
    try {
        makeUser(db, 'u1');
        db.createToken({ tokenHash: 'reset-old', userId: 'u1', kind: 'reset', email: 'a@b.com', now: 100, ttl: 60000 });
        const first = db.getToken('reset-old');
        assert.equal(first.userId, 'u1');
        db.createToken({ tokenHash: 'reset-new', userId: 'u1', kind: 'reset', email: 'a@b.com', now: 200, ttl: 60000 });
        assert.equal(db.getToken('reset-old'), null, 'the previous reset token is gone');
        assert.equal(db.newestToken('u1', 'reset').token_hash, 'reset-new');

        db.createToken({ tokenHash: 'verify-1', userId: 'u1', kind: 'verify', email: 'a@b.com', now: 200, ttl: 60000 });
        assert.ok(db.getToken('verify-1'), 'a different kind is untouched');
        db.deleteToken('reset-new');
        assert.equal(db.getToken('reset-new'), null);
    } finally { db.close(); }
});

test('buildDoc / writeDoc round-trip the whole document', () => {
    const db = new Db(':memory:');
    try {
        makeUser(db, 'u1');
        assert.equal(db.buildDoc('u1'), null, 'nothing stored yet');
        const doc = sampleDoc();
        db.writeDoc('u1', doc);
        const back = db.buildDoc('u1');
        assert.deepEqual(sanitizeDoc(back), doc);
        assert.equal(back.flashcards[1].starred, true);
        assert.equal(back.flashcards[1].deckId, 'chem-atoms');
        assert.deepEqual(back.exams, { Biology: '2026-05-12' });
        assert.equal(back.freezesEarned, 2);
        assert.equal(back.deleted.gone, 77);

        // the denormalised columns follow the document
        const user = db.getUser('u1');
        assert.equal(user.xp, 120);
        assert.equal(user.level, Core.levelInfo(120).level);
        assert.equal(user.streak, 3);
        assert.equal(user.cardCount, 2);
        assert.ok(user.lastSync > 0);
    } finally { db.close(); }
});

test('writeDoc only touches the rows that changed (SELECT total_changes())', () => {
    const db = new Db(':memory:');
    try {
        makeUser(db, 'u1');
        const doc = sampleDoc();
        const first = db.writeDoc('u1', doc);
        assert.ok(first >= 5, `the first write inserts everything (${first} row changes)`);

        const before = db.totalChanges();
        assert.equal(db.writeDoc('u1', sampleDoc()), 0, 'an identical document writes nothing');
        assert.equal(db.totalChanges(), before, 'total_changes() did not move');

        const edited = sampleDoc();
        edited.flashcards[0].back = 'A1 changed';
        assert.equal(db.writeDoc('u1', edited), 2, 'one card row + the denormalised user row');

        const removed = sampleDoc({ flashcards: [edited.flashcards[1]] });
        assert.equal(db.writeDoc('u1', removed), 2, 'one deleted card + the denormalised user row');
        assert.equal(db.cardsForUser('u1').length, 1);

        const noState = sampleDoc({ notes: [], quizHistory: [] });
        db.writeDoc('u1', noState);
        const before2 = db.totalChanges();
        db.writeDoc('u1', sampleDoc({ notes: [], quizHistory: [] }));
        assert.equal(db.totalChanges(), before2);
    } finally { db.close(); }
});

test('challenge results keep each player’s best attempt', () => {
    const db = new Db(':memory:');
    try {
        makeUser(db, 'u1', { username: 'ann' });
        makeUser(db, 'u2', { username: 'bob' });
        db.putChallenge({ code: 'CHAL0003', userId: 'u1', title: 'T', cards: [], createdAt: 1 });

        const first = db.saveResult({ code: 'CHAL0003', userId: 'u2', score: 5, total: 10, timeMs: 20000 });
        assert.equal(first.improved, true);
        assert.equal(db.saveResult({ code: 'CHAL0003', userId: 'u2', score: 3, total: 10, timeMs: 9000 }).improved, false, 'a worse score is ignored');
        assert.equal(db.saveResult({ code: 'CHAL0003', userId: 'u2', score: 5, total: 10, timeMs: 30000 }).improved, false, 'same score, slower');
        assert.equal(db.saveResult({ code: 'CHAL0003', userId: 'u2', score: 5, total: 10, timeMs: 12000 }).improved, true, 'same score, faster');
        assert.equal(db.saveResult({ code: 'CHAL0003', userId: 'u2', score: 9, total: 10, timeMs: 40000 }).improved, true, 'a better score wins');
        assert.equal(db.resultFor('CHAL0003', 'u2').score, 9);

        db.saveResult({ code: 'CHAL0003', userId: 'u1', score: 10, total: 10, timeMs: 15000 });
        const board = db.resultsFor('CHAL0003', 20);
        assert.deepEqual(board.map((r) => r.username), ['ann', 'bob'], 'the board joins back to the usernames');
        assert.equal(board[0].rank, 1);
        assert.equal(board[0].score, 10);
        assert.equal(board[1].score, 9, 'score descending');
    } finally { db.close(); }
});

test('the leaderboard is a SQL query over the denormalised columns', () => {
    const db = new Db(':memory:');
    try {
        makeUser(db, 'a', { username: 'ann' });
        makeUser(db, 'b', { username: 'bob' });
        makeUser(db, 'c', { username: 'cat' });
        db.updateUser('a', { xp: 300, level: 3, streak: 2 });
        db.updateUser('b', { xp: 900, level: 5, streak: 9 });
        db.updateUser('c', { xp: 5000, level: 10, streak: 1, showOnLeaderboard: false });
        const board = db.leaderboard(10);
        assert.deepEqual(board.map((r) => r.username), ['bob', 'ann']);
        assert.equal(board[0].rank, 1);
        assert.equal(board[0].xp, 900);
        assert.equal(db.leaderboard(1).length, 1);
        db.updateUser('c', { showOnLeaderboard: true });
        assert.equal(db.leaderboard(10)[0].username, 'cat');
    } finally { db.close(); }
});

test('legacy JSON store is imported once, then renamed', () => {
    const dir = tempDir();
    try {
        const userId = 'legacy-user-id';
        const legacy = {
            users: {
                [userId]: {
                    id: userId, username: 'OldStudent', usernameLower: 'oldstudent',
                    passwordHash: 'scrypt$00$11', createdAt: 1700000000000, showOnLeaderboard: true,
                    stats: { xp: 480, level: 4, streak: 6, cards: 2 },
                },
            },
            sessions: { legacyhash: { userId, createdAt: 1700000000000, expiresAt: Date.now() + 60000 } },
            shares: { OLDSHARE: { code: 'OLDSHARE', userId, author: 'OldStudent', title: 'Old deck', cards: [{ front: 'q', back: 'a', subject: 'Bio' }], createdAt: 1700000000000 } },
        };
        fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(legacy));
        fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'docs', `${userId}.json`), JSON.stringify(sampleDoc()));
        fs.writeFileSync(path.join(dir, 'docs', 'orphan.json'), JSON.stringify({ xp: 1 }));

        const db = new Db(path.join(dir, 'rff.sqlite'));
        const result = importLegacy(db, dir);
        assert.equal(result.imported, true);
        assert.deepEqual([result.users, result.sessions, result.shares, result.docs], [1, 1, 1, 1]);

        const user = db.getUserByName('oldstudent');
        assert.equal(user.username, 'OldStudent');
        assert.equal(user.passwordHash, 'scrypt$00$11', 'the scrypt hash is reused as-is');
        assert.equal(user.cardCount, 2);
        assert.equal(user.xp, 120, 'the imported document is the source of truth for xp');
        assert.ok(db.getSession('legacyhash'), 'live sessions survive the move');
        assert.equal(db.getShare('OLDSHARE').title, 'Old deck');
        assert.equal(db.buildDoc(userId).flashcards.length, 2, 'the study document was imported');
        assert.equal(db.buildDoc('orphan'), null, 'documents without a user are skipped');

        assert.equal(fs.existsSync(path.join(dir, 'db.json')), false);
        assert.ok(fs.existsSync(path.join(dir, 'db.json.migrated')), 'renamed so it cannot run twice');

        const again = importLegacy(db, dir);
        assert.equal(again.imported, false);

        // A non-empty users table blocks the import even if db.json comes back.
        fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify(legacy));
        const blocked = importLegacy(db, dir);
        assert.equal(blocked.imported, false);
        assert.match(String(blocked.skipped), /not empty/);
        assert.ok(fs.existsSync(path.join(dir, 'db.json')), 'left alone');
        db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
