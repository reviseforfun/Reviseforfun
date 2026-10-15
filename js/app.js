/* ==========================================
   REVISEFORFUN - MAIN APPLICATION
   Complete Study Tool with Flashcards, Quiz,
   Notes, Pomodoro Timer, and Statistics
   ========================================== */

// ==================== DATA STORE ====================
const STORAGE_KEY = 'reviseforfun_data';

let appData = {
    flashcards: [],
    notes: [],
    quizHistory: [],
    pomodoroSessions: 0,
    totalStudyMinutes: 0,
    streak: 0,
    lastActiveDate: null,
    activityLog: {},
    theme: 'light',
    pomodoroSettings: {
        work: 25,
        short: 5,
        long: 15,
        autoStart: true,
        sound: true
    }
};

// Current state
let currentPage = 'home';
let currentStudyIndex = 0;
let studyCards = [];
let currentNoteId = null;
let editingCardId = null;
let quizState = {};
let pomodoroState = {
    mode: 'work',
    running: false,
    timeLeft: 0,
    totalTime: 0,
    interval: null
};

// ==================== INITIALIZATION ====================
document.addEventListener('DOMContentLoaded', () => {
    loadData();
    initTheme();
    syncPomodoroSettingsInputs();
    updateStreak();
    updateHomeStats();
    updateAllStats();
    initHeatmap();

    // Loading screen
    setTimeout(() => {
        document.getElementById('loading-screen').classList.add('hidden');
    }, 1800);

    // Navbar scroll effect
    window.addEventListener('scroll', () => {
        document.getElementById('navbar').classList.toggle('scrolled', window.scrollY > 10);
    });

    // Initialize pomodoro
    resetPomodoro();

    // Log today's activity
    logActivity();
});

// ==================== DATA PERSISTENCE ====================
function loadData() {
    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return;
        const parsed = JSON.parse(saved);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;

        appData = { ...appData, ...parsed };
        // Migrate data created by the earlier, smaller version of the app.
        appData.flashcards = Array.isArray(appData.flashcards) ? appData.flashcards : [];
        appData.flashcards = appData.flashcards.filter(card => card && typeof card === 'object').map(card => ({
            ...card,
            id: card.id || generateId(),
            subject: typeof card.subject === 'string' ? card.subject : 'General',
            front: typeof card.front === 'string' ? card.front : '',
            back: typeof card.back === 'string' ? card.back : ''
        }));
        appData.notes = Array.isArray(appData.notes) ? appData.notes : [];
        appData.notes = appData.notes.filter(note => note && typeof note === 'object').map(note => ({
            ...note,
            id: note.id || generateId(),
            title: typeof note.title === 'string' ? note.title : '',
            content: typeof note.content === 'string' ? note.content : '',
            subject: typeof note.subject === 'string' ? note.subject : '',
            updatedAt: Number(note.updatedAt || note.createdAt) || Date.now()
        }));
        appData.quizHistory = Array.isArray(appData.quizHistory) ? appData.quizHistory : [];
        appData.activityLog = appData.activityLog && typeof appData.activityLog === 'object' ? appData.activityLog : {};
        appData.pomodoroSettings = { ...{
            work: 25, short: 5, long: 15, autoStart: true, sound: true
        }, ...(appData.pomodoroSettings || {}) };
    } catch (e) {
        console.error('Failed to load saved data:', e);
        appData = { ...appData };
    }
}

function saveData() {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appData));
    } catch (e) {
        console.error('Failed to save data:', e);
        if (typeof showToast === 'function') showToast('Could not save data. Check your browser storage settings.', 'error');
    }
}

function syncPomodoroSettingsInputs() {
    document.getElementById('pomo-work-duration').value = appData.pomodoroSettings.work;
    document.getElementById('pomo-short-duration').value = appData.pomodoroSettings.short;
    document.getElementById('pomo-long-duration').value = appData.pomodoroSettings.long;
    document.getElementById('pomo-auto-start').checked = appData.pomodoroSettings.autoStart;
    document.getElementById('pomo-sound').checked = appData.pomodoroSettings.sound;
}

// ==================== THEME ====================
function initTheme() {
    const theme = appData.theme || 'light';
    document.documentElement.setAttribute('data-theme', theme);
    updateThemeIcon(theme);
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    appData.theme = next;
    saveData();
    updateThemeIcon(next);
}

