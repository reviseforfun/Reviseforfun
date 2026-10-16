/* ==========================================
   REVISEFORFUN - DECK LIBRARY, FLASHCARDS & STUDY MODE
   ========================================== */

const CARD_PAGE_SIZE = 120;
let cardLimit = CARD_PAGE_SIZE;
let editingCardId = null;
let previewDeckId = null;

const XP_FOR_GRADE = { 1: 2, 2: 6, 3: 10, 4: 12 };
const NEW_PER_SESSION = 20; // brand-new cards allowed in one "Study due" session

function subjectColor(subject) {
    let h = 0;
    for (const ch of String(subject)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return SUBJECT_COLORS[h % SUBJECT_COLORS.length];
}

function findCard(id) {
    return appData.flashcards.find((c) => c.id === id);
}

// ==================== LIBRARY ====================
function ownedCount(deck, ids) {
    let n = 0;
    for (const c of deck.cards) if (ids.has(c.id)) n++;
    return n;
}

function deckCardHtml(deck) {
    const ids = new Set(appData.flashcards.map((c) => c.id));
    const owned = ownedCount(deck, ids);
    const total = deck.cards.length;
    const full = owned === total;
    return `
    <div class="deck-card" style="--deck-accent:${subjectColor(deck.subject)}">
        <div class="deck-top"><span class="deck-emoji">${esc(deck.emoji)}</span><span class="deck-subject">${esc(deck.subject)}</span></div>
        <h3>${esc(deck.title)}</h3>
        <p>${esc(deck.description)}</p>
        <div class="deck-meta"><span>🎴 ${total} cards</span>${deck.level ? `<span>🎓 ${esc(deck.level)}</span>` : ''}</div>
        ${owned ? `<div class="deck-owned"><div class="deck-owned-fill" style="width:${(owned / total) * 100}%"></div></div>` : ''}
        <div class="deck-actions">
            <button class="btn btn-secondary btn-sm" data-action="preview-deck" data-arg="${esc(deck.id)}">👁 Preview</button>
            ${full
                ? `<button class="btn btn-success btn-sm" data-action="study-deck" data-arg="${esc(deck.id)}">✓ Added · Study</button>`
                : `<button class="btn btn-primary btn-sm" data-action="add-deck" data-arg="${esc(deck.id)}">${owned ? `+ Add ${total - owned} missing` : '+ Add to my cards'}</button>`}
        </div>
    </div>`;
}

renderers.library = async () => {
    const grid = $('library-grid');
    grid.innerHTML = '<p class="empty-text">Loading decks…</p>';
    try {
        await ensureLibrary();
    } catch {
        grid.innerHTML = `<div class="empty-state"><div class="empty-icon">📡</div><h3>Couldn't load the library</h3>
            <p>Check your connection and try again.</p><button class="btn btn-primary" data-action="retry-library">Retry</button></div>`;
        return;
    }
    const select = $('library-subject');
    if (select.options.length === 0) {
        select.add(new Option('All Subjects', 'all'));
        [...new Set(library.map((d) => d.subject))].sort().forEach((s) => select.add(new Option(s, s)));
    }
    renderLibraryGrid();
};

actions['retry-library'] = () => renderers.library();

function renderLibraryGrid() {
    if (!library) return;
    const q = $('library-search').value.toLowerCase().trim();
    const subject = $('library-subject').value || 'all';
    const list = library.filter((d) => {
        if (subject !== 'all' && d.subject !== subject) return false;
        if (!q) return true;
        return `${d.title} ${d.subject} ${d.description} ${d.level}`.toLowerCase().includes(q)
            || d.cards.some((c) => c.front.toLowerCase().includes(q) || c.back.toLowerCase().includes(q));
    });
    const totalCards = list.reduce((n, d) => n + d.cards.length, 0);
    $('library-count').textContent = `${plural(list.length, 'deck')} · ${totalCards} cards`;
    $('library-grid').innerHTML = list.length
        ? list.map(deckCardHtml).join('')
        : '<div class="empty-state"><div class="empty-icon">🔍</div><h3>No decks found</h3><p>Try a different search.</p></div>';
}

inputs['render-library'] = () => renderLibraryGrid();

function installDeck(deck) {
    const have = new Set(appData.flashcards.map((c) => c.id));
    const now = Date.now();
    let added = 0;
    for (const c of deck.cards) {
        if (have.has(c.id)) continue;
        appData.flashcards.push({
            ...Core.newSrs(), id: c.id, deckId: deck.id, subject: deck.subject,
            front: c.front, back: c.back, starred: false, createdAt: now, updatedAt: now,
        });
        delete appData.deleted[c.id];
        added++;
    }
    if (!appData.installedDecks.includes(deck.id)) appData.installedDecks.push(deck.id);
    commit();
    return added;
}

function refreshDeckViews() {
    if (currentPage === 'library') renderLibraryGrid();
    if (currentPage === 'home') renderers.home();
    if (currentPage === 'flashcards') renderFlashcards();
}

actions['add-deck'] = async (id) => {
    await ensureLibrary();
    const deck = library.find((d) => d.id === id);
    if (!deck) return;
    const added = installDeck(deck);
    showToast(added ? `Added ${plural(added, 'card')} from “${deck.title}” 🎉` : 'You already have every card in this deck.', added ? 'success' : 'info');
    refreshDeckViews();
    if ($('deck-modal').classList.contains('active')) openDeckPreview(id);
};

actions['study-deck'] = async (id) => {
    await ensureLibrary();
    const deck = library.find((d) => d.id === id);
    if (!deck) return;
    closeModals();
    showPage('flashcards');
    startStudy(deck.cards.map((c) => c.id).filter((cid) => findCard(cid)), { label: deck.title, mode: 'all' });
};

async function openDeckPreview(id) {
    await ensureLibrary();
    const deck = library.find((d) => d.id === id);
    if (!deck) return;
    previewDeckId = id;
    const owned = ownedCount(deck, new Set(appData.flashcards.map((c) => c.id)));
    $('deck-modal-title').textContent = `${deck.emoji} ${deck.title}`;
    $('deck-modal-body').innerHTML = `
        <p class="modal-hint">${esc(deck.description)} <strong>${esc(deck.subject)}</strong>${deck.level ? ` · ${esc(deck.level)}` : ''} · ${deck.cards.length} cards</p>
        <div class="preview-list">${deck.cards.map((c) => `
            <div class="preview-row"><div class="preview-q">${esc(c.front)}</div><div class="preview-a">${esc(c.back)}</div></div>`).join('')}
        </div>`;
    $('deck-modal-footer').innerHTML = `
        <button class="btn btn-secondary" data-action="close-modal">Close</button>
        ${owned === deck.cards.length
            ? `<button class="btn btn-success" data-action="study-deck" data-arg="${esc(id)}">Study this deck</button>`
            : `<button class="btn btn-primary" data-action="add-deck" data-arg="${esc(id)}">+ Add ${owned ? `${deck.cards.length - owned} missing` : `all ${deck.cards.length}`} cards</button>`}`;
    openModal('deck-modal');
}
actions['preview-deck'] = (id) => openDeckPreview(id);

// ==================== FLASHCARD LIST ====================
function filteredCards() {
    const subject = $('flashcard-subject-filter').value || 'all';
    const status = $('card-status-filter').value || 'all';
    const q = $('card-search').value.toLowerCase().trim();
    const now = Date.now();
    return appData.flashcards.filter((c) => {
        if (subject !== 'all' && c.subject !== subject) return false;
        if (status === 'due' && !Core.isDue(c, now)) return false;
        if (status === 'starred' && !c.starred) return false;
        if (['new', 'learning', 'mastered'].includes(status) && Core.cardStatus(c) !== status) return false;
        if (q && !(`${c.front} ${c.back} ${c.subject}`.toLowerCase().includes(q))) return false;
        return true;
    });
}

function updateSubjectFilters() {
    fillSubjectSelect($('flashcard-subject-filter'));
    $('subject-suggestions').innerHTML = getSubjects().map((s) => `<option value="${esc(s)}">`).join('');
}

function dueText(card) {
    if (!card.lastReview) return 'New';
    if (Core.isDue(card)) return 'Due now';
    const days = Math.ceil((card.due - Date.now()) / Core.DAY);
    return days <= 1 ? 'Due tomorrow' : `Due in ${days}d`;
}

function createCardElement(card) {
    const div = document.createElement('div');
    div.className = 'card-item';
    const status = Core.cardStatus(card);
    div.innerHTML = `
        <div class="card-item-head">
            <div class="card-item-subject" style="background:${subjectColor(card.subject)}22;color:${subjectColor(card.subject)}">${esc(card.subject || 'General')}</div>
            <span class="status-chip status-${status}">${esc(dueText(card))}</span>
        </div>
        <div class="card-item-question">${esc(card.front)}</div>
        <div class="card-item-answer">${esc(card.back)}</div>
        <div class="card-item-actions">
            <button class="btn btn-ghost btn-sm star-btn ${card.starred ? 'on' : ''}" data-action="toggle-star" data-arg="${esc(card.id)}" aria-label="Star" title="Star">${card.starred ? '★' : '☆'}</button>
            <button class="btn btn-secondary btn-sm" data-action="edit-card" data-arg="${esc(card.id)}">✏️ Edit</button>
            <button class="btn btn-danger btn-sm" data-action="delete-card" data-arg="${esc(card.id)}">🗑️</button>
        </div>`;
    return div;
}

renderers.flashcards = () => {
    // Always land on the list view when (re)entering the page
    showStudyView('grid');
    renderFlashcards();
};

function renderFlashcards() {
    updateSubjectFilters();
    const grid = $('flashcard-grid');
    const cards = filteredCards();
    const total = appData.flashcards.length;
    const due = dueCards().length;
    const subject = $('flashcard-subject-filter').value;
    const dueInFilter = dueCards(subject || 'all').length;

    // banner
    const banner = $('due-banner');
    if (!total) banner.innerHTML = '';
    else if (due) banner.innerHTML = `<div class="due-banner-inner due-yes">🎯 <strong>${plural(due, 'card')}</strong> ready to review today.</div>`;
    else {
        const next = appData.flashcards.map((c) => c.due).filter((d) => d > Date.now()).sort((a, b) => a - b)[0];
        banner.innerHTML = `<div class="due-banner-inner due-none">🎉 You're all caught up!${next ? ` Next review ${formatDate(next).replace(' ago', '')}…` : ''} Study all cards to get ahead.</div>`;
    }

    grid.innerHTML = '';
    if (!cards.length) {
        const empty = document.createElement('div');
        empty.className = 'empty-state';
        empty.innerHTML = total
            ? '<div class="empty-icon">🔍</div><h3>No matching cards</h3><p>Try changing your filters.</p>'
            : `<div class="empty-icon">🎴</div><h3>No flashcards yet!</h3><p>Grab a ready-made deck or create your own.</p>
               <div class="empty-actions"><button class="btn btn-primary" data-action="goto" data-arg="library">📦 Browse decks</button>
               <button class="btn btn-secondary" data-action="new-card">+ Create flashcard</button></div>`;
        grid.appendChild(empty);
    } else {
        const frag = document.createDocumentFragment();
        cards.slice(0, cardLimit).forEach((c) => frag.appendChild(createCardElement(c)));
        grid.appendChild(frag);
        if (cards.length > cardLimit) {
            const more = document.createElement('div');
            more.className = 'show-more';
            more.innerHTML = `<button class="btn btn-secondary" data-action="show-more">Show more (${cards.length - cardLimit} remaining)</button>`;
            grid.appendChild(more);
        }
    }
    $('cards-count').textContent = plural(cards.length, 'card');
    $('study-mode-btn').textContent = `🔀 Study ${cards.length} shown`;
    $('study-mode-btn').disabled = cards.length === 0;
    $('study-due-btn').textContent = `🎯 Study due (${dueInFilter})`;
    $('study-due-btn').disabled = dueInFilter === 0;
    updateChrome();
}

inputs['render-cards'] = () => { cardLimit = CARD_PAGE_SIZE; renderFlashcards(); };
actions['show-more'] = () => { cardLimit += CARD_PAGE_SIZE; renderFlashcards(); };

actions['toggle-star'] = (id) => {
    const c = findCard(id);
    if (!c) return;
    c.starred = !c.starred;
    c.updatedAt = Date.now();
    saveData();
    renderFlashcards();
};

// ==================== CREATE / EDIT / DELETE ====================
function openCardModal(card) {
    editingCardId = card ? card.id : null;
    $('card-modal-title').textContent = card ? 'Edit Flashcard' : 'Create Flashcard';
    $('save-card-btn').textContent = card ? 'Save Changes' : 'Create Card';
    const filter = $('flashcard-subject-filter').value;
    $('card-subject').value = card ? card.subject : (filter && filter !== 'all' ? filter : '');
    $('card-front').value = card ? card.front : '';
    $('card-back').value = card ? card.back : '';
    updateSubjectFilters();
    openModal('card-modal');
}

actions['new-card'] = () => openCardModal(null);
actions['edit-card'] = (id) => { const c = findCard(id); if (c) openCardModal(c); };

actions['save-card'] = () => {
    const subject = $('card-subject').value.trim() || 'General';
    const front = $('card-front').value.trim();
    const back = $('card-back').value.trim();
    if (!front || !back) return showToast('Please fill in both the question and answer.', 'error');
    const now = Date.now();
    if (editingCardId) {
        const c = findCard(editingCardId);
        if (c) Object.assign(c, { subject, front, back, updatedAt: now });
        showToast('Flashcard updated! ✏️', 'success');
    } else {
        appData.flashcards.push({ ...Core.newSrs(), id: generateId(), subject, front, back, starred: false, createdAt: now, updatedAt: now });
        showToast('Flashcard created! 🎴', 'success');
    }
    commit();
    closeModals();
    refreshDeckViews();
    if (currentPage === 'flashcards') renderFlashcards();
};

document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && $('card-modal').classList.contains('active')) actions['save-card']();
});

