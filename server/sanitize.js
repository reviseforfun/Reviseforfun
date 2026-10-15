'use strict';
/**
 * Validates and normalises an untrusted study-data document from a client.
 * Anything unknown is dropped, strings are length-capped and numbers clamped.
 */
const { defaultData, DATA_VERSION } = require('../js/core');

const LIMITS = { cards: 10000, notes: 1000, quizzes: 500, logDays: 800, decks: 200 };
const ID_RE = /^[A-Za-z0-9_:.-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const str = (v, max, fallback = '') => (typeof v === 'string' ? v.slice(0, max) : fallback);
const num = (v, min = 0, max = 1e12, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
};
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);
const validId = (id) => typeof id === 'string' && ID_RE.test(id) && !BAD_KEYS.has(id);

function numberMap(v, keyRe, max, maxLen = 1e9) {
    const out = {};
    if (!v || typeof v !== 'object') return out;
    for (const [k, val] of Object.entries(v).slice(0, max)) {
        if (keyRe.test(k) && !BAD_KEYS.has(k)) out[k] = num(val, 0, maxLen);
    }
    return out;
}

function sanitizeCard(c) {
    if (!c || !validId(c.id)) return null;
    const front = str(c.front, 2000).trim();
    const back = str(c.back, 2000).trim();
    if (!front || !back) return null;
    return {
        id: c.id,
        subject: str(c.subject, 60, 'General').trim() || 'General',
        front,
        back,
        deckId: c.deckId && validId(c.deckId) ? c.deckId : undefined,
        starred: Boolean(c.starred),
        createdAt: num(c.createdAt),
        updatedAt: num(c.updatedAt),
        ease: num(c.ease, 1.3, 5, 2.5),
        interval: num(c.interval, 0, 3650),
        reps: num(c.reps, 0, 10000),
        lapses: num(c.lapses, 0, 10000),
        due: num(c.due),
        lastReview: num(c.lastReview),
    };
}

function sanitizeNote(n) {
    if (!n || !validId(n.id)) return null;
    return {
        id: n.id,
        title: str(n.title, 200),
        content: str(n.content, 100000),
        subject: str(n.subject, 60),
        createdAt: num(n.createdAt),
        updatedAt: num(n.updatedAt),
    };
}

function sanitizeQuiz(q) {
    if (!q || !validId(q.id)) return null;
    return {
        id: q.id,
        subject: str(q.subject, 60, 'All Subjects'),
        mode: str(q.mode, 20, 'choice'),
        score: num(q.score, 0, 1000),
        total: num(q.total, 0, 1000),
        percentage: num(q.percentage, 0, 100),
        date: num(q.date),
    };
}

function sanitizeDoc(input) {
    const base = defaultData();
    const d = input && typeof input === 'object' ? input : {};
    const ps = d.pomodoroSettings && typeof d.pomodoroSettings === 'object' ? d.pomodoroSettings : {};
    const lastActive = typeof d.lastActiveDate === 'string' && DATE_RE.test(d.lastActiveDate) ? d.lastActiveDate : null;
    return {
        version: DATA_VERSION,
        updatedAt: num(d.updatedAt),
        flashcards: arr(d.flashcards, LIMITS.cards).map(sanitizeCard).filter(Boolean),
        notes: arr(d.notes, LIMITS.notes).map(sanitizeNote).filter(Boolean),
        deleted: (() => {
            const out = {};
            if (d.deleted && typeof d.deleted === 'object') {
                for (const [k, v] of Object.entries(d.deleted).slice(0, 20000)) if (validId(k)) out[k] = num(v);
            }
            return out;
        })(),
        quizHistory: arr(d.quizHistory, LIMITS.quizzes).map(sanitizeQuiz).filter(Boolean),
        installedDecks: arr(d.installedDecks, LIMITS.decks).filter(validId),
        achievements: (() => {
            const out = {};
            if (d.achievements && typeof d.achievements === 'object') {
                for (const [k, v] of Object.entries(d.achievements).slice(0, 100)) if (validId(k)) out[k] = num(v);
            }
            return out;
        })(),
        activityLog: numberMap(d.activityLog, DATE_RE, LIMITS.logDays, 1e6),
        reviewLog: numberMap(d.reviewLog, DATE_RE, LIMITS.logDays, 1e6),
        pomodoroSessions: num(d.pomodoroSessions, 0, 1e6),
        totalStudyMinutes: num(d.totalStudyMinutes, 0, 1e7),
        streak: num(d.streak, 0, 100000),
        bestStreak: num(d.bestStreak, 0, 100000),
        lastActiveDate: lastActive,
        xp: num(d.xp, 0, 1e8),
        totalReviews: num(d.totalReviews, 0, 1e7),
        matchWins: num(d.matchWins, 0, 1e6),
        dailyGoal: num(d.dailyGoal, 1, 1000, base.dailyGoal),
        theme: d.theme === 'dark' ? 'dark' : 'light',
        pomodoroSettings: {
            work: num(ps.work, 1, 180, 25),
            short: num(ps.short, 1, 60, 5),
            long: num(ps.long, 1, 120, 15),
            autoStart: ps.autoStart !== false,
            sound: ps.sound !== false,
        },
    };
}

module.exports = { sanitizeDoc, LIMITS };
