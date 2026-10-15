'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Core = require('../../js/core');

const NOW = 1_700_000_000_000;

test('schedule: Good progresses 1 → 3 → interval×ease days', () => {
    let c = Core.newSrs();
    c = { ...c, ...Core.schedule(c, Core.GRADES.GOOD, NOW) };
    assert.equal(c.interval, 1);
    c = { ...c, ...Core.schedule(c, Core.GRADES.GOOD, NOW) };
    assert.equal(c.interval, 3);
    c = { ...c, ...Core.schedule(c, Core.GRADES.GOOD, NOW) };
    assert.equal(c.interval, Math.round(3 * 2.5));
    assert.equal(c.due, NOW + c.interval * Core.DAY);
});

test('schedule: Again resets and lowers ease (never below 1.3)', () => {
    let c = { ...Core.newSrs(), reps: 5, interval: 30, ease: 1.35 };
    c = { ...c, ...Core.schedule(c, Core.GRADES.AGAIN, NOW) };
    assert.equal(c.reps, 0);
    assert.equal(c.interval, 0);
    assert.equal(c.lapses, 1);
    assert.equal(c.ease, 1.3);
    assert.equal(c.due, NOW + 10 * 60000);
});

test('schedule: Easy grows faster than Good', () => {
    const base = { ...Core.newSrs(), reps: 2, interval: 10 };
    assert.ok(Core.schedule(base, Core.GRADES.EASY, NOW).interval > Core.schedule(base, Core.GRADES.GOOD, NOW).interval);
});

test('isDue and cardStatus', () => {
    assert.equal(Core.isDue({ due: 0 }, NOW), true);
    assert.equal(Core.isDue({ due: NOW + 1 }, NOW), false);
    assert.equal(Core.cardStatus({}), 'new');
    assert.equal(Core.cardStatus({ lastReview: 1, interval: 3 }), 'learning');
    assert.equal(Core.cardStatus({ lastReview: 1, interval: 21 }), 'mastered');
});

test('levelInfo thresholds', () => {
    assert.equal(Core.levelInfo(0).level, 1);
    assert.equal(Core.levelInfo(49).level, 1);
    assert.equal(Core.levelInfo(50).level, 2);
    assert.equal(Core.levelInfo(200).level, 3);
    const info = Core.levelInfo(125);
    assert.ok(info.progress > 0 && info.progress < 1);
});

test('dayDiff / touchStreak', () => {
    assert.equal(Core.dayDiff('2026-03-28', '2026-03-29'), 1);
    assert.equal(Core.dayDiff('2026-10-24', '2026-10-26'), 2); // across a DST change
    const d = Core.defaultData();
    Core.touchStreak(d, '2026-01-01');
    assert.equal(d.streak, 1);
    Core.touchStreak(d, '2026-01-01');
    assert.equal(d.streak, 1);
    Core.touchStreak(d, '2026-01-02');
    assert.equal(d.streak, 2);
    Core.touchStreak(d, '2026-01-05');
    assert.equal(d.streak, 1);
    assert.equal(d.bestStreak, 2);
});

test('checkTypedAnswer', () => {
    assert.equal(Core.checkTypedAnswer('  Mitochondria ', 'mitochondria'), 'correct');
    assert.equal(Core.checkTypedAnswer('mitochondra', 'Mitochondria'), 'close');
    assert.equal(Core.checkTypedAnswer('Reykjavik', 'Reykjavík'), 'correct');
    assert.equal(Core.checkTypedAnswer('Pretoria', 'Pretoria (executive), Cape Town'), 'wrong');
    assert.equal(Core.checkTypedAnswer('el colegio', 'el colegio / la escuela'), 'correct');
    assert.equal(Core.checkTypedAnswer('Na', 'Na (from natrium)'), 'correct');
    assert.equal(Core.checkTypedAnswer('', 'x'), 'wrong');
    assert.equal(Core.checkTypedAnswer('banana', 'apple'), 'wrong');
});