function removeCard(id) {
    appData.flashcards = appData.flashcards.filter((c) => c.id !== id);
    appData.deleted[id] = Date.now();
}

actions['delete-card'] = (id) => {
    if (!confirm('Are you sure you want to delete this flashcard?')) return;
    removeCard(id);
    commit();
    renderFlashcards();
    showToast('Flashcard deleted.', 'info');
};

// ==================== BULK ADD / IMPORT / EXPORT ====================
function addCards(list, defaultSubject) {
    const key = (c) => `${c.subject}\u0000${c.front}\u0000${c.back}`;
    const have = new Set(appData.flashcards.map(key));
    const now = Date.now();
    let added = 0;
    for (const raw of list) {
        const card = { subject: raw.subject || defaultSubject || 'General', front: raw.front.slice(0, 2000), back: raw.back.slice(0, 2000) };
        if (have.has(key(card))) continue;
        have.add(key(card));
        appData.flashcards.push({ ...Core.newSrs(), ...card, id: generateId(), starred: false, createdAt: now, updatedAt: now });
        added++;
    }
    return added;
}

actions['open-bulk-modal'] = () => {
    $('bulk-text').value = '';
    $('bulk-subject').value = '';
    updateSubjectFilters();
    openModal('bulk-modal');
};

actions['save-bulk'] = () => {
    const cards = $('bulk-text').value.split(/\r?\n/).map((line) => {
        const sep = line.includes(' :: ') ? ' :: ' : line.includes('::') ? '::' : '\t';
        const i = line.indexOf(sep);
        return i === -1 ? null : { front: line.slice(0, i).trim(), back: line.slice(i + sep.length).trim() };
    }).filter((c) => c && c.front && c.back);
    if (!cards.length) return showToast('No cards found. Use the format: question :: answer', 'error');
    const added = addCards(cards.slice(0, 2000), $('bulk-subject').value.trim() || 'General');
    commit();
    closeModals();
    renderFlashcards();
    showToast(`Added ${plural(added, 'card')}${added < cards.length ? ` (${cards.length - added} duplicates skipped)` : ''}.`, 'success');
};

