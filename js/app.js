/* ==========================================
   REVISEFORFUN - APP SHELL
   State, persistence, navigation, gamification (XP / streaks / achievements),
   dashboard and statistics. Feature modules (cards.js, play.js, tools.js,
   community.js) build on the globals defined here.
   ========================================== */

// ==================== STATE ====================
const STORAGE_KEY = 'reviseforfun_data';
const FEATURED_DECKS = ['gk-study', 'bio-cells', 'chem-atoms', 'phys-energy', 'math-formulae', 'hist-ww1'];
const SUBJECT_COLORS = ['#6c5ce7', '#00cec9', '#fd79a8', '#fdcb6e', '#00b894', '#e17055', '#74b9ff', '#a29bfe'];

let appData = Core.defaultData();
let library = null; // preset decks, loaded lazily
let currentPage = 'home';

const actions = {}; // data-action handlers: (arg, element, event)
const inputs = {}; // data-input handlers: (element, event)
const renderers = {}; // page renderers: page -> fn()
const leaveHooks = []; // fn(oldPage, newPage)
const keyHandlers = []; // fn(event) => true if handled

// ==================== UTILITIES ====================
const $ = (id) => document.getElementById(id);

function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
}

function plural(n, word, pluralWord) {
    return `${n} ${n === 1 ? word : (pluralWord || word + 's')}`;
}

function formatDate(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'Just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    if (diff < 604800000) return Math.floor(diff / 86400000) + 'd ago';
    return date.toLocaleDateString('en-GB', {
        day: 'numeric', month: 'short', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
}

function formatMinutes(total) {
    const hours = Math.floor(total / 60);
    const mins = Math.round(total % 60);
    return hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function formatInterval(days) {
    if (days <= 0) return '<10m';
    if (days < 30) return `${days}d`;
    if (days < 365) return `${Math.round(days / 30)}mo`;
    return `${(days / 365).toFixed(1)}y`;
}

function showToast(message, type = 'info') {
    const container = $('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const icon = document.createElement('span');
    icon.textContent = { success: '✅', error: '❌', info: 'ℹ️' }[type] || 'ℹ️';
    const text = document.createElement('span');
    text.textContent = message;
    toast.append(icon, text);
    container.appendChild(toast);
    while (container.children.length > 4) container.firstChild.remove();
    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

function downloadFile(filename, text, type = 'text/plain') {
    // Older/embedded browsers (and jsdom) have no object URLs – fail softly.
    if (typeof URL.createObjectURL !== 'function' || typeof Blob !== 'function') {
        showToast('This browser cannot download files – copy the text instead.', 'error');
        return false;
    }
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
}

// ==================== PERSISTENCE ====================
function normalizeDate(value) {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const d = new Date(value); // legacy toDateString() format
    return Number.isNaN(d.getTime()) ? null : Core.dateKey(d);
}

/** Brings data from any older version up to the current shape. */
function migrate(raw) {
    const base = Core.defaultData();
    const d = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) };
    d.pomodoroSettings = { ...base.pomodoroSettings, ...(d.pomodoroSettings || {}) };
    for (const key of ['flashcards', 'notes', 'quizHistory', 'installedDecks']) if (!Array.isArray(d[key])) d[key] = [];
    for (const key of ['deleted', 'achievements', 'activityLog', 'reviewLog', 'exams']) {
        if (!d[key] || typeof d[key] !== 'object' || Array.isArray(d[key])) d[key] = {};
    }
    for (const [subject, key] of Object.entries(d.exams)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) delete d.exams[subject];
    }
    d.freezesEarned = Math.max(0, Math.floor(Number(d.freezesEarned) || 0));
    d.freezesUsed = Math.min(d.freezesEarned, Math.max(0, Math.floor(Number(d.freezesUsed) || 0)));
    const now = Date.now();
    d.flashcards = d.flashcards
        .filter((c) => c && c.front && c.back)
        .map((c) => ({
            ...Core.newSrs(),
            starred: false,
            createdAt: c.createdAt || now,
            updatedAt: c.updatedAt || c.createdAt || now,
            ...c,
            id: c.id || generateId(),
            subject: (c.subject || 'General').trim() || 'General',
        }));
    d.notes = d.notes.filter(Boolean).map((n) => ({
        subject: '', createdAt: now, ...n, id: n.id || generateId(), title: n.title || '', content: n.content || '',
        updatedAt: n.updatedAt || n.createdAt || now,
    }));
    d.lastActiveDate = normalizeDate(d.lastActiveDate);
    d.bestStreak = Math.max(d.bestStreak || 0, d.streak || 0);
    d.dailyGoal = Math.min(Math.max(parseInt(d.dailyGoal, 10) || 20, 1), 500);
    return d;
}

function loadData() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        appData = migrate(saved ? JSON.parse(saved) : null);
    } catch (e) {
        console.error('Failed to load data:', e);
        appData = migrate(null);
    }
}