test('pickDistractors returns unique wrong answers, same subject first', () => {
    const cards = [
        { id: '1', subject: 'A', back: 'one' },
        { id: '2', subject: 'A', back: 'two' },
        { id: '3', subject: 'A', back: 'three' },
        { id: '4', subject: 'B', back: 'four' },
        { id: '5', subject: 'A', back: 'ONE' },
    ];
    const d = Core.pickDistractors(cards[0], cards, 3);
    assert.equal(d.length, 3);
    assert.ok(!d.map(Core.normalizeText).includes('one'));
    assert.equal(new Set(d).size, 3);
    assert.ok(d.includes('two') && d.includes('three'));
});

test('CSV round-trip with quotes, commas and newlines', () => {
    const rows = [['front', 'back', 'subject'], ['Say "hi", then', 'line1\nline2', 'Eng'], ['a', 'b', '']];
    const parsed = Core.parseCsv(Core.toCsv(rows));
    assert.deepEqual(parsed, rows);
});

test('cardsFromCsv: header optional, tab/semicolon delimiters', () => {
    assert.deepEqual(Core.cardsFromCsv('Front,Back\nQ1,A1\nQ2,A2,Bio'), [
        { front: 'Q1', back: 'A1', subject: 'General' },
        { front: 'Q2', back: 'A2', subject: 'Bio' },
    ]);
    assert.equal(Core.cardsFromCsv('Q1\tA1\nQ2\tA2').length, 2);
    assert.equal(Core.cardsFromCsv('Q1;A1\nQ2;A2').length, 2);
    assert.equal(Core.cardsFromCsv('only one column\n,\n').length, 0);
});

test('mergeData merges by id, newest wins, tombstones delete', () => {
    const a = { ...Core.defaultData(), updatedAt: 10,
        flashcards: [{ id: 'x', front: 'old', back: 'b', updatedAt: 5 }, { id: 'y', front: 'y', back: 'b', updatedAt: 5 }],
        xp: 100, streak: 2, lastActiveDate: '2026-01-02', activityLog: { '2026-01-01': 3 } };
    const b = { ...Core.defaultData(), updatedAt: 20,
        flashcards: [{ id: 'x', front: 'new', back: 'b', updatedAt: 9 }, { id: 'z', front: 'z', back: 'b', updatedAt: 1 }],
        deleted: { y: 8 }, xp: 40, streak: 5, lastActiveDate: '2026-01-03', activityLog: { '2026-01-01': 1, '2026-01-02': 4 } };
    const m = Core.mergeData(a, b);
    assert.deepEqual(m.flashcards.map((c) => c.id).sort(), ['x', 'z']);
    assert.equal(m.flashcards.find((c) => c.id === 'x').front, 'new');
    assert.equal(m.xp, 100);
    assert.equal(m.streak, 5);
    assert.equal(m.lastActiveDate, '2026-01-03');
    assert.deepEqual(m.activityLog, { '2026-01-01': 3, '2026-01-02': 4 });
});

test('mergeData: edit after delete resurrects, delete after edit wins', () => {
    const edited = { ...Core.defaultData(), flashcards: [{ id: 'k', front: 'f', back: 'b', updatedAt: 50 }] };
    const del = (t) => ({ ...Core.defaultData(), deleted: { k: t } });
    assert.equal(Core.mergeData(edited, del(40)).flashcards.length, 1);
    assert.equal(Core.mergeData(edited, del(60)).flashcards.length, 0);
});

test('achievements unlock once', () => {
    const d = Core.defaultData();
    d.flashcards.push({ id: 'a', front: 'f', back: 'b' });
    const first = Core.checkAchievements(d, NOW);
    assert.ok(first.some((a) => a.id === 'first-card'));
    assert.equal(Core.checkAchievements(d, NOW).length, 0);
});