actions['open-import-modal'] = () => {
    $('import-text').value = '';
    $('import-file').value = '';
    updateSubjectFilters();
    openModal('import-modal');
};

document.addEventListener('change', (e) => {
    if (e.target.id !== 'import-file') return;
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) return showToast('That file is too large (max 2 MB).', 'error');
    const reader = new FileReader();
    reader.onload = () => { $('import-text').value = String(reader.result); };
    reader.readAsText(file);
});

actions['save-import'] = () => {
    const cards = Core.cardsFromCsv($('import-text').value, $('import-subject').value.trim() || 'General');
    if (!cards.length) return showToast('No cards found. Expected columns: front, back, subject.', 'error');
    const added = addCards(cards.slice(0, 5000));
    commit();
    closeModals();
    renderFlashcards();
    showToast(`Imported ${plural(added, 'card')}${added < cards.length ? ` (${cards.length - added} duplicates skipped)` : ''}.`, 'success');
};

actions['export-cards'] = () => {
    const subject = $('flashcard-subject-filter').value;
    const list = appData.flashcards.filter((c) => !subject || subject === 'all' || c.subject === subject);
    if (!list.length) return showToast('No cards to export yet.', 'error');
    const csv = Core.toCsv([['front', 'back', 'subject'], ...list.map((c) => [c.front, c.back, c.subject])]);
    downloadFile(`flashcards-${subject && subject !== 'all' ? subject.toLowerCase().replace(/\W+/g, '-') : 'all'}.csv`, csv, 'text/csv');
    showToast(`Exported ${plural(list.length, 'card')}.`, 'success');
};