let quotaWarned = false;
/** Saves to localStorage. Pass {silent:true} for changes that came from the server. */
function saveData({ silent = false } = {}) {
    if (!silent) {
        appData.updatedAt = Date.now();
        if (typeof Sync !== 'undefined') Sync.markDirty();
    }
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
    } catch (e) {
        console.error('Failed to save data:', e);
        if (!quotaWarned) {
            quotaWarned = true;
            showToast('Could not save – your browser storage may be full or disabled.', 'error');
        }
    }
}

// ==================== THEME ====================
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    document.querySelector('.theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#0f1117' : '#6c5ce7';
}

actions['toggle-theme'] = () => {
    appData.theme = appData.theme === 'dark' ? 'light' : 'dark';
    applyTheme(appData.theme);
    saveData();
};

// ==================== NAVIGATION ====================
const PAGES = ['home', 'plan', 'library', 'flashcards', 'quiz', 'games', 'notes', 'pomodoro', 'stats', 'community'];

/** `#community?verify=abc` is still the community page – the query is a deep link. */
function pageFromHash(hash = location.hash) {
    const p = String(hash || '').replace(/^#/, '').split('?')[0];
    return PAGES.includes(p) ? p : 'home';
}

/** Query part of the current hash route, e.g. `#community?verify=TOKEN`. */
function hashParams(hash = location.hash) {
    const raw = String(hash || '').replace(/^#/, '');
    const i = raw.indexOf('?');
    return new URLSearchParams(i === -1 ? '' : raw.slice(i + 1));
}

/** Strip the deep-link token from the address bar (it must not be shareable/bookmarked). */
function clearHashParams(page = pageFromHash()) {
    if (!location.hash.includes('?')) return;
    history.replaceState(null, '', `#${page}`);
}

function showPage(page) {
    if (!PAGES.includes(page)) page = 'home';
    if (pageFromHash(location.hash) !== page || location.hash.includes('?')) history.pushState(null, '', `#${page}`); // no hashchange event
    renderPage(page);
}

function renderPage(page) {
    const previous = currentPage;
    leaveHooks.forEach((fn) => fn(previous, page));
    currentPage = page;
    document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === `page-${page}`));
    document.querySelectorAll('.nav-link').forEach((l) => l.classList.toggle('active', l.dataset.page === page));
    $('nav-links').classList.remove('active');
    if (renderers[page]) renderers[page]();
    updateChrome();
    if (previous !== page) window.scrollTo({ top: 0, behavior: 'auto' });
}

actions.goto = (page) => { closeModals(); showPage(page); };
actions['toggle-menu'] = () => $('nav-links').classList.toggle('active');

// ==================== GAMIFICATION ====================
/**
 * Streak display: a streak that wasn't continued yesterday or today is over –
 * unless a banked freeze can still bridge the missed day.
 */
function currentStreak() {
    return Core.streakAlive(appData) ? appData.streak : 0;
}

function freezesLeft() {
    return Core.freezesAvailable(appData);
}

