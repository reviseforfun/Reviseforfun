/* ==========================================
   REVISEFORFUN - CORE LOGIC
   Pure, DOM-free helpers shared by the browser app and the Node backend
   (and unit-tested with `npm test`).
   ========================================== */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const DAY = 86400000;
    const DATA_VERSION = 2;
    const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
    const LETTER_RE = /[\p{L}\p{N}]/u; // "word" characters – punctuation is kept

    // ---------- Dates ----------
    /** 'YYYY-MM-DD' -> local midnight timestamp (NaN when the key is invalid). */
    function keyToTime(key) {
        if (typeof key !== 'string' || !DATE_KEY_RE.test(key)) return NaN;
        const [y, m, d] = key.split('-').map(Number);
        return new Date(y, m - 1, d).getTime();
    }

    /** Local calendar day as YYYY-MM-DD. */
    function dateKey(d = new Date()) {
        const dt = d instanceof Date ? d : new Date(d);
        const m = String(dt.getMonth() + 1).padStart(2, '0');
        const day = String(dt.getDate()).padStart(2, '0');
        return `${dt.getFullYear()}-${m}-${day}`;
    }

    /** Whole days between two YYYY-MM-DD keys (b - a), DST-safe. */
    function dayDiff(a, b) {
        const p = (k) => {
            const [y, m, d] = k.split('-').map(Number);
            return Date.UTC(y, m - 1, d);
        };
        return Math.round((p(b) - p(a)) / DAY);
    }

    // ---------- Default data ----------
    function defaultData() {
        return {
            version: DATA_VERSION,
            updatedAt: 0,
            flashcards: [],
            notes: [],
            deleted: {}, // tombstones: id -> timestamp (so deletions sync)
            quizHistory: [],
            installedDecks: [],
            achievements: {}, // id -> unlocked timestamp
            activityLog: {}, // date -> activity count
            reviewLog: {}, // date -> cards reviewed
            exams: {}, // subject -> 'YYYY-MM-DD'
            freezesEarned: 0, // streak freezes banked over time
            freezesUsed: 0, // streak freezes spent
            pomodoroSessions: 0,
            totalStudyMinutes: 0,
            streak: 0,
            bestStreak: 0,
            lastActiveDate: null,
            xp: 0,
            totalReviews: 0,
            dailyGoal: 20,
            theme: 'light',
            pomodoroSettings: { work: 25, short: 5, long: 15, autoStart: true, sound: true },
        };
    }

    // ---------- Spaced repetition (SM-2 variant) ----------
    const GRADES = { AGAIN: 1, HARD: 2, GOOD: 3, EASY: 4 };

    function newSrs() {
        return { ease: 2.5, interval: 0, reps: 0, lapses: 0, due: 0, lastReview: 0 };
    }

    /**
     * Returns the new scheduling fields for a card after a review.
     * interval is in days; "Again" re-queues the card in 10 minutes.
     */
    function schedule(card, grade, now = Date.now()) {
        let ease = card.ease || 2.5;
        let interval = card.interval || 0;
        let reps = card.reps || 0;
        let lapses = card.lapses || 0;
        let due;

        if (grade === GRADES.AGAIN) {
            if (reps > 0) lapses += 1; // forgetting a brand-new card isn't a lapse
            reps = 0;
            interval = 0;
            ease = Math.max(1.3, ease - 0.2);
            due = now + 10 * 60000;
        } else {
            if (grade === GRADES.HARD) {
                interval = reps === 0 ? 1 : Math.max(1, Math.round(interval * 1.2));
                ease = Math.max(1.3, ease - 0.15);
            } else if (grade === GRADES.GOOD) {
                interval = reps === 0 ? 1 : reps === 1 ? 3 : Math.round(interval * ease);
            } else {
                interval = reps === 0 ? 4 : Math.round(interval * ease * 1.3);
                ease += 0.15;
            }
            interval = Math.min(Math.max(interval, 1), 3650);
            reps += 1;
            due = now + interval * DAY;
        }
        return { ease: Math.round(ease * 100) / 100, interval, reps, lapses, due, lastReview: now };
    }

    function isDue(card, now = Date.now()) {
        return !card.due || card.due <= now;
    }

    /** new | learning | mastered */
    function cardStatus(card) {
        if (!card.lastReview) return 'new';
        return (card.interval || 0) >= 21 ? 'mastered' : 'learning';
    }

    // ---------- XP / levels ----------
    function levelInfo(xp) {
        const safe = Math.max(0, Math.floor(xp || 0));
        const level = Math.floor(Math.sqrt(safe / 50)) + 1;
        const base = 50 * (level - 1) * (level - 1);
        const next = 50 * level * level;
        return { level, xp: safe, base, next, progress: (safe - base) / (next - base) };
    }

    // ---------- Streaks & streak freezes ----------
    const FREEZE_EVERY = 7; // earn a freeze every 7-day streak
    const FREEZE_BANK = 2; // never bank more than two

    /** How many streak freezes are in the bank right now. */
    function freezesAvailable(data) {
        const earned = Math.max(0, Math.floor((data && data.freezesEarned) || 0));
        const used = Math.max(0, Math.floor((data && data.freezesUsed) || 0));
        return Math.min(FREEZE_BANK, Math.max(0, earned - used));
    }

    /**
     * Is the streak still alive? Yesterday/today counts as alive, and one
     * missed day is survivable when a freeze is banked.
     */
    function streakAlive(data, today = dateKey()) {
        const last = data && data.lastActiveDate;
        if (!last || !DATE_KEY_RE.test(last) || !(data.streak > 0)) return false;
        const gap = dayDiff(last, today);
        if (gap <= 1) return true;
        if (gap === 2) return freezesAvailable(data) > 0;
        return false;
    }

    /**
     * Mutates data: updates streak/lastActiveDate for the given day.
     * A banked freeze is spent automatically to bridge a single missed day,
     * and every 7-day streak (only when the streak actually grew) banks a new
     * freeze – up to FREEZE_BANK at a time.
     */
    function touchStreak(data, today = dateKey()) {
        data.freezesEarned = Math.max(0, Math.floor(data.freezesEarned || 0));
        data.freezesUsed = Math.max(0, Math.floor(data.freezesUsed || 0));
        const last = data.lastActiveDate;
        if (last === today) return data;
        const gap = last && DATE_KEY_RE.test(last) ? dayDiff(last, today) : Infinity;
        if (gap <= 0) { // clock moved backwards – never punish the student
            data.lastActiveDate = today;
            return data;
        }

        let grew = false;
        let froze = false;
        if (gap === 1) {
            data.streak = (data.streak || 0) + 1;
            grew = true;
        } else if (gap === 2 && freezesAvailable(data) > 0) {
            data.freezesUsed += 1; // the freeze bridges yesterday
            data.streak = (data.streak || 0) + 1;
            grew = true;
            froze = true;
        } else {
            data.streak = 1;
        }
        data.lastActiveDate = today;
        if (grew && data.streak % FREEZE_EVERY === 0 && freezesAvailable(data) < FREEZE_BANK) {
            data.freezesEarned += 1;
        }
        data.bestStreak = Math.max(data.bestStreak || 0, data.streak);
        return data;
    }

    // ---------- Revision planner (retrievability, exams, workload) ----------
    /**
     * Probability you would still recall `card` at time `at`, using the classic
     * forgetting curve: R = 0.9 ^ (days since review / interval).
     * Cards that have never been reviewed have no memory to lose -> 0.
     */
    function retrievability(card, at = Date.now()) {
        if (!card || !card.lastReview) return 0;
        const interval = Math.max(Number(card.interval) || 0, 0.25);
        const elapsedDays = Math.max(0, (at - card.lastReview) / DAY);
        return Math.pow(0.9, elapsedDays / interval);
    }

    /** Mean retrievability of a set of cards (0..1). Unseen cards count as 0. */
    function readiness(cards, now = Date.now()) {
        const list = Array.isArray(cards) ? cards : [];
        if (!list.length) return 0;
        let sum = 0;
        for (const c of list) sum += retrievability(c, now);
        return sum / list.length;
    }

    /**
     * Everything the Plan page needs about one exam.
     * `newPerDay` leaves a 3-day review buffer, but only when there is more
     * than a week to go (cramming the last three days helps nobody).
     */
    function examPlan(cards, examKey, today = dateKey(), now = Date.now()) {
        const list = Array.isArray(cards) ? cards : [];
        const examTime = keyToTime(examKey);
        const hasExam = Number.isFinite(examTime);
        const daysLeft = hasExam ? dayDiff(today, examKey) : null;
        const unseen = list.filter((c) => c && !c.lastReview).length;
        const buffer = daysLeft !== null && daysLeft > 7 ? 3 : 0;
        const learnDays = Math.max(1, (daysLeft === null ? 1 : daysLeft) - buffer);
        return {
            daysLeft,
            total: list.length,
            unseen,
            readinessNow: readiness(list, now),
            readinessAtExam: hasExam ? readiness(list, examTime) : readiness(list, now),
            newPerDay: Math.ceil(unseen / learnDays),
        };
    }

    /**
     * Review workload for the next `days` days.
     * Index 0 = everything overdue plus what falls due today.
     */
    function dueForecast(cards, days = 14, today = dateKey()) {
        const n = Math.max(1, Math.floor(days) || 14);
        const out = new Array(n).fill(0);
        for (const c of cards || []) {
            const due = Number(c && c.due) || 0;
            if (!due) continue; // brand-new cards are not review work
            const idx = dayDiff(today, dateKey(new Date(due)));
            if (idx <= 0) out[0] += 1;
            else if (idx < n) out[idx] += 1;
        }
        return out;
    }

    /**
     * The cards that hurt the most: reviewed cards that have been forgotten
     * (lapses) or have a low ease. Scored so the worst float to the top.
     * Returns copies with `weakScore` attached – appData is never mutated.
     */
    function weakCards(cards, limit = 10) {
        const scored = [];
        for (const c of cards || []) {
            if (!c || !c.lastReview) continue;
            const lapses = Number(c.lapses) || 0;
            const ease = Number(c.ease) || 2.5;
            if (lapses <= 0 && ease >= 2.1) continue;
            scored.push({ ...c, weakScore: lapses * 3 + Math.max(0, 2.5 - ease) * 4 });
        }
        scored.sort((a, b) => b.weakScore - a.weakScore || (a.due || 0) - (b.due || 0));
        return scored.slice(0, Math.max(0, Number(limit) || 0));
    }

    /**
     * Progressive hint for an answer. Level 1 reveals the first letter of every
     * word, level 2 reveals the first half of the letters. Punctuation and
     * spacing are always kept so the shape of the answer stays readable.
     */
    function hint(answer, level = 1) {
        const text = String(answer == null ? '' : answer);
        const lv = Math.max(0, Math.min(2, Math.floor(Number(level) || 0)));
        if (!lv) return '';
        return text.replace(/\S+/g, (word) => {
            const chars = [...word];
            const letters = chars.filter((ch) => LETTER_RE.test(ch)).length;
            const reveal = lv === 1 ? 1 : Math.ceil(letters / 2);
            let seen = 0;
            return chars.map((ch) => {
                if (!LETTER_RE.test(ch)) return ch; // keep punctuation
                seen += 1;
                return seen <= reveal ? ch : '_';
            }).join('');
        });
    }

    /** The cards you are closest to forgetting – first stop for a boost session. */
    function lowestRetrievability(cards, limit = 30, now = Date.now()) {
        const reviewed = (Array.isArray(cards) ? cards : []).filter((c) => c && c.lastReview);
        return reviewed
            .map((c) => ({ card: c, r: retrievability(c, now) }))
            .sort((a, b) => a.r - b.r || (a.card.due || 0) - (b.card.due || 0))
            .slice(0, Math.max(0, Number(limit) || 0))
            .map((x) => x.card);
    }

    // ---------- Achievements ----------
    const ACHIEVEMENTS = [
        { id: 'first-card', icon: '🎴', name: 'Card Collector', desc: 'Have your first flashcard', test: (d) => d.flashcards.length >= 1 },
        { id: 'hundred-cards', icon: '🗂️', name: 'Card Hoarder', desc: 'Own 100 flashcards', test: (d) => d.flashcards.length >= 100 },
        { id: 'first-deck', icon: '📦', name: 'Deck Builder', desc: 'Install a preset deck', test: (d) => d.installedDecks.length >= 1 },
        { id: 'five-decks', icon: '📚', name: 'Bookworm', desc: 'Install 5 preset decks', test: (d) => d.installedDecks.length >= 5 },
        { id: 'first-review', icon: '👀', name: 'First Flip', desc: 'Review your first card', test: (d) => d.totalReviews >= 1 },
        { id: 'reviews-100', icon: '💯', name: 'Century', desc: 'Review 100 cards', test: (d) => d.totalReviews >= 100 },
        { id: 'reviews-500', icon: '🚀', name: 'Memory Machine', desc: 'Review 500 cards', test: (d) => d.totalReviews >= 500 },
        { id: 'first-quiz', icon: '🧠', name: 'Quiz Starter', desc: 'Complete a quiz', test: (d) => d.quizHistory.length >= 1 },
        { id: 'perfect-quiz', icon: '🏆', name: 'Flawless', desc: 'Score 100% on a quiz of 5+ questions', test: (d) => d.quizHistory.some((q) => q.percentage === 100 && q.total >= 5) },
        { id: 'streak-3', icon: '🔥', name: 'On Fire', desc: '3-day streak', test: (d) => (d.bestStreak || 0) >= 3 },
        { id: 'streak-7', icon: '🌋', name: 'Unstoppable', desc: '7-day streak', test: (d) => (d.bestStreak || 0) >= 7 },
        { id: 'streak-30', icon: '👑', name: 'Revision Royalty', desc: '30-day streak', test: (d) => (d.bestStreak || 0) >= 30 },
        { id: 'first-pomodoro', icon: '🍅', name: 'Focus Time', desc: 'Finish a Pomodoro session', test: (d) => d.pomodoroSessions >= 1 },
        { id: 'note-taker', icon: '📝', name: 'Note Taker', desc: 'Write 5 notes', test: (d) => d.notes.length >= 5 },
        { id: 'level-5', icon: '⭐', name: 'Rising Star', desc: 'Reach level 5', test: (d) => levelInfo(d.xp).level >= 5 },
        { id: 'level-10', icon: '🌟', name: 'Scholar', desc: 'Reach level 10', test: (d) => levelInfo(d.xp).level >= 10 },
        { id: 'goal-hit', icon: '🎯', name: 'Goal Getter', desc: 'Hit your daily review goal', test: (d) => (d.reviewLog[dateKey()] || 0) >= (d.dailyGoal || 20) },
        { id: 'match-win', icon: '🧩', name: 'Pair Pro', desc: 'Win a Match game', test: (d) => (d.matchWins || 0) >= 1 },
        { id: 'mastered-25', icon: '🎓', name: 'Master Mind', desc: 'Master 25 cards (21+ day interval)', test: (d) => d.flashcards.filter((c) => cardStatus(c) === 'mastered').length >= 25 },
    ];

    /** Mutates data.achievements; returns the achievement objects just unlocked. */
    function checkAchievements(data, now = Date.now()) {
        const unlocked = [];
        for (const a of ACHIEVEMENTS) {
            if (!data.achievements[a.id] && a.test(data)) {
                data.achievements[a.id] = now;
                unlocked.push(a);
            }
        }
        return unlocked;
    }

    // ---------- Text helpers ----------
    function normalizeText(s) {
        return String(s || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9\u0370-\u03ff\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function levenshtein(a, b) {
        if (a === b) return 0;
        if (!a.length) return b.length;
        if (!b.length) return a.length;
        let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
        for (let i = 1; i <= a.length; i++) {
            const cur = [i];
            for (let j = 1; j <= b.length; j++) {
                cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            }
            prev = cur;
        }
        return prev[b.length];
    }

    /** 'correct' | 'close' | 'wrong' for typed-answer quizzes. */
    function checkTypedAnswer(input, expected) {
        const a = normalizeText(input);
        const b = normalizeText(expected);
        if (!a) return 'wrong';
        if (a === b) return 'correct';
        const sim = 1 - levenshtein(a, b) / Math.max(a.length, b.length);
        if (sim >= 0.85) return 'close';
        // Allow the main word(s) of "X / Y" or "X (extra)" answers
        const alts = String(expected).split(/\s*(?:\/|;| or )\s*/).map(normalizeText).filter(Boolean);
        if (alts.length > 1 && alts.includes(a)) return 'correct';
        const stripped = normalizeText(String(expected).replace(/\(.*?\)/g, ''));
        if (stripped && stripped === a) return 'correct';
        return 'wrong';
    }

    function shuffle(arr, rng = Math.random) {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
        return arr;
    }

    /** Picks `n` plausible wrong answers for `card`, preferring the same subject. */
    function pickDistractors(card, cards, n = 3, rng = Math.random) {
        const seen = new Set([normalizeText(card.back)]);
        const out = [];
        const take = (list) => {
            for (const c of shuffle([...list], rng)) {
                const key = normalizeText(c.back);
                if (out.length >= n) return;
                if (!key || seen.has(key)) continue;
                seen.add(key);
                out.push(c.back);
            }
        };
        const others = cards.filter((c) => c.id !== card.id);
        take(others.filter((c) => c.subject === card.subject));
        take(others);
        return out;
    }

    // ---------- CSV ----------
    function detectDelimiter(text) {
        const first = text.split(/\r?\n/, 1)[0] || '';
        const counts = { '\t': 0, ';': 0, ',': 0 };
        let inQ = false;
        for (const ch of first) {
            if (ch === '"') inQ = !inQ;
            else if (!inQ && ch in counts) counts[ch]++;
        }
        return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][1] > 0
            ? Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]
            : ',';
    }

    function parseCsv(text, delimiter) {
        const delim = delimiter || detectDelimiter(text);
        const rows = [];
        let row = [];
        let field = '';
        let inQ = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (inQ) {
                if (ch === '"') {
                    if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
                } else field += ch;
            } else if (ch === '"' && field === '') inQ = true;
            else if (ch === delim) { row.push(field); field = ''; }
            else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && text[i + 1] === '\n') i++;
                row.push(field); field = '';
                if (row.some((c) => c.trim() !== '')) rows.push(row);
                row = [];
            } else field += ch;
        }
        row.push(field);
        if (row.some((c) => c.trim() !== '')) rows.push(row);
        return rows;
    }

    function csvEscape(v) {
        const s = String(v == null ? '' : v);
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }

    function toCsv(rows) {
        return rows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n';
    }

    /** CSV text -> [{front, back, subject}] (header row optional). */
    function cardsFromCsv(text, defaultSubject = 'General') {
        let rows = parseCsv(text);
        if (rows.length && /^(front|question|term)$/i.test((rows[0][0] || '').trim())) rows = rows.slice(1);
        const cards = [];
        for (const r of rows) {
            const front = (r[0] || '').trim();
            const back = (r[1] || '').trim();
            if (front && back) cards.push({ front, back, subject: (r[2] || '').trim() || defaultSubject });
        }
        return cards;
    }

    // ---------- Merge (used by the backend for cloud sync) ----------
    function mergeById(a, b, deleted) {
        const map = new Map();
        for (const item of [...(a || []), ...(b || [])]) {
            if (!item || !item.id) continue;
            const cur = map.get(item.id);
            if (!cur || (item.updatedAt || 0) >= (cur.updatedAt || 0)) map.set(item.id, item);
        }
        return [...map.values()].filter((item) => !((deleted[item.id] || 0) >= (item.updatedAt || 0) && deleted[item.id]));
    }

    function maxMap(a = {}, b = {}) {
        const out = { ...a };
        for (const [k, v] of Object.entries(b)) out[k] = Math.max(out[k] || 0, v || 0);
        return out;
    }

    /**
     * Merges two app-data documents without losing work from either side.
     * Items merge by id (newest updatedAt wins), deletions are tombstoned,
     * counters keep the larger value and settings come from the newer doc.
     */
    function mergeData(a, b) {
        const base = defaultData();
        a = { ...base, ...(a || {}) };
        b = { ...base, ...(b || {}) };
        const newer = (b.updatedAt || 0) >= (a.updatedAt || 0) ? b : a;
        const deleted = maxMap(a.deleted, b.deleted);

        const quiz = new Map();
        for (const q of [...a.quizHistory, ...b.quizHistory]) if (q && q.id) quiz.set(q.id, q);

        const merged = {
            ...base,
            version: DATA_VERSION,
            updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
            flashcards: mergeById(a.flashcards, b.flashcards, deleted),
            notes: mergeById(a.notes, b.notes, deleted),
            deleted,
            quizHistory: [...quiz.values()].sort((x, y) => (x.date || 0) - (y.date || 0)).slice(-500),
            installedDecks: [...new Set([...a.installedDecks, ...b.installedDecks])],
            achievements: (() => {
                const out = { ...a.achievements };
                for (const [k, v] of Object.entries(b.achievements)) out[k] = Math.min(out[k] || v, v || out[k]);
                return out;
            })(),
            activityLog: maxMap(a.activityLog, b.activityLog),
            reviewLog: maxMap(a.reviewLog, b.reviewLog),
            // Exam dates come from the newer document: clearing a date must stick.
            exams: { ...(newer.exams && typeof newer.exams === 'object' ? newer.exams : {}) },
            freezesEarned: Math.max(a.freezesEarned || 0, b.freezesEarned || 0),
            freezesUsed: Math.max(a.freezesUsed || 0, b.freezesUsed || 0),
            pomodoroSessions: Math.max(a.pomodoroSessions, b.pomodoroSessions),
            totalStudyMinutes: Math.max(a.totalStudyMinutes, b.totalStudyMinutes),
            bestStreak: Math.max(a.bestStreak || 0, b.bestStreak || 0),
            xp: Math.max(a.xp, b.xp),
            totalReviews: Math.max(a.totalReviews, b.totalReviews),
            matchWins: Math.max(a.matchWins || 0, b.matchWins || 0),
            dailyGoal: newer.dailyGoal,
            theme: newer.theme,
            pomodoroSettings: { ...base.pomodoroSettings, ...newer.pomodoroSettings },
        };
        const latest = [a, b].sort((x, y) => (y.lastActiveDate || '').localeCompare(x.lastActiveDate || ''))[0];
        merged.lastActiveDate = latest.lastActiveDate || null;
        merged.streak = [a, b].filter((d) => d.lastActiveDate === merged.lastActiveDate)
            .reduce((m, d) => Math.max(m, d.streak || 0), 0);
        return merged;
    }

    return {
        DAY, DATA_VERSION, GRADES, ACHIEVEMENTS, FREEZE_EVERY, FREEZE_BANK,
        dateKey, dayDiff, keyToTime, defaultData, newSrs, schedule, isDue, cardStatus,
        levelInfo, touchStreak, freezesAvailable, streakAlive, checkAchievements,
        retrievability, readiness, examPlan, dueForecast, weakCards, hint, lowestRetrievability,
        normalizeText, levenshtein, checkTypedAnswer, shuffle, pickDistractors,
        parseCsv, toCsv, cardsFromCsv, mergeData,
    };
});