// ==================== STUDY MODE ====================
let study = null;
let studyReverse = false;

function showStudyView(view) {
    $('flashcard-grid-area').hidden = view !== 'grid';
    $('flashcard-study-area').hidden = view !== 'study';
    $('flashcard-summary').hidden = view !== 'summary';
}

/**
 * Starts a study session over the given card ids.
 * mode 'due' keeps the queue as given; 'all' shuffles.
 */
function startStudy(ids, { label = 'Study session', mode = 'all' } = {}) {
    const queue = [...new Set(ids)].filter(findCard);
    if (!queue.length) { showToast('No cards to study!', 'error'); return false; }
    if (mode === 'all') Core.shuffle(queue);
    study = {
        queue: queue.slice(0, 100), total: Math.min(queue.length, 100), done: 0,
        reviewed: 0, good: 0, xp: 0, flipped: false,
        hint: 0, hinted: 0,
        label, startedAt: Date.now(), grades: { 1: 0, 2: 0, 3: 0, 4: 0 },
    };
    $('study-label').textContent = label;
    showStudyView('study');
    showStudyCard();
}

function currentStudyCard() {
    return study && study.queue.length ? findCard(study.queue[0]) : null;
}

function showStudyCard() {
    while (study.queue.length && !findCard(study.queue[0])) study.queue.shift();
    const card = currentStudyCard();
    if (!card) return finishStudy();
    study.flipped = false;
    const flashcard = $('study-flashcard');
    // flip back instantly (no animation) before swapping the text, so the answer never flashes
    flashcard.style.transition = 'none';
    flashcard.classList.remove('flipped');
    void flashcard.offsetWidth;
    flashcard.style.transition = '';
    const front = studyReverse ? card.back : card.front;
    const back = studyReverse ? card.front : card.back;
    $('study-card-subject').textContent = card.subject || 'General';
    $('study-card-front').textContent = front;
    $('study-card-back').textContent = back;
    $('study-star').textContent = card.starred ? '★' : '☆';
    $('study-reverse').classList.toggle('on', studyReverse);
    $('study-progress-fill').style.width = `${(study.done / study.total) * 100}%`;
    $('study-progress-text').textContent = `${study.done} / ${study.total}`;
    $('study-flip-row').hidden = false;
    $('study-rate-row').hidden = true;
    study.hint = 0;
    paintStudyHint(card);
    for (let g = 1; g <= 4; g++) $(`rate-int-${g}`).textContent = formatInterval(Core.schedule(card, g).interval);
}

