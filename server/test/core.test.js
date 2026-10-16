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

// ==================== 3.0: freezes, planner, hints ====================
const DAY = Core.DAY;

test('defaultData carries exams and freeze counters', () => {
    const d = Core.defaultData();
    assert.deepEqual(d.exams, {});
    assert.equal(d.freezesEarned, 0);
    assert.equal(d.freezesUsed, 0);
});

test('streak freezes: one earned every 7-day streak, banked at most 2', () => {
    const d = Core.defaultData();
    const day = (n) => `2026-01-${String(n).padStart(2, '0')}`;
    for (let i = 1; i <= 7; i++) Core.touchStreak(d, day(i));
    assert.equal(d.streak, 7);
    assert.equal(d.freezesEarned, 1, 'a 7-day streak banks one freeze');
    assert.equal(Core.freezesAvailable(d), 1);

    for (let i = 8; i <= 14; i++) Core.touchStreak(d, day(i));
    assert.equal(d.freezesEarned, 2);

    for (let i = 15; i <= 21; i++) Core.touchStreak(d, day(i));
    assert.equal(d.streak, 21);
    assert.equal(d.freezesEarned, 2, 'the bank never holds more than two');
    assert.equal(Core.freezesAvailable(d), 2);
});

test('streak freezes are only earned when the streak grows', () => {
    const d = Core.defaultData();
    for (let i = 1; i <= 7; i++) Core.touchStreak(d, `2026-01-0${i}`);
    assert.equal(d.freezesEarned, 1);
    Core.touchStreak(d, '2026-01-07'); // same day again
    Core.touchStreak(d, '2026-01-07');
    assert.equal(d.freezesEarned, 1);
    assert.equal(d.streak, 7);
});

test('a freeze bridges one missed day, two missed days break the streak', () => {
    const d = Core.defaultData();
    d.freezesEarned = 1;
    d.streak = 5;
    d.lastActiveDate = '2026-03-01';
    assert.equal(Core.streakAlive(d, '2026-03-03'), true, 'one gap + one freeze = alive');

    Core.touchStreak(d, '2026-03-03');
    assert.equal(d.streak, 6, 'the freeze bridged the missed day');
    assert.equal(d.freezesUsed, 1);
    assert.equal(Core.freezesAvailable(d), 0);

    Core.touchStreak(d, '2026-03-06'); // three days later, nothing in the bank
    assert.equal(d.streak, 1);
    assert.equal(Core.streakAlive(d, '2026-03-06'), true);
    assert.equal(Core.streakAlive(d, '2026-03-08'), false);
});

test('streakAlive: yesterday, today and a banked freeze', () => {
    const base = { streak: 4, lastActiveDate: '2026-03-01', freezesEarned: 0, freezesUsed: 0 };
    assert.equal(Core.streakAlive(base, '2026-03-01'), true);
    assert.equal(Core.streakAlive(base, '2026-03-02'), true);
    assert.equal(Core.streakAlive(base, '2026-03-03'), false);
    assert.equal(Core.streakAlive({ ...base, freezesEarned: 1 }, '2026-03-03'), true);
    assert.equal(Core.streakAlive({ ...base, streak: 0 }, '2026-03-01'), false);
    assert.equal(Core.streakAlive(Core.defaultData(), '2026-03-01'), false);
});

test('mergeData takes the max of the freeze counters', () => {
    const a = { ...Core.defaultData(), updatedAt: 10, freezesEarned: 3, freezesUsed: 1 };
    const b = { ...Core.defaultData(), updatedAt: 20, freezesEarned: 1, freezesUsed: 2 };
    const m = Core.mergeData(a, b);
    assert.equal(m.freezesEarned, 3);
    assert.equal(m.freezesUsed, 2);
    assert.equal(Core.freezesAvailable(m), 1);
});