function award(xp) {
    if (!xp) return;
    const before = Core.levelInfo(appData.xp).level;
    appData.xp += xp;
    const after = Core.levelInfo(appData.xp).level;
    if (after > before) showToast(`Level up! You're now level ${after} 🎉`, 'success');
}

/** Call whenever the user does something that counts as studying. */
function recordActivity(count = 1) {
    const today = Core.dateKey();
    Core.touchStreak(appData, today);
    appData.activityLog[today] = (appData.activityLog[today] || 0) + count;
}

/** Persist, check achievements and refresh the nav chrome. */
function commit() {
    for (const a of Core.checkAchievements(appData)) showToast(`${a.icon} Achievement unlocked: ${a.name}`, 'success');
    saveData();
    updateChrome();
}

function dueCards(subject = 'all') {
    const now = Date.now();
    return appData.flashcards.filter((c) => (subject === 'all' || c.subject === subject) && Core.isDue(c, now));
}

function updateChrome() {
    $('streak-count').textContent = currentStreak();
    $('nav-level').textContent = Core.levelInfo(appData.xp).level;
    const due = dueCards().length;
    const badge = $('nav-due');
    badge.hidden = due === 0;
    badge.textContent = due > 99 ? '99+' : due;
}

// ==================== SUBJECTS ====================
function getSubjects() {
    return [...new Set(appData.flashcards.map((c) => c.subject).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function fillSubjectSelect(select, { allLabel = 'All Subjects', minCards = 0 } = {}) {
    const previous = select.value;
    select.innerHTML = '';
    select.add(new Option(allLabel, 'all'));
    for (const s of getSubjects()) {
        const n = appData.flashcards.filter((c) => c.subject === s).length;
        if (n >= minCards) select.add(new Option(`${s} (${n})`, s));
    }
    if ([...select.options].some((o) => o.value === previous)) select.value = previous;
}

// ==================== HOME ====================
renderers.home = async () => {
    $('total-cards-stat').textContent = appData.flashcards.length;
    $('total-quizzes-stat').textContent = appData.quizHistory.length;
    $('total-time-stat').textContent = formatMinutes(appData.totalStudyMinutes);
    renderDashboard();
    renderExamBanner();
    try {
        await ensureLibrary();
        const featured = FEATURED_DECKS.map((id) => library.find((d) => d.id === id)).filter(Boolean);
        $('home-decks').innerHTML = featured.map(deckCardHtml).join('');
    } catch {
        $('home-decks').innerHTML = '<p class="empty-text">Could not load the deck library.</p>';
    }
};

/** One line about the freezes in the bank. */
function freezeText() {
    const left = freezesLeft();
    const next = Core.FREEZE_EVERY - (currentStreak() % Core.FREEZE_EVERY);
    if (left === 0) return `❄️ No streak freezes banked – one every ${Core.FREEZE_EVERY}-day streak (max ${Core.FREEZE_BANK}).`;
    return `❄️ ${left} streak freeze${left === 1 ? '' : 's'} banked${left < Core.FREEZE_BANK ? ` · next in ${next} days` : ' (bank full)'}`;
}

/** The soonest exam date set on the Plan page, or null. */
function nextExam(today = Core.dateKey()) {
    let best = null;
    for (const [subject, key] of Object.entries(appData.exams || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(key))) continue;
        const days = Core.dayDiff(today, key);
        if (days < 0) continue;
        if (!best || days < best.days) best = { subject, date: key, days };
    }
    return best;
}

function renderExamBanner() {
    const box = $('exam-banner');
    if (!box) return;
    const exam = nextExam();
    if (!exam) { box.innerHTML = ''; return; }
    const cards = appData.flashcards.filter((c) => c.subject === exam.subject);
    const plan = Core.examPlan(cards, exam.date);
    const pct = Math.round(plan.readinessAtExam * 100);
    box.innerHTML = `<div class="exam-banner">
        <div class="exam-banner-icon">🗓️</div>
        <div class="exam-banner-text">
            <strong>${esc(exam.subject)}</strong> exam in ${exam.days === 0 ? '<strong>today</strong>' : `${exam.days} day${exam.days === 1 ? '' : 's'}`}
            <span class="dash-sub">${cards.length ? `Projected readiness on the day: <strong>${pct}%</strong>${plan.unseen ? ` · ${plan.unseen} cards unseen` : ''}` : 'No cards for this subject yet.'}</span>
        </div>
        <button class="btn btn-primary btn-sm" data-action="goto" data-arg="plan">Open plan →</button>
    </div>`;
}

function renderDashboard() {
    const today = Core.dateKey();
    const reviewed = appData.reviewLog[today] || 0;
    const goal = appData.dailyGoal;
    const pct = Math.min(reviewed / goal, 1);
    const due = dueCards().length;
    const lvl = Core.levelInfo(appData.xp);
    const C = 2 * Math.PI * 34;

    const week = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = Core.dateKey(d);
        const active = (appData.activityLog[key] || 0) > 0;
        week.push(`<span class="week-dot ${active ? 'on' : ''}" title="${key}">${'SMTWTFS'[d.getDay()]}</span>`);
    }

    $('dashboard').innerHTML = `
        <div class="dash-card">
            <svg class="goal-ring" viewBox="0 0 80 80" aria-hidden="true">
                <circle cx="40" cy="40" r="34" class="goal-ring-bg"></circle>
                <circle cx="40" cy="40" r="34" class="goal-ring-fill" style="stroke-dasharray:${C};stroke-dashoffset:${C * (1 - pct)}"></circle>
            </svg>
            <div><div class="dash-big">${reviewed}<small>/${goal}</small></div><div class="dash-label">Daily goal${pct >= 1 ? ' ✅' : ''}</div></div>
        </div>
        <div class="dash-card">
            <div class="dash-icon">🎯</div>
            <div><div class="dash-big">${due}</div><div class="dash-label">${due === 1 ? 'card' : 'cards'} due now</div></div>
            <button class="btn btn-primary btn-sm dash-btn" data-action="study-due-home">${appData.flashcards.length ? 'Study' : 'Add cards'}</button>
        </div>
        <div class="dash-card dash-wide">
            <div class="dash-icon">⭐</div>
            <div class="dash-grow">
                <div class="dash-label">Level ${lvl.level} · ${lvl.xp} XP</div>
                <div class="xp-bar"><div class="xp-fill" style="width:${Math.round(lvl.progress * 100)}%"></div></div>
                <div class="dash-sub">${lvl.next - lvl.xp} XP to level ${lvl.level + 1}</div>
            </div>
        </div>
        <div class="dash-card dash-wide">
            <div class="dash-icon">🔥</div>
            <div class="dash-grow">
                <div class="dash-big">${currentStreak()}<small> day streak</small></div>
                <div class="week-dots">${week.join('')}</div>
                <div class="dash-sub" id="dash-freezes">${freezeText()}</div>
            </div>
        </div>`;
}

// ==================== STATS ====================
renderers.stats = () => {
    const cards = appData.flashcards;
    const statusCount = { new: 0, learning: 0, mastered: 0 };
    cards.forEach((c) => { statusCount[Core.cardStatus(c)]++; });

    $('stat-streak').textContent = currentStreak();
    $('stat-best-streak').textContent = Math.max(appData.bestStreak || 0, currentStreak());
    $('stat-cards').textContent = cards.length;
    $('stat-mastered').textContent = statusCount.mastered;
    $('stat-reviews').textContent = appData.totalReviews;
    $('stat-quizzes').textContent = appData.quizHistory.length;
    $('stat-notes').textContent = appData.notes.length;
    $('stat-time').textContent = formatMinutes(appData.totalStudyMinutes);
    const avg = appData.quizHistory.length
        ? Math.round(appData.quizHistory.reduce((s, q) => s + q.percentage, 0) / appData.quizHistory.length) : 0;
    $('stat-avg-score').textContent = avg + '%';
    $('daily-goal').value = appData.dailyGoal;

    const lvl = Core.levelInfo(appData.xp);
    $('level-card').innerHTML = `
        <div class="level-badge">${lvl.level}</div>
        <div class="dash-grow">
            <div class="level-title">Level ${lvl.level} <span>· ${lvl.xp} XP</span></div>
            <div class="xp-bar xp-bar-lg"><div class="xp-fill" style="width:${Math.round(lvl.progress * 100)}%"></div></div>
            <div class="dash-sub">${lvl.next - lvl.xp} XP to level ${lvl.level + 1} — earn XP by reviewing cards, acing quizzes and focusing.</div>
        </div>`;

    const total = cards.length || 1;
    $('mastery').innerHTML = cards.length ? `
        <div class="mastery-bar">
            <div class="mastery-seg m-new" style="width:${(statusCount.new / total) * 100}%"></div>
            <div class="mastery-seg m-learning" style="width:${(statusCount.learning / total) * 100}%"></div>
            <div class="mastery-seg m-mastered" style="width:${(statusCount.mastered / total) * 100}%"></div>
        </div>
        <div class="mastery-legend">
            <span><i class="m-new"></i>New ${statusCount.new}</span>
            <span><i class="m-learning"></i>Learning ${statusCount.learning}</span>
            <span><i class="m-mastered"></i>Mastered ${statusCount.mastered}</span>
        </div>` : '<p class="empty-text">Add some flashcards to see your mastery.</p>';

    renderHeatmap();
    renderAchievements();
    renderSubjectBars();
    renderQuizHistory();
};

function renderHeatmap() {
    const heatmap = $('heatmap');
    heatmap.innerHTML = '';
    const today = new Date();
    const days = 84;
    const first = new Date(today);
    first.setDate(first.getDate() - (days - 1));
    const offset = (first.getDay() + 6) % 7; // Monday-first rows
    for (let i = 0; i < offset; i++) {
        const spacer = document.createElement('div');
        spacer.className = 'heatmap-cell heatmap-spacer';
        heatmap.appendChild(spacer);
    }
    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const key = Core.dateKey(date);
        const activity = appData.activityLog[key] || 0;
        const level = activity >= 20 ? 4 : activity >= 10 ? 3 : activity >= 5 ? 2 : activity >= 1 ? 1 : 0;
        const cell = document.createElement('div');
        cell.className = `heatmap-cell heatmap-${level}`;
        cell.title = `${key}: ${plural(activity, 'activity', 'activities')}`;
        heatmap.appendChild(cell);
    }
}