/** The side the answer is on (study mode can be reversed). */
function studyAnswer(card) {
    return studyReverse ? card.front : card.back;
}

/** Shows the current hint and locks "Easy" as soon as one has been used. */
function paintStudyHint(card) {
    const box = $('study-hint');
    const level = study ? study.hint : 0;
    if (box) {
        box.hidden = level === 0;
        box.textContent = level ? `💡 ${Core.hint(studyAnswer(card || {}), level)}` : '';
        box.dataset.level = String(level);
    }
    const easy = $('rate-easy');
    if (easy) easy.disabled = level > 0;
    const hintBtn = $('study-hint-btn');
    if (hintBtn) {
        hintBtn.disabled = level >= 2;
        hintBtn.textContent = level === 0 ? '💡 Hint' : level === 1 ? '💡 More hint' : '💡 Hint used';
    }
}

/** Progressive hints: first letters, then the first half of each word. */
function useStudyHint() {
    const card = currentStudyCard();
    if (!study || !card || study.hint >= 2) return;
    study.hint += 1;
    if (study.hint === 1) study.hinted += 1;
    paintStudyHint(card);
    if (study.flipped) showToast('Hint used – "Easy" is off for this card.', 'info');
}

actions['study-hint'] = useStudyHint;

function flipStudyCard(forwardOnly = false) {
    if (!study || !currentStudyCard()) return;
    if (forwardOnly && study.flipped) return;
    study.flipped = !study.flipped;
    $('study-flashcard').classList.toggle('flipped', study.flipped);
    if (study.flipped) {
        $('study-flip-row').hidden = true;
        $('study-rate-row').hidden = false;
    }
}