test('mergeData: exam dates come from the newer document (removing one sticks)', () => {
    const old = { ...Core.defaultData(), updatedAt: 10, exams: { Biology: '2026-05-12', Maths: '2026-05-20' } };
    const newer = { ...Core.defaultData(), updatedAt: 99, exams: { Biology: '2026-05-12' } };
    assert.deepEqual(Core.mergeData(old, newer).exams, { Biology: '2026-05-12' }, 'Maths was cleared on the newer device');
    assert.deepEqual(Core.mergeData(newer, old).exams, { Biology: '2026-05-12' }, 'and the newer doc still wins when it is the first argument');
    const edited = { ...Core.defaultData(), updatedAt: 100, exams: { Biology: '2026-06-01' } };
    assert.deepEqual(Core.mergeData(newer, edited).exams, { Biology: '2026-06-01' });
});

test('retrievability follows 0.9^(days/interval) and is 0 for unseen cards', () => {
    const card = { lastReview: NOW, interval: 10 };
    assert.equal(Core.retrievability(card, NOW), 1);
    assert.ok(Math.abs(Core.retrievability(card, NOW + 10 * DAY) - 0.9) < 1e-12);
    assert.ok(Math.abs(Core.retrievability(card, NOW + 20 * DAY) - 0.81) < 1e-12);
    assert.equal(Core.retrievability({ interval: 10 }, NOW), 0, 'never reviewed');
    assert.equal(Core.retrievability(null, NOW), 0);
    // A card with a tiny interval is floored at a quarter of a day.
    assert.ok(Math.abs(Core.retrievability({ lastReview: NOW, interval: 0 }, NOW + DAY) - Math.pow(0.9, 1 / 0.25)) < 1e-12);
    assert.ok(Core.retrievability(card, NOW - DAY) <= 1, 'the future cannot beat 1');
});

test('readiness averages retrievability, unseen cards count as zero', () => {
    assert.equal(Core.readiness([]), 0);
    const cards = [{ lastReview: NOW, interval: 10 }, { lastReview: NOW, interval: 10 }, {}];
    assert.ok(Math.abs(Core.readiness(cards, NOW) - 2 / 3) < 1e-12);
    assert.ok(Core.readiness(cards, NOW + 10 * DAY) < Core.readiness(cards, NOW));
});

test('examPlan: countdown, unseen, projections and new-per-day', () => {
    const today = '2026-05-01';
    const now = Core.keyToTime(today) + 12 * 3600 * 1000;
    const cards = [
        { id: 'a', lastReview: now, interval: 10 },
        { id: 'b', lastReview: now - 5 * DAY, interval: 5 },
        { id: 'c' },
    ];
    const plan = Core.examPlan(cards, '2026-05-20', today, now);
    assert.equal(plan.daysLeft, 19);
    assert.equal(plan.total, 3);
    assert.equal(plan.unseen, 1);
    assert.ok(plan.readinessNow > 0.6 && plan.readinessNow < 0.7);
    assert.ok(plan.readinessAtExam < plan.readinessNow, 'memory decays by exam day');
    assert.equal(plan.newPerDay, Math.ceil(1 / (19 - 3)), 'a 3-day review buffer when there is over a week left');

    const soon = Core.examPlan(cards, '2026-05-06', today, now);
    assert.equal(soon.daysLeft, 5);
    assert.equal(soon.newPerDay, Math.ceil(1 / 5), 'no buffer with less than a week to go');

    const past = Core.examPlan(cards, '2026-04-01', today, now);
    assert.equal(past.daysLeft, -30);
    assert.equal(past.newPerDay, 1);

    const none = Core.examPlan(cards, null, today, now);
    assert.equal(none.daysLeft, null);
    assert.equal(none.readinessAtExam, none.readinessNow);

    assert.equal(Core.examPlan([], '2026-05-20', today, now).readinessNow, 0);
});

test('keyToTime parses local date keys', () => {
    const t = Core.keyToTime('2026-05-12');
    assert.equal(Core.dateKey(new Date(t)), '2026-05-12');
    assert.equal(new Date(t).getHours(), 0);
    assert.ok(Number.isNaN(Core.keyToTime('nope')));
    assert.ok(Number.isNaN(Core.keyToTime(null)));
});