function updateThemeIcon(theme) {
    document.querySelector('.theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
}

// ==================== NAVIGATION ====================
function showPage(page) {
    currentPage = page;

    // Hide all pages
    document.querySelectorAll('.page').forEach(p => {
        p.classList.remove('active');
    });

    // Show target page
    const target = document.getElementById(`page-${page}`);
    if (target) target.classList.add('active');

    // Update nav links
    document.querySelectorAll('.nav-link').forEach(link => {
        link.classList.toggle('active', link.dataset.page === page);
    });

    // Close mobile menu
    document.getElementById('nav-links').classList.remove('active');

    // Page-specific initialization
    switch (page) {
        case 'home':
            updateHomeStats();
            break;
        case 'flashcards':
            renderFlashcards();
            updateSubjectFilters();
            break;
        case 'quiz':
            updateQuizSetup();
            break;
        case 'notes':
            renderNotesList();
            updateNoteSubjects();
            break;
        case 'stats':
            updateAllStats();
            initHeatmap();
            renderSubjectBars();
            renderQuizHistory();
            break;
        case 'pomodoro':
            break;
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    logActivity();
}

function toggleMobileMenu() {
    document.getElementById('nav-links').classList.toggle('active');
}

// ==================== STREAK ====================
function updateStreak() {
    const today = new Date().toDateString();
    const yesterday = new Date(Date.now() - 86400000).toDateString();

    if (appData.lastActiveDate === today) {
        // Already active today
    } else if (appData.lastActiveDate === yesterday) {
        appData.streak++;
        appData.lastActiveDate = today;
    } else if (appData.lastActiveDate !== today) {
        appData.streak = 1;
        appData.lastActiveDate = today;
    }

    document.getElementById('streak-count').textContent = appData.streak;
    saveData();
}

function logActivity() {
    const today = new Date().toISOString().split('T')[0];
    if (!appData.activityLog[today]) {
        appData.activityLog[today] = 0;
    }
    appData.activityLog[today]++;
    saveData();
}

// ==================== HOME STATS ====================
function updateHomeStats() {
    document.getElementById('total-cards-stat').textContent = appData.flashcards.length;
    document.getElementById('total-quizzes-stat').textContent = appData.quizHistory.length;
    const hours = Math.floor(appData.totalStudyMinutes / 60);
    const mins = appData.totalStudyMinutes % 60;
    document.getElementById('total-time-stat').textContent = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

// ==================== FLASHCARDS ====================
function getSubjects() {
    const subjects = new Set();
    appData.flashcards.forEach(card => {
        if (card.subject) subjects.add(card.subject);
    });
    return [...subjects].sort();
}

function updateSubjectFilters() {
    const filter = document.getElementById('flashcard-subject-filter');
    const subjects = getSubjects();
    filter.innerHTML = '<option value="all">All Subjects</option>';
    subjects.forEach(s => {
        filter.innerHTML += `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`;
    });

    // Update datalist for card modal
    const datalist = document.getElementById('subject-suggestions');
    datalist.innerHTML = '';
    subjects.forEach(s => {
        datalist.innerHTML += `<option value="${escapeHtml(s)}">`;
    });
}

function renderFlashcards() {
    const grid = document.getElementById('flashcard-grid');
    const filter = document.getElementById('flashcard-subject-filter').value;
    const empty = document.getElementById('flashcard-empty');
    const studyBtn = document.getElementById('study-mode-btn');

    let cards = appData.flashcards;
    if (filter !== 'all') {
        cards = cards.filter(c => c.subject === filter);
    }

    if (cards.length === 0) {
        grid.innerHTML = '';
        grid.appendChild(createEmptyState());
        studyBtn.disabled = true;
    } else {
        grid.innerHTML = '';
        cards.forEach(card => {
            grid.appendChild(createCardElement(card));
        });
        studyBtn.disabled = false;
    }

    document.getElementById('cards-count').textContent = `${cards.length} card${cards.length !== 1 ? 's' : ''}`;
}

function createEmptyState() {
    const div = document.createElement('div');
    div.className = 'empty-state';
    div.innerHTML = `
        <div class="empty-icon">🎴</div>
        <h3>No flashcards yet!</h3>
        <p>Create your first flashcard to get started.</p>
        <button class="btn btn-primary" onclick="openCreateCardModal()">+ Create Flashcard</button>
    `;
    return div;
}

function createCardElement(card) {
    const div = document.createElement('div');
    div.className = 'card-item';
    div.innerHTML = `
        <div class="card-item-subject">${escapeHtml(card.subject || 'General')}</div>
        <div class="card-item-question">${escapeHtml(card.front)}</div>
        <div class="card-item-answer">${escapeHtml(card.back)}</div>
        <div class="card-item-actions">
            <button class="btn btn-secondary btn-sm" onclick="editCard('${card.id}')">✏️ Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteCard('${card.id}')">🗑️ Delete</button>
        </div>
    `;
    return div;
}

function openCreateCardModal() {
    editingCardId = null;
    document.getElementById('card-modal-title').textContent = 'Create Flashcard';
    document.getElementById('save-card-btn').textContent = 'Create Card';
    document.getElementById('card-subject').value = '';
    document.getElementById('card-front').value = '';
    document.getElementById('card-back').value = '';
    document.getElementById('card-modal').classList.add('active');
    updateSubjectFilters();
}

function editCard(id) {
    const card = appData.flashcards.find(c => c.id === id);
    if (!card) return;

    editingCardId = id;
    document.getElementById('card-modal-title').textContent = 'Edit Flashcard';
    document.getElementById('save-card-btn').textContent = 'Save Changes';
    document.getElementById('card-subject').value = card.subject || '';
    document.getElementById('card-front').value = card.front;
    document.getElementById('card-back').value = card.back;
    document.getElementById('card-modal').classList.add('active');
    updateSubjectFilters();
}

function closeCardModal() {
    document.getElementById('card-modal').classList.remove('active');
    editingCardId = null;
}

function closeModal(event) {
    if (event.target === event.currentTarget) {
        event.target.classList.remove('active');
    }
}

function saveCard() {
    const subject = document.getElementById('card-subject').value.trim();
    const front = document.getElementById('card-front').value.trim();
    const back = document.getElementById('card-back').value.trim();

    if (!front || !back) {
        showToast('Please fill in both the question and answer.', 'error');
        return;
    }

    if (editingCardId) {
        const card = appData.flashcards.find(c => c.id === editingCardId);
        if (card) {
            card.subject = subject || 'General';
            card.front = front;
            card.back = back;
            card.updatedAt = Date.now();
            showToast('Flashcard updated! ✏️', 'success');
        }
    } else {
        appData.flashcards.push({
            id: generateId(),
            subject: subject || 'General',
            front,
            back,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            difficulty: 'new'
        });
        showToast('Flashcard created! 🎴', 'success');
    }

    saveData();
    closeCardModal();
    renderFlashcards();
    updateSubjectFilters();
}

function deleteCard(id) {
    if (!confirm('Are you sure you want to delete this flashcard?')) return;
    appData.flashcards = appData.flashcards.filter(c => c.id !== id);
    saveData();
    renderFlashcards();
    updateSubjectFilters();
    showToast('Flashcard deleted.', 'info');
}

function filterFlashcards() {
    renderFlashcards();
}

// Study Mode
function startStudyMode() {
    const filter = document.getElementById('flashcard-subject-filter').value;
    studyCards = [...appData.flashcards];
    if (filter !== 'all') {
        studyCards = studyCards.filter(c => c.subject === filter);
    }

    if (studyCards.length === 0) {
        showToast('No cards to study!', 'error');
        return;
    }

    // Shuffle
    shuffleArray(studyCards);
    currentStudyIndex = 0;

    document.getElementById('flashcard-grid-area').style.display = 'none';
    document.getElementById('flashcard-study-area').style.display = 'block';

    showStudyCard();
}

function exitStudyMode() {
    document.getElementById('flashcard-study-area').style.display = 'none';
    document.getElementById('flashcard-grid-area').style.display = 'block';
}

function showStudyCard() {
    if (currentStudyIndex >= studyCards.length) {
        showToast('You\'ve reviewed all cards! 🎉', 'success');
        exitStudyMode();
        return;
    }

    const card = studyCards[currentStudyIndex];
    document.getElementById('study-card-subject').textContent = card.subject || 'General';
    document.getElementById('study-card-front').textContent = card.front;
    document.getElementById('study-card-back').textContent = card.back;

    // Reset flip
    document.getElementById('study-flashcard').classList.remove('flipped');

    // Update progress
    const progress = ((currentStudyIndex) / studyCards.length) * 100;
    document.getElementById('study-progress-fill').style.width = progress + '%';
    document.getElementById('study-progress-text').textContent = `${currentStudyIndex + 1} / ${studyCards.length}`;
}

function flipCard() {
    document.getElementById('study-flashcard').classList.toggle('flipped');
}

function markCard(difficulty) {
    const card = studyCards[currentStudyIndex];
    const original = appData.flashcards.find(c => c.id === card.id);
    if (original) {
        original.difficulty = difficulty;
        saveData();
    }

    currentStudyIndex++;
    showStudyCard();
    logActivity();
}

// ==================== QUIZ ====================
function updateQuizSetup() {
    const select = document.getElementById('quiz-subject');
    const subjects = getSubjects();
    select.innerHTML = '<option value="all">All Subjects</option>';
    subjects.forEach(s => {
        select.innerHTML += `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`;
    });

    const requirement = document.getElementById('quiz-requirement');
    const startBtn = document.getElementById('start-quiz-btn');

    if (appData.flashcards.length < 4) {
        requirement.style.display = 'block';
        startBtn.disabled = true;
    } else {
        requirement.style.display = 'none';
        startBtn.disabled = false;
    }
}

function startQuiz() {
    const subject = document.getElementById('quiz-subject').value;
    const count = parseInt(document.getElementById('quiz-count').value);
    const timePerQ = parseInt(document.getElementById('quiz-time').value);

    let pool = [...appData.flashcards];
    if (subject !== 'all') {
        pool = pool.filter(c => c.subject === subject);
    }

    if (pool.length < 4) {
        showToast('Need at least 4 flashcards for a quiz!', 'error');
        return;
    }

    shuffleArray(pool);
    const questions = pool.slice(0, Math.min(count, pool.length));

    quizState = {
        questions,
        currentIndex: 0,
        score: 0,
        answers: [],
        timePerQ,
        subject,
        timer: null
    };

    document.getElementById('quiz-setup').style.display = 'none';
    document.getElementById('quiz-results').style.display = 'none';
    document.getElementById('quiz-active').style.display = 'block';

    document.getElementById('quiz-total-num').textContent = questions.length;

    showQuizQuestion();
}

function showQuizQuestion() {
    if (quizState.currentIndex >= quizState.questions.length) {
        finishQuiz();
        return;
    }

    const q = quizState.questions[quizState.currentIndex];
    document.getElementById('quiz-question-num').textContent = quizState.currentIndex + 1;
    document.getElementById('quiz-question-text').textContent = q.front;
    document.getElementById('quiz-current-score').textContent = quizState.score;

    // Generate options
    const correctAnswer = q.back;
    let options = [correctAnswer];

    // Get wrong answers from other cards
    const otherCards = appData.flashcards.filter(c => c.id !== q.id);
    shuffleArray(otherCards);
    for (let i = 0; i < Math.min(3, otherCards.length); i++) {
        if (!options.includes(otherCards[i].back)) {
            options.push(otherCards[i].back);
        }
    }

    // Fill remaining with variations if needed
    while (options.length < 4) {
        options.push('(No other answer available)');
    }

    shuffleArray(options);

    const optionsContainer = document.getElementById('quiz-options');
    const letters = ['A', 'B', 'C', 'D'];
    optionsContainer.innerHTML = '';
    options.forEach((opt, i) => {
        const btn = document.createElement('button');
        btn.className = 'quiz-option';
        btn.innerHTML = `<span class="quiz-option-letter">${letters[i]}</span><span>${escapeHtml(opt)}</span>`;
        btn.onclick = () => selectQuizAnswer(btn, opt, correctAnswer);
        optionsContainer.appendChild(btn);
    });

    // Timer
    if (quizState.timePerQ > 0) {
        document.getElementById('quiz-timer').style.display = 'block';
        startQuizTimer();
    } else {
        document.getElementById('quiz-timer').style.display = 'none';
    }
}

function startQuizTimer() {
    clearInterval(quizState.timer);
    let timeLeft = quizState.timePerQ;
    document.getElementById('quiz-timer-text').textContent = timeLeft + 's';
    document.getElementById('quiz-timer-fill').style.width = '100%';

    quizState.timer = setInterval(() => {
        timeLeft--;
        document.getElementById('quiz-timer-text').textContent = timeLeft + 's';
        document.getElementById('quiz-timer-fill').style.width = ((timeLeft / quizState.timePerQ) * 100) + '%';

        if (timeLeft <= 0) {
            clearInterval(quizState.timer);
            // Auto-skip (wrong answer)
            const options = document.querySelectorAll('.quiz-option');
            options.forEach(opt => opt.classList.add('disabled'));
            quizState.answers.push({ correct: false });

            setTimeout(() => {
                quizState.currentIndex++;
                showQuizQuestion();
            }, 1000);
        }
    }, 1000);
}

function selectQuizAnswer(btn, selected, correct) {
    clearInterval(quizState.timer);

    const options = document.querySelectorAll('.quiz-option');
    options.forEach(opt => {
        opt.classList.add('disabled');
        if (opt.querySelector('span:last-child').textContent === correct) {
            opt.classList.add('correct');
        }
    });

    if (selected === correct) {
        btn.classList.add('correct');
        quizState.score++;
        quizState.answers.push({ correct: true });
    } else {
        btn.classList.add('incorrect');
        quizState.answers.push({ correct: false });
    }

    document.getElementById('quiz-current-score').textContent = quizState.score;

    setTimeout(() => {
        quizState.currentIndex++;
        showQuizQuestion();
    }, 1200);
}

function finishQuiz() {
    clearInterval(quizState.timer);

    const total = quizState.questions.length;
    const score = quizState.score;
    const pct = Math.round((score / total) * 100);

    // Save to history
    appData.quizHistory.push({
        id: generateId(),
        subject: quizState.subject === 'all' ? 'All Subjects' : quizState.subject,
        score,
        total,
        percentage: pct,
        date: Date.now()
    });
    saveData();

    // Show results
    document.getElementById('quiz-active').style.display = 'none';
    document.getElementById('quiz-results').style.display = 'block';

    document.getElementById('results-score').textContent = score;
    document.getElementById('results-total').textContent = total;
    document.getElementById('results-percentage').textContent = pct + '%';

    let emoji, title;
    if (pct === 100) { emoji = '🏆'; title = 'Perfect Score!'; }
    else if (pct >= 80) { emoji = '🎉'; title = 'Excellent!'; }
    else if (pct >= 60) { emoji = '👍'; title = 'Good Job!'; }
    else if (pct >= 40) { emoji = '💪'; title = 'Keep Practicing!'; }
    else { emoji = '📚'; title = 'More Study Needed'; }

    document.getElementById('results-emoji').textContent = emoji;
    document.getElementById('results-title').textContent = title;

    // Breakdown
    const breakdown = document.getElementById('results-breakdown');
    breakdown.innerHTML = quizState.answers.map((a, i) =>
        `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px;">
            <span>${a.correct ? '✅' : '❌'}</span>
            <span style="color:var(--text-secondary)">Question ${i + 1}</span>
        </div>`
    ).join('');

    logActivity();
}

function retakeQuiz() {
    document.getElementById('quiz-results').style.display = 'none';
    quizState.currentIndex = 0;
    quizState.score = 0;
    quizState.answers = [];
    shuffleArray(quizState.questions);
    document.getElementById('quiz-active').style.display = 'block';
    showQuizQuestion();
}

function resetQuiz() {
    document.getElementById('quiz-results').style.display = 'none';
    document.getElementById('quiz-active').style.display = 'none';
    document.getElementById('quiz-setup').style.display = 'block';
    updateQuizSetup();
}

// ==================== NOTES ====================
function renderNotesList() {
    const list = document.getElementById('notes-list');
    const search = document.getElementById('notes-search').value.toLowerCase();

    let notes = appData.notes;
    if (search) {
        notes = notes.filter(n =>
            n.title.toLowerCase().includes(search) ||
            n.content.toLowerCase().includes(search)
        );
    }

    // Sort by updated time
    notes.sort((a, b) => b.updatedAt - a.updatedAt);

    if (notes.length === 0) {
        list.innerHTML = '<div class="empty-state-small" id="notes-empty"><p>No notes yet. Create one!</p></div>';
    } else {
        list.innerHTML = '';
        notes.forEach(note => {
            const item = document.createElement('div');
            item.className = `note-list-item ${note.id === currentNoteId ? 'active' : ''}`;
            item.onclick = () => openNote(note.id);
            item.innerHTML = `
                <div class="note-list-item-title">${escapeHtml(note.title || 'Untitled')}</div>
                <div class="note-list-item-preview">${escapeHtml(note.content.substring(0, 60) || 'Empty note...')}</div>
                <div class="note-list-item-date">${formatDate(note.updatedAt)}</div>
            `;
            list.appendChild(item);
        });
    }
}

function createNewNote() {
    const note = {
        id: generateId(),
        title: '',
        content: '',
        subject: '',
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
    appData.notes.push(note);
    saveData();
    openNote(note.id);
    renderNotesList();
    showToast('New note created! 📝', 'success');
}

function openNote(id) {
    currentNoteId = id;
    const note = appData.notes.find(n => n.id === id);
    if (!note) return;

    document.getElementById('notes-editor-empty').style.display = 'none';
    document.getElementById('notes-editor-active').style.display = 'flex';

    document.getElementById('note-title-input').value = note.title;
    document.getElementById('note-content').value = note.content;
    document.getElementById('note-subject-select').value = note.subject || '';

    updateWordCount();
    renderNotesList();
    updateNoteSubjects();
}

function saveCurrentNote() {
    if (!currentNoteId) return;
    const note = appData.notes.find(n => n.id === currentNoteId);
    if (!note) return;

    note.title = document.getElementById('note-title-input').value;
    note.content = document.getElementById('note-content').value;
    note.subject = document.getElementById('note-subject-select').value;
    note.updatedAt = Date.now();

    saveData();
    updateWordCount();
    document.getElementById('note-save-status').textContent = 'Saved ✓';

    // Debounced re-render of sidebar
    clearTimeout(window.noteRenderTimeout);
    window.noteRenderTimeout = setTimeout(() => renderNotesList(), 500);
}

function deleteCurrentNote() {
    if (!currentNoteId) return;
    if (!confirm('Are you sure you want to delete this note?')) return;

    appData.notes = appData.notes.filter(n => n.id !== currentNoteId);
    currentNoteId = null;
    saveData();

    document.getElementById('notes-editor-empty').style.display = 'flex';
    document.getElementById('notes-editor-active').style.display = 'none';

    renderNotesList();
    showToast('Note deleted.', 'info');
}

function searchNotes() {
    renderNotesList();
}

function updateWordCount() {
    const content = document.getElementById('note-content').value;
    const words = content.trim() ? content.trim().split(/\s+/).length : 0;
    document.getElementById('note-word-count').textContent = `${words} word${words !== 1 ? 's' : ''}`;
}

function updateNoteSubjects() {
    const select = document.getElementById('note-subject-select');
    const subjects = getSubjects();
    const currentVal = select.value;
    select.innerHTML = '<option value="">No Subject</option>';
    subjects.forEach(s => {
        select.innerHTML += `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`;
    });
    select.value = currentVal;
}

// ==================== POMODORO ====================
function setPomodoroMode(mode) {
    pomodoroState.mode = mode;
    pomodoroState.running = false;
    clearInterval(pomodoroState.interval);

    document.querySelectorAll('.pomodoro-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`pomo-tab-${mode}`).classList.add('active');

    resetPomodoro();
}

function resetPomodoro() {
    clearInterval(pomodoroState.interval);
    pomodoroState.running = false;

    const settings = appData.pomodoroSettings;
    let minutes;
    switch (pomodoroState.mode) {
        case 'work': minutes = settings.work; break;
        case 'short': minutes = settings.short; break;
        case 'long': minutes = settings.long; break;
    }

    pomodoroState.timeLeft = minutes * 60;
    pomodoroState.totalTime = minutes * 60;

    updatePomodoroDisplay();
    document.getElementById('pomo-btn').textContent = '▶️ Start';
    document.getElementById('pomo-circle').style.strokeDashoffset = '0';
}

function togglePomodoro() {
    if (pomodoroState.running) {
        pausePomodoro();
    } else {
        startPomodoro();
    }
}

function startPomodoro() {
    pomodoroState.running = true;
    document.getElementById('pomo-btn').textContent = '⏸️ Pause';

    pomodoroState.interval = setInterval(() => {
        pomodoroState.timeLeft--;

        if (pomodoroState.timeLeft <= 0) {
            clearInterval(pomodoroState.interval);
            pomodoroState.running = false;
            pomodoroCompleted();
        }

        updatePomodoroDisplay();
    }, 1000);
}

function pausePomodoro() {
    clearInterval(pomodoroState.interval);
    pomodoroState.running = false;
    document.getElementById('pomo-btn').textContent = '▶️ Start';
}

function pomodoroCompleted() {
    if (appData.pomodoroSettings.sound) {
        playNotificationSound();
    }

    if (pomodoroState.mode === 'work') {
        appData.pomodoroSessions++;
        appData.totalStudyMinutes += appData.pomodoroSettings.work;
        saveData();
        showToast(`Session complete! 🎉 Total: ${appData.pomodoroSessions} sessions`, 'success');

        updateSessionDots();

        if (appData.pomodoroSettings.autoStart) {
            // Switch to break
            const nextMode = appData.pomodoroSessions % 4 === 0 ? 'long' : 'short';
            setPomodoroMode(nextMode);
            startPomodoro();
        }
    } else {
        showToast('Break is over! Time to study! 💪', 'info');
        if (appData.pomodoroSettings.autoStart) {
            setPomodoroMode('work');
            startPomodoro();
        }
    }

    document.getElementById('pomo-sessions').textContent = appData.pomodoroSessions;
    logActivity();
}

function updatePomodoroDisplay() {
    const minutes = Math.floor(pomodoroState.timeLeft / 60);
    const seconds = pomodoroState.timeLeft % 60;
    document.getElementById('pomo-time').textContent =
        `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

    // Circle progress
    const circumference = 2 * Math.PI * 90; // r=90
    const progress = pomodoroState.timeLeft / pomodoroState.totalTime;
    const offset = circumference * (1 - progress);
    document.getElementById('pomo-circle').style.strokeDashoffset = offset;

    document.getElementById('pomo-sessions').textContent = appData.pomodoroSessions;
    updateSessionDots();

    // Update page title when timer is running
    if (pomodoroState.running) {
        document.title = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')} - ReviseForFun`;
    } else {
        document.title = 'ReviseForFun - Make Studying Actually Fun 🎮';
    }
}

function updateSessionDots() {
    const container = document.getElementById('session-dots');
    const total = Math.min(appData.pomodoroSessions, 8);
    container.innerHTML = '';
    for (let i = 0; i < 8; i++) {
        const dot = document.createElement('div');
        dot.className = `session-dot ${i < total ? 'completed' : ''}`;
        container.appendChild(dot);
    }
}

function updatePomoSettings() {
    appData.pomodoroSettings.work = parseInt(document.getElementById('pomo-work-duration').value) || 25;
    appData.pomodoroSettings.short = parseInt(document.getElementById('pomo-short-duration').value) || 5;
    appData.pomodoroSettings.long = parseInt(document.getElementById('pomo-long-duration').value) || 15;
    appData.pomodoroSettings.autoStart = document.getElementById('pomo-auto-start').checked;
    appData.pomodoroSettings.sound = document.getElementById('pomo-sound').checked;
    saveData();
    resetPomodoro();
}

function playNotificationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        const gain = ctx.createGain();
        oscillator.connect(gain);
        gain.connect(ctx.destination);
        oscillator.frequency.value = 800;
        oscillator.type = 'sine';
        gain.gain.value = 0.3;
        oscillator.start();
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
        oscillator.stop(ctx.currentTime + 0.5);

        setTimeout(() => {
            const osc2 = ctx.createOscillator();
            const gain2 = ctx.createGain();
            osc2.connect(gain2);
            gain2.connect(ctx.destination);
            osc2.frequency.value = 1000;
            osc2.type = 'sine';
            gain2.gain.value = 0.3;
            osc2.start();
            gain2.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.5);
            osc2.stop(ctx.currentTime + 0.5);
        }, 200);
    } catch (e) {
        // Audio not supported
    }
}

// ==================== STATISTICS ====================
function updateAllStats() {
    document.getElementById('stat-streak').textContent = appData.streak;
    document.getElementById('stat-cards').textContent = appData.flashcards.length;
    document.getElementById('stat-quizzes').textContent = appData.quizHistory.length;
    document.getElementById('stat-notes').textContent = appData.notes.length;

    // Average quiz score
    if (appData.quizHistory.length > 0) {
        const avg = Math.round(
            appData.quizHistory.reduce((sum, q) => sum + q.percentage, 0) / appData.quizHistory.length
        );
        document.getElementById('stat-avg-score').textContent = avg + '%';
    } else {
        document.getElementById('stat-avg-score').textContent = '0%';
    }

    // Study time
    const hours = Math.floor(appData.totalStudyMinutes / 60);
    const mins = appData.totalStudyMinutes % 60;
    document.getElementById('stat-time').textContent = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
}

function initHeatmap() {
    const heatmap = document.getElementById('heatmap');
    heatmap.innerHTML = '';

    const today = new Date();
    const days = 84; // 12 weeks

    for (let i = days - 1; i >= 0; i--) {
        const date = new Date(today);
        date.setDate(date.getDate() - i);
        const key = date.toISOString().split('T')[0];
        const activity = appData.activityLog[key] || 0;

        let level = 0;
        if (activity >= 20) level = 4;
        else if (activity >= 10) level = 3;
        else if (activity >= 5) level = 2;
        else if (activity >= 1) level = 1;

        const cell = document.createElement('div');
        cell.className = `heatmap-cell heatmap-${level}`;
        cell.title = `${key}: ${activity} activities`;
        heatmap.appendChild(cell);
    }
}

function renderSubjectBars() {
    const container = document.getElementById('subject-bars');
    const subjects = getSubjects();

    if (subjects.length === 0) {
        container.innerHTML = '<p class="empty-text">Create some flashcards to see your subject breakdown.</p>';
        return;
    }

    const colors = ['#6c5ce7', '#00cec9', '#fd79a8', '#fdcb6e', '#00b894', '#e17055', '#74b9ff', '#a29bfe'];
    const maxCards = Math.max(...subjects.map(s =>
        appData.flashcards.filter(c => c.subject === s).length
    ));

    container.innerHTML = '';
    subjects.forEach((subject, i) => {
        const count = appData.flashcards.filter(c => c.subject === subject).length;
        const pct = (count / maxCards) * 100;

        container.innerHTML += `
            <div class="subject-bar-item">
                <div class="subject-bar-header">
                    <span>${escapeHtml(subject)}</span>
                    <span>${count} cards</span>
                </div>
                <div class="subject-bar-track">
                    <div class="subject-bar-fill" style="width:${pct}%;background:${colors[i % colors.length]}"></div>
                </div>
            </div>
        `;
    });
}

function renderQuizHistory() {
    const container = document.getElementById('quiz-history');

    if (appData.quizHistory.length === 0) {
        container.innerHTML = '<p class="empty-text">Take a quiz to see your history here.</p>';
        return;
    }

    const recent = [...appData.quizHistory].reverse().slice(0, 10);
    container.innerHTML = '';
    recent.forEach(q => {
        container.innerHTML += `
            <div class="quiz-history-item">
                <span class="quiz-history-subject">${escapeHtml(q.subject)}</span>
                <span class="quiz-history-score">${q.score}/${q.total} (${q.percentage}%)</span>
                <span class="quiz-history-date">${formatDate(q.date)}</span>
            </div>
        `;
    });
}

function confirmResetAllData() {
    if (confirm('⚠️ Are you sure you want to delete ALL your data? This cannot be undone!')) {
        if (confirm('This will delete all flashcards, notes, quiz history, and stats. Are you really sure?')) {
            localStorage.removeItem(STORAGE_KEY);
            location.reload();
        }
    }
}

// ==================== UTILITIES ====================
function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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
        day: 'numeric',
        month: 'short',
        year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
    });
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const icons = { success: '✅', error: '❌', info: 'ℹ️' };
    toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;

    container.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
    // Escape to close modals
    if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
    }
});