function renderAchievements() {
    $('achievements').innerHTML = Core.ACHIEVEMENTS.map((a) => {
        const got = appData.achievements[a.id];
        return `<div class="achievement ${got ? 'unlocked' : ''}" title="${esc(a.desc)}">
            <div class="achievement-icon">${got ? a.icon : '🔒'}</div>
            <div><div class="achievement-name">${esc(a.name)}</div><div class="achievement-desc">${esc(a.desc)}</div></div>
        </div>`;
    }).join('');
}

function renderSubjectBars() {
    const container = $('subject-bars');
    const subjects = getSubjects();
    if (!subjects.length) {
        container.innerHTML = '<p class="empty-text">Create some flashcards to see your subject breakdown.</p>';
        return;
    }
    const counts = subjects.map((s) => appData.flashcards.filter((c) => c.subject === s));
    const max = Math.max(...counts.map((c) => c.length));
    container.innerHTML = subjects.map((s, i) => {
        const list = counts[i];
        const mastered = list.filter((c) => Core.cardStatus(c) === 'mastered').length;
        return `<div class="subject-bar-item">
            <div class="subject-bar-header"><span>${esc(s)}</span><span>${plural(list.length, 'card')} · ${mastered} mastered</span></div>
            <div class="subject-bar-track"><div class="subject-bar-fill" style="width:${(list.length / max) * 100}%;background:${SUBJECT_COLORS[i % SUBJECT_COLORS.length]}"></div></div>
        </div>`;
    }).join('');
}

