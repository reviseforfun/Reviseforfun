/* =========================================
   REVISEFORFUN - REVISION PLAN
   Readiness today, readiness on exam day, the next fortnight of reviews and
   the cards that keep slipping away. Everything is computed from Core – this
   file only paints it and wires up the buttons.
   ========================================== */

const FORECAST_DAYS = 14;
const BOOST_SIZE = 30;
const RESCUE_SIZE = 20;

const EXAM_STATUS = [
    { min: 0.85, cls: 'status-mastered', label: 'On track' },
    { min: 0.6, cls: 'status-learning', label: 'Getting there' },
    { min: 0.35, cls: 'status-learning', label: 'Needs work' },
    { min: -1, cls: 'status-new', label: 'At risk' },
];

function subjectSlug(subject) {
    return String(subject).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function cardsFor(subject) {
    return appData.flashcards.filter((c) => c.subject === subject);
}

function examStatus(plan) {
    if (plan.daysLeft === null) return { cls: '', label: 'No exam date' };
    if (plan.daysLeft <= 0) return { cls: 'status-mastered', label: plan.daysLeft === 0 ? 'Exam today' : 'Exam passed' };
    const found = EXAM_STATUS.find((s) => plan.readinessAtExam >= s.min);
    return { cls: found.cls, label: found.label };
}

const pct = (n) => `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;

// ==================== OVERALL ====================
function renderPlanOverall() {
    const box = $('plan-overall');
    const cards = appData.flashcards;
    const ready = Core.readiness(cards);
    const due = cards.filter((c) => Core.isDue(c)).length;
    const reviewed = cards.filter((c) => c.lastReview).length;
    const C = 2 * Math.PI * 52;
    box.innerHTML = `
        <div class="plan-ring-row">
            <svg class="plan-ring" viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r="52" class="plan-ring-bg"></circle>
                <circle cx="60" cy="60" r="52" class="plan-ring-fill" style="stroke-dasharray:${C};stroke-dashoffset:${C * (1 - ready)}"></circle>
            </svg>
            <div class="plan-ring-text">
                <div class="plan-ring-value">${pct(ready)}</div>
                <div class="plan-ring-label">overall readiness</div>
            </div>
        </div>
        <p class="modal-hint">Readiness is how likely you are to recall each card right now (the forgetting curve, averaged over your ${cards.length} cards${reviewed < cards.length ? `, with ${cards.length - reviewed} unseen` : ''}).</p>
        <div class="plan-facts">
            <div><strong>${due}</strong><span>due now</span></div>
            <div><strong>${reviewed}</strong><span>reviewed</span></div>
            <div><strong>${cards.length - reviewed}</strong><span>unseen</span></div>
            <div><strong>${Object.keys(appData.exams || {}).length}</strong><span>exams set</span></div>
        </div>
        <button class="btn btn-primary btn-block" data-action="boost-readiness" ${reviewed ? '' : 'disabled'}>⚡ Boost readiness</button>
        <p class="dash-sub plan-boost-note">Studies the ${BOOST_SIZE} cards you are closest to forgetting.</p>`;
}

function startBoostSession(list, label) {
    if (!list.length) return showToast('Nothing to study there yet.', 'info');
    showPage('flashcards');
    startStudy(list.map((c) => c.id), { label, mode: 'due' });
}

actions['boost-readiness'] = () => {
    const list = Core.lowestRetrievability(appData.flashcards, BOOST_SIZE);
    if (!list.length) return showToast('Review some cards first – there is nothing to boost yet.', 'info');
    startBoostSession(list, `Boost readiness · ${list.length} cards`);
};

actions['boost-subject'] = (subject) => {
    const pool = cardsFor(subject);
    const list = Core.lowestRetrievability(pool, BOOST_SIZE);
    const fallback = Core.shuffle(pool.filter((c) => !c.lastReview)).slice(0, 20);
    startBoostSession(list.length ? list : fallback, `Boost ${subject}`);
};

// ==================== STREAK FREEZES ====================
function renderPlanFreeze() {
    const box = $('plan-freeze');
    const left = Core.freezesAvailable(appData);
    const streak = currentStreak();
    const intoWeek = streak % Core.FREEZE_EVERY;
    const nextIn = streak > 0 && intoWeek === 0 ? Core.FREEZE_EVERY : Core.FREEZE_EVERY - intoWeek;
    const alive = Core.streakAlive(appData);
    box.innerHTML = `
        <h3>❄️ Streak freezes</h3>
        <div class="freeze-row">
            <div class="freeze-bank">${'❄️'.repeat(left) || '<span class="freeze-empty">—</span>'}</div>
            <div class="freeze-count">${left}<small>/${Core.FREEZE_BANK} banked</small></div>
        </div>
        <div class="xp-bar xp-bar-lg"><div class="xp-fill" style="width:${(intoWeek / Core.FREEZE_EVERY) * 100}%"></div></div>
        <p class="dash-sub">${left === Core.FREEZE_BANK ? 'Your bank is full – use one before earning another.'
            : `${nextIn} more day${nextIn === 1 ? '' : 's'} of study banks another freeze.`}</p>
        <p class="modal-hint">Earn one every ${Core.FREEZE_EVERY}-day streak, bank up to ${Core.FREEZE_BANK}. A freeze is spent automatically to bridge a single missed day, so one quiet Saturday can’t kill a month of work.</p>
        <div class="plan-facts">
            <div><strong>${streak}</strong><span>day streak</span></div>
            <div><strong>${Math.max(appData.bestStreak || 0, streak)}</strong><span>best</span></div>
            <div><strong>${appData.freezesUsed || 0}</strong><span>used</span></div>
            <div><strong>${alive ? 'alive' : '—'}</strong><span>status</span></div>
        </div>`;
}

// ==================== SUBJECTS & EXAMS ====================
function renderPlanSubjects() {
    const box = $('plan-subjects');
    const subjects = getSubjects();
    if (!subjects.length) {
        box.innerHTML = '<p class="empty-text">Add some flashcards and your per-subject plan appears here.</p>';
        return;
    }
    const today = Core.dateKey();
    box.innerHTML = subjects.map((subject) => {
        const cards = cardsFor(subject);
        const examKey = (appData.exams || {})[subject] || '';
        const plan = Core.examPlan(cards, examKey || null, today);
        const status = examKey ? examStatus(plan) : { cls: '', label: 'No exam date' };
        const slug = subjectSlug(subject);
        const marker = examKey && plan.daysLeft !== null ? Math.round(Math.max(0, Math.min(1, plan.readinessAtExam)) * 100) : null;
        return `<div class="plan-subject" style="--deck-accent:${subjectColor(subject)}">
            <div class="plan-subject-head">
                <h4>${esc(subject)}</h4>
                <span class="status-chip ${status.cls}">${esc(status.label)}</span>
            </div>
            <div class="plan-readiness">
                <div class="plan-bar"><div class="plan-bar-fill" style="width:${Math.round(plan.readinessNow * 100)}%"></div>
                    ${marker === null ? '' : `<div class="plan-bar-marker" style="left:${marker}%" title="Projected on exam day: ${pct(plan.readinessAtExam)}"></div>`}
                </div>
                <span class="plan-readiness-value">${pct(plan.readinessNow)}</span>
            </div>
            <div class="plan-subject-facts">
                <span>🎴 ${plan.total} cards</span>
                <span>👀 ${plan.unseen} unseen</span>
                ${examKey ? `<span>🗓️ ${plan.daysLeft <= 0 ? (plan.daysLeft === 0 ? 'today' : `${-plan.daysLeft}d ago`) : `in ${plan.daysLeft}d`}</span>` : ''}
                ${examKey ? `<span>🎯 ${pct(plan.readinessAtExam)} on the day</span>` : ''}
                ${examKey ? `<span>📈 ${plan.newPerDay} new/day</span>` : ''}
            </div>
            ${examKey ? `<p class="dash-sub plan-projection">${plan.daysLeft > 0
                ? `${pct(plan.readinessNow)} ready today → <strong>${pct(plan.readinessAtExam)}</strong> on exam day if you stop now.`
                : 'Exam day is here – good luck! 🍀'}</p>` : ''}
            <div class="plan-subject-actions">
                <label class="plan-exam-label" for="exam-${slug}">Exam date
                    <input type="date" id="exam-${slug}" class="text-input plan-exam-input" data-input="set-exam" data-subject="${esc(subject)}" value="${esc(examKey)}" max="2100-12-31">
                </label>
                ${examKey ? `<button class="btn btn-ghost btn-sm" data-action="clear-exam" data-arg="${esc(subject)}">Clear</button>` : ''}
                <button class="btn btn-secondary btn-sm" data-action="boost-subject" data-arg="${esc(subject)}">⚡ Boost ${esc(subject)}</button>
            </div>
        </div>`;
    }).join('');
}

inputs['set-exam'] = (el) => {
    const subject = el.dataset.subject;
    const value = el.value;
    if (!subject) return;
    if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
    appData.exams = appData.exams || {};
    if (value) appData.exams[subject] = value;
    else delete appData.exams[subject];
    saveData();
    renderPlanSubjects();
    if (currentPage === 'home') renderExamBanner();
    const days = value ? Core.dayDiff(Core.dateKey(), value) : null;
    if (days !== null && days >= 0) showToast(`${subject} exam saved – ${days === 0 ? 'today' : `${days} days to go`}.`, 'success');
};

actions['clear-exam'] = (subject) => {
    if (!appData.exams || !appData.exams[subject]) return;
    delete appData.exams[subject];
    saveData();
    renderPlanSubjects();
    if (currentPage === 'home') renderExamBanner();
    showToast(`Cleared the ${subject} exam date.`, 'info');
};

// ==================== 14-DAY FORECAST ====================
const WEEK_LETTERS = 'SMTWTFS';

function renderPlanForecast() {
    const box = $('plan-forecast');
    const today = Core.dateKey();
    const counts = Core.dueForecast(appData.flashcards, FORECAST_DAYS, today);
    const max = Math.max(1, ...counts);
    const cells = counts.map((n, i) => {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const label = i === 0 ? 'Due' : `${WEEK_LETTERS[d.getDay()]}`;
        const height = Math.round((n / max) * 100);
        return `<div class="forecast-col ${i === 0 ? 'forecast-now' : ''}" title="${i === 0 ? 'Overdue + today' : Core.dateKey(d)}: ${n} cards">
            <div class="forecast-value">${n || ''}</div>
            <div class="forecast-track"><div class="forecast-bar" style="height:${n ? Math.max(6, height) : 0}%"></div></div>
            <div class="forecast-label">${label}</div>
            <div class="forecast-day">${i === 0 ? 'now' : d.getDate()}</div>
        </div>`;
    }).join('');
    const total = counts.reduce((a, b) => a + b, 0);
    const busiest = counts.indexOf(Math.max(...counts.slice(1)));
    const dayFromNow = (i) => { const d = new Date(); d.setDate(d.getDate() + i); return d; };
    box.innerHTML = `${cells}
        <p class="dash-sub forecast-note">${total} reviews scheduled over the next ${FORECAST_DAYS} days${busiest > 0 ? ` · busiest day is ${Core.dateKey(dayFromNow(busiest))} with ${counts[busiest]}` : ''}.</p>`;
}

// ==================== WEAK SPOTS ====================
function renderPlanWeak() {
    const box = $('plan-weak');
    const weak = Core.weakCards(appData.flashcards, RESCUE_SIZE);
    if (!weak.length) {
        box.innerHTML = '<p class="empty-text">No weak spots – nothing has been forgotten or rated down yet. 🎉</p>';
        return;
    }
    box.innerHTML = `
        <div class="weak-head">
            <p class="modal-hint">Cards you have forgotten (lapses) or that keep feeling hard (low ease). Worst first.</p>
            <button class="btn btn-primary btn-sm" data-action="rescue-weak">🚑 Rescue session (${weak.length})</button>
        </div>
        <div class="weak-list">${weak.map((c) => `
            <div class="weak-item">
                <div class="weak-item-main">
                    <div class="weak-q">${esc(c.front)}</div>
                    <div class="weak-a">${esc(c.back)}</div>
                </div>
                <div class="weak-meta">
                    <span class="status-chip">${esc(c.subject || 'General')}</span>
                    <span class="weak-score" title="lapses × 3 + ease penalty">${c.lapses || 0} ✖ · ease ${(Number(c.ease) || 2.5).toFixed(2)}</span>
                </div>
            </div>`).join('')}</div>`;
}

actions['rescue-weak'] = () => {
    const weak = Core.weakCards(appData.flashcards, RESCUE_SIZE);
    startBoostSession(weak, `Rescue weak spots · ${weak.length} cards`);
};

// ==================== PAGE ====================
renderers.plan = () => {
    if (!appData.flashcards.length) {
        $('plan-overall').innerHTML = `<div class="empty-state"><div class="empty-icon">🗺️</div>
            <h3>No cards yet</h3><p>Add a deck and your revision plan builds itself.</p>
            <div class="empty-actions"><button class="btn btn-primary" data-action="goto" data-arg="library">📦 Browse decks</button></div></div>`;
        $('plan-subjects').innerHTML = '';
        $('plan-forecast').innerHTML = '';
        $('plan-weak').innerHTML = '';
        renderPlanFreeze();
        return;
    }
    renderPlanOverall();
    renderPlanFreeze();
    renderPlanSubjects();
    renderPlanForecast();
    renderPlanWeak();
};