function rateStudyCard(grade) {
    const card = currentStudyCard();
    if (!study || !card || !study.flipped) return;
    // A hinted card was not recalled unaided, so "Easy" is not on offer.
    if (grade === Core.GRADES.EASY && study.hint > 0) grade = Core.GRADES.GOOD;
    Object.assign(card, Core.schedule(card, grade), { updatedAt: Date.now() });
    const today = Core.dateKey();
    appData.reviewLog[today] = (appData.reviewLog[today] || 0) + 1;
    appData.totalReviews++;
    recordActivity(1);
    const gained = XP_FOR_GRADE[grade];
    award(gained);
    study.xp += gained;
    study.reviewed++;
    study.grades[grade]++;
    if (grade > 1) study.good++;
    study.queue.shift();
    if (grade === 1) study.queue.push(card.id); // see it again before the session ends
    else study.done++;
    commit();
    showStudyCard();
}

function finishStudy() {
    const s = study;
    study = null;
    showStudyView('summary');
    const accuracy = s.reviewed ? Math.round((s.good / s.reviewed) * 100) : 0;
    const secs = Math.round((Date.now() - s.startedAt) / 1000);
    const today = appData.reviewLog[Core.dateKey()] || 0;
    $('summary-emoji').textContent = accuracy >= 80 ? '🎉' : accuracy >= 50 ? '👍' : '💪';
    $('summary-title').textContent = accuracy >= 80 ? 'Brilliant session!' : accuracy >= 50 ? 'Nice work!' : 'Keep going – it gets easier!';
    $('summary-stats').innerHTML = `
        <div><strong>${s.reviewed}</strong><span>reviews</span></div>
        <div><strong>${accuracy}%</strong><span>recalled</span></div>
        <div><strong>${s.hinted}</strong><span>hinted</span></div>
        <div><strong>+${s.xp}</strong><span>XP</span></div>
        <div><strong>${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}</strong><span>time</span></div>
        <div class="summary-wide"><span>Today: ${today}/${appData.dailyGoal} of your daily goal ${today >= appData.dailyGoal ? '✅' : ''}</span></div>`;
    appData.totalStudyMinutes += Math.round(secs / 60);
    saveData();
    if (accuracy >= 80 && s.reviewed >= 5) confetti();
}