function renderQuizHistory() {
    const container = $('quiz-history');
    if (!appData.quizHistory.length) {
        container.innerHTML = '<p class="empty-text">Take a quiz to see your history here.</p>';
        return;
    }
    container.innerHTML = [...appData.quizHistory].reverse().slice(0, 10).map((q) => `
        <div class="quiz-history-item">
            <span class="quiz-history-subject">${esc(q.subject)}</span>
            <span class="quiz-history-score">${q.score}/${q.total} (${q.percentage}%)</span>
            <span class="quiz-history-date">${formatDate(q.date)}</span>
        </div>`).join('');
}

inputs['daily-goal'] = (el) => {
    const v = parseInt(el.value, 10);
    if (v >= 1 && v <= 500) {
        appData.dailyGoal = v;
        saveData();
    }
};

actions['backup-export'] = () => {
    downloadFile(`reviseforfun-backup-${Core.dateKey()}.json`, JSON.stringify(appData, null, 2), 'application/json');
    showToast('Backup downloaded.', 'success');
};

actions['backup-import'] = () => $('backup-file').click();

actions['reset-all'] = async () => {
    if (!confirm('⚠️ Are you sure you want to delete ALL your data on this device? This cannot be undone!')) return;
    if (!confirm('This will delete all flashcards, notes, quiz history and stats. Are you really sure?')) return;
    if (API.isLoggedIn()) {
        await API.logout();
        showToast('You were signed out. Your cloud copy is kept until you delete your account.', 'info');
    }
    localStorage.removeItem(STORAGE_KEY);
    history.replaceState(null, '', '#home');
    location.reload();
};