test('dueForecast: index 0 is overdue plus today', () => {
    const today = '2026-05-01';
    const at = (key, hours = 12) => Core.keyToTime(key) + hours * 3600 * 1000;
    const cards = [
        { id: 'over', due: at('2026-04-20') },
        { id: 'today', due: at(today, 1) },
        { id: 'd3', due: at('2026-05-04') },
        { id: 'd3b', due: at('2026-05-04', 20) },
        { id: 'far', due: at('2026-06-01') },
        { id: 'unseen', due: 0 },
    ];
    const f = Core.dueForecast(cards, 14, today);
    assert.equal(f.length, 14);
    assert.equal(f[0], 2, 'overdue + today');
    assert.equal(f[3], 2);
    assert.equal(f.reduce((a, b) => a + b, 0), 4, 'the far-off card falls outside the window, unseen cards are not review work');
    assert.equal(Core.dueForecast([], 14, today).length, 14);
    assert.equal(Core.dueForecast(cards, 3, today).length, 3);
});

test('weakCards: lapses and low ease, scored and sorted', () => {
    const cards = [
        { id: 'a', lastReview: 1, lapses: 2, ease: 2.5 },   // 6
        { id: 'b', lastReview: 1, lapses: 0, ease: 1.8 },   // 2.8
        { id: 'c', lastReview: 1, lapses: 1, ease: 2.0 },   // 5
        { id: 'd', lastReview: 1, lapses: 0, ease: 2.5 },   // healthy
        { id: 'e', lapses: 9, ease: 1.3 },                  // never reviewed
    ];
    const weak = Core.weakCards(cards, 10);
    assert.deepEqual(weak.map((c) => c.id), ['a', 'c', 'b']);
    assert.equal(weak[0].weakScore, 6);
    assert.ok(Math.abs(weak[2].weakScore - 2.8) < 1e-9);
    assert.equal(Core.weakCards(cards, 2).length, 2);
    assert.equal(Core.weakCards(cards, 0).length, 0);
    assert.equal(Core.weakCards([], 5).length, 0);
    const original = cards[0];
    assert.notEqual(weak[0], original, 'copies are returned – appData is never mutated');
    assert.equal(original.weakScore, undefined);
});

test('hint: first letters, then the first half, punctuation kept', () => {
    assert.equal(Core.hint('Paris', 1), 'P____');
    assert.equal(Core.hint('Paris', 2), 'Par__');
    assert.equal(Core.hint('The mitochondria!', 1), 'T__ m___________!');
    assert.equal(Core.hint('', 1), '');
    assert.equal(Core.hint('Oxygen', 0), '', 'level 0 reveals nothing');
    assert.equal(Core.hint('Oxygen', 9), 'Oxy___', 'levels are clamped to 2');

    const answer = 'DNA (deoxyribonucleic acid)';
    for (const level of [1, 2]) {
        const h = Core.hint(answer, level);
        const strip = (s) => s.replace(/[\p{L}\p{N}_]/gu, '');
        assert.equal(strip(h), strip(answer), 'punctuation and spacing survive');
        assert.equal(h.length, answer.length, 'same shape as the answer');
    }
    const one = Core.hint(answer, 1);
    const two = Core.hint(answer, 2);
    assert.ok(two.split('_').length < one.split('_').length, 'level 2 reveals more than level 1');
    assert.ok(one.startsWith('D__ (d'));
    assert.equal(Core.hint('Le pouvoir', 1), 'L_ p______', 'accents and other letters count as letters');
    assert.equal(Core.hint('El niño', 2), 'E_ ni__');
    assert.equal(Core.hint('6.02 × 10²³', 1), '6.__ × 1___', 'numbers and symbols are handled too');
});

test('lowestRetrievability picks the cards closest to being forgotten', () => {
    const now = NOW;
    const cards = [
        { id: 'fresh', lastReview: now, interval: 30 },
        { id: 'fading', lastReview: now - 20 * DAY, interval: 10 },
        { id: 'gone', lastReview: now - 60 * DAY, interval: 10 },
        { id: 'unseen', interval: 10 },
    ];
    assert.deepEqual(Core.lowestRetrievability(cards, 2, now).map((c) => c.id), ['gone', 'fading']);
    assert.equal(Core.lowestRetrievability(cards, 30, now).length, 3, 'unseen cards are not boost candidates');
});