actions['study-due'] = () => {
    const subject = $('flashcard-subject-filter').value || 'all';
    const due = dueCards(subject);
    const reviewed = due.filter((c) => c.lastReview).sort((a, b) => a.due - b.due);
    const fresh = Core.shuffle(due.filter((c) => !c.lastReview));
    // Learning 200 new cards in one sitting buries the reviews that matter.
    const allowed = fresh.slice(0, NEW_PER_SESSION);
    const heldBack = fresh.length - allowed.length;
    const started = startStudy([...reviewed, ...allowed].map((c) => c.id),
        { label: `Due cards${subject !== 'all' ? ` · ${subject}` : ''}`, mode: 'due' });
    if (started === false) return;
    if (heldBack > 0) {
        showToast(`${heldBack} new card${heldBack === 1 ? '' : 's'} held back for your next session (max ${NEW_PER_SESSION} new at a time).`, 'info');
    }
};

actions['study-all'] = () => {
    startStudy(filteredCards().map((c) => c.id), { label: 'All shown cards', mode: 'all' });
};

actions['study-due-home'] = () => {
    if (!appData.flashcards.length) return showPage('library');
    showPage('flashcards');
    const due = dueCards();
    if (!due.length) return showToast('Nothing due right now – pick “Study all” to get ahead.', 'info');
    actions['study-due']();
};

actions['exit-study'] = () => {
    study = null;
    showStudyView('grid');
    renderFlashcards();
};
actions.flip = () => flipStudyCard();
actions.rate = (g) => rateStudyCard(Number(g));
actions['study-reverse'] = () => {
    if (!study) return;
    studyReverse = !studyReverse;
    showStudyCard();
};
actions['study-star'] = () => {
    const c = currentStudyCard();
    if (!c) return;
    c.starred = !c.starred;
    c.updatedAt = Date.now();
    saveData();
    $('study-star').textContent = c.starred ? '★' : '☆';
};

leaveHooks.push((from, to) => {
    if (from === 'flashcards' && to !== 'flashcards') study = null;
});

keyHandlers.push((e) => {
    if (currentPage !== 'flashcards' || $('flashcard-study-area').hidden || !study) return false;
    if (e.key === ' ' || e.key === 'Enter') {
        if (!study.flipped) flipStudyCard(true);
        else if (e.key === 'Enter') rateStudyCard(3);
        return true;
    }
    if (['1', '2', '3', '4'].includes(e.key)) {
        if (study.flipped) rateStudyCard(Number(e.key));
        else flipStudyCard(true);
        return true;
    }
    if (e.key === 's' || e.key === 'S') { actions['study-star'](); return true; }
    if (e.key === 'h' || e.key === 'H') { useStudyHint(); return true; }
    if (e.key === 'Escape') { actions['exit-study'](); return true; }
    return false;
});