// ==================== MODALS ====================
function openModal(id) {
    $(id).classList.add('active');
    const focusable = $(id).querySelector('input:not([type=file]), textarea, select, button.btn-primary');
    if (focusable) setTimeout(() => focusable.focus(), 50);
}

function closeModals() {
    document.querySelectorAll('.modal-overlay.active').forEach((m) => m.classList.remove('active'));
}

actions['close-modal'] = closeModals;

// ==================== EVENT DELEGATION ====================
document.addEventListener('click', (e) => {
    const overlay = e.target.closest('[data-modal]');
    if (overlay && e.target === overlay) return closeModals();
    const el = e.target.closest('[data-action]');
    if (!el || el.disabled) return;
    const fn = actions[el.dataset.action];
    if (fn) {
        if (el.tagName === 'A') e.preventDefault();
        fn(el.dataset.arg, el, e);
    }
});

function dispatchInput(e) {
    const el = e.target.closest('[data-input]');
    if (!el) return;
    const fn = inputs[el.dataset.input];
    if (fn) fn(el, e);
}
document.addEventListener('input', dispatchInput);
document.addEventListener('change', dispatchInput);

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (document.querySelector('.modal-overlay.active')) return closeModals();
    }
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
    if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('.modal-overlay.active')) return;
    for (const handler of keyHandlers) {
        if (handler(e)) {
            e.preventDefault();
            return;
        }
    }
});

window.addEventListener('hashchange', () => {
    const page = pageFromHash();
    if (page !== currentPage) return renderPage(page);
    // Same page, but the query part carries a deep link (#community?verify=…)
    if (page === 'community' && location.hash.includes('?') && typeof handleCommunityDeepLink === 'function') {
        handleCommunityDeepLink();
    }
});

// ==================== LIBRARY LOADING ====================
let libraryPromise = null;
function ensureLibrary() {
    if (library) return Promise.resolve(library);
    if (!libraryPromise) {
        libraryPromise = API.loadLibrary()
            .then((decks) => { library = decks; return decks; })
            .catch((e) => { libraryPromise = null; throw e; });
    }
    return libraryPromise;
}
