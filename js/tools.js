/* ==========================================
   REVISEFORFUN - NOTES, POMODORO TIMER & DATA TOOLS
   ========================================== */

// ==================== MARKDOWN (safe subset) ====================
function renderMarkdown(source) {
    const inline = (text) => esc(text)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"']+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

    const out = [];
    let list = null; // 'ul' | 'ol'
    let code = null;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };

    for (const line of String(source).split(/\r?\n/)) {
        if (/^```/.test(line)) {
            if (code === null) { closeList(); code = []; } else { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
            continue;
        }
        if (code !== null) { code.push(line); continue; }
        let m;
        if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { closeList(); out.push(`<h${m[1].length}>${inline(m[2])}</h${m[1].length}>`); }
        else if (/^\s*([-*])\s+/.test(line)) {
            if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
            out.push(`<li>${inline(line.replace(/^\s*[-*]\s+/, ''))}</li>`);
        } else if (/^\s*\d+[.)]\s+/.test(line)) {
            if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
            out.push(`<li>${inline(line.replace(/^\s*\d+[.)]\s+/, ''))}</li>`);
        } else if (/^>\s?/.test(line)) { closeList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); }
        else if (/^---+$/.test(line.trim())) { closeList(); out.push('<hr>'); }
        else if (line.includes(' :: ')) {
            closeList();
            const i = line.indexOf(' :: ');
            out.push(`<div class="md-card"><span class="md-q">${inline(line.slice(0, i))}</span><span class="md-a">${inline(line.slice(i + 4))}</span></div>`);
        } else if (!line.trim()) closeList();
        else { closeList(); out.push(`<p>${inline(line)}</p>`); }
    }
    if (code !== null) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
    closeList();
    return out.join('\n');
}

// ==================== NOTES ====================
let currentNoteId = null;
let notePreview = false;
let noteSaveTimer = null;

function findNote(id) { return appData.notes.find((n) => n.id === id); }

renderers.notes = () => {
    renderNotesList();
    const note = currentNoteId && findNote(currentNoteId);
    if (note) openNote(note.id); else showNoteEditor(false);
};

function showNoteEditor(show) {
    $('notes-editor-empty').hidden = show;
    $('note-editor-content').hidden = !show;
}

function renderNotesList() {
    const list = $('notes-list');
    const q = $('notes-search').value.toLowerCase().trim();
    const notes = appData.notes
        .filter((n) => !q || `${n.title} ${n.content} ${n.subject}`.toLowerCase().includes(q))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    if (!notes.length) {
        list.innerHTML = `<div class="empty-state-small"><p>${appData.notes.length ? 'No notes match.' : 'No notes yet. Create one!'}</p></div>`;
        return;
    }
    list.innerHTML = notes.map((n) => `
        <div class="note-list-item ${n.id === currentNoteId ? 'active' : ''}" data-action="open-note" data-arg="${esc(n.id)}">
            <div class="note-list-item-title">${esc(n.title || 'Untitled')}</div>
            <div class="note-list-item-preview">${esc(n.content.slice(0, 60) || 'Empty note…')}</div>
            <div class="note-list-item-date">${n.subject ? `${esc(n.subject)} · ` : ''}${formatDate(n.updatedAt)}</div>
        </div>`).join('');
}
inputs['render-notes'] = renderNotesList;

actions['new-note'] = () => {
    const now = Date.now();
    const note = { id: generateId(), title: '', subject: '', content: '', createdAt: now, updatedAt: now };
    appData.notes.push(note);
    commit();
    $('notes-search').value = '';
    renderNotesList();
    openNote(note.id);
    $('note-title-input').focus();
};

actions['open-note'] = (id) => openNote(id);

function openNote(id) {
    const note = findNote(id);
    if (!note) return;
    currentNoteId = id;
    showNoteEditor(true);
    $('note-title-input').value = note.title;
    $('note-subject-input').value = note.subject || '';
    $('note-content').value = note.content;
    setNotePreview(false);
    updateNoteFooter(note, true);
    $('subject-suggestions').innerHTML = getSubjects().map((s) => `<option value="${esc(s)}">`).join('');
    renderNotesList();
}

function updateNoteFooter(note, saved) {
    const words = note.content.trim() ? note.content.trim().split(/\s+/).length : 0;
    $('note-word-count').textContent = plural(words, 'word');
    $('note-saved').textContent = saved ? 'Saved' : 'Saving…';
}

inputs['save-note'] = () => {
    const note = findNote(currentNoteId);
    if (!note) return;
    note.title = $('note-title-input').value;
    note.subject = $('note-subject-input').value.trim();
    note.content = $('note-content').value;
    note.updatedAt = Date.now();
    updateNoteFooter(note, false);
    clearTimeout(noteSaveTimer);
    noteSaveTimer = setTimeout(() => {
        commit();
        renderNotesList();
        updateNoteFooter(note, true);
    }, 400);
};

window.addEventListener('pagehide', () => {
    if (noteSaveTimer) { clearTimeout(noteSaveTimer); saveData(); }
});

function setNotePreview(on) {
    notePreview = on;
    $('note-content').hidden = on;
    $('note-preview').hidden = !on;
    $('note-preview-btn').textContent = on ? '✏️ Edit' : '👁 Preview';
    if (on) $('note-preview').innerHTML = renderMarkdown($('note-content').value) || '<p class="empty-text">Nothing to preview yet.</p>';
}
actions['toggle-note-preview'] = () => setNotePreview(!notePreview);

actions['delete-note'] = () => {
    const note = findNote(currentNoteId);
    if (!note || !confirm(`Delete “${note.title || 'Untitled'}”?`)) return;
    appData.notes = appData.notes.filter((n) => n.id !== note.id);
    appData.deleted[note.id] = Date.now();
    currentNoteId = null;
    commit();
    showNoteEditor(false);
    renderNotesList();
    showToast('Note deleted.', 'info');
};

actions['note-to-cards'] = () => {
    const note = findNote(currentNoteId);
    if (!note) return;
    const cards = note.content.split(/\r?\n/).map((line) => {
        const i = line.indexOf(' :: ');
        return i === -1 ? null : { front: line.slice(0, i).replace(/^[-*\d.)\s]+/, '').trim(), back: line.slice(i + 4).trim() };
    }).filter((c) => c && c.front && c.back);
    if (!cards.length) return showToast('No “question :: answer” lines found in this note.', 'error');
    const added = addCards(cards, note.subject || note.title || 'Notes');
    commit();
    showToast(added ? `Created ${plural(added, 'flashcard')} from this note 🎴` : 'Those cards already exist.', added ? 'success' : 'info');
};

// ==================== POMODORO ====================
const pomo = { mode: 'work', running: false, timeLeft: 0, totalTime: 0, endAt: 0, interval: null };
const POMO_LABELS = { work: 'Focus', short: 'Short Break', long: 'Long Break' };

renderers.pomodoro = () => {
    const s = appData.pomodoroSettings;
    $('pomo-work-duration').value = s.work;
    $('pomo-short-duration').value = s.short;
    $('pomo-long-duration').value = s.long;
    $('pomo-auto-start').checked = s.autoStart;
    $('pomo-sound').checked = s.sound;
    if (!pomo.running) setPomodoroMode(pomo.mode);
    else updatePomodoroDisplay();
};

function setPomodoroMode(mode) {
    stopPomodoroTimer();
    pomo.mode = mode;
    pomo.totalTime = appData.pomodoroSettings[mode] * 60;
    pomo.timeLeft = pomo.totalTime;
    document.querySelectorAll('.pomodoro-tab').forEach((t) => t.classList.toggle('active', t.id === `pomo-tab-${mode}`));
    $('pomo-btn').textContent = '▶️ Start';
    updatePomodoroDisplay();
}

function stopPomodoroTimer() {
    clearInterval(pomo.interval);
    pomo.interval = null;
    pomo.running = false;
}

function startPomodoro() {
    if (pomo.running) return;
    pomo.running = true;
    pomo.endAt = Date.now() + pomo.timeLeft * 1000;
    $('pomo-btn').textContent = '⏸️ Pause';
    pomo.interval = setInterval(() => {
        pomo.timeLeft = Math.max(0, Math.ceil((pomo.endAt - Date.now()) / 1000));
        updatePomodoroDisplay();
        if (pomo.timeLeft <= 0) pomodoroCompleted();
    }, 250);
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    updatePomodoroDisplay();
}

function pausePomodoro() {
    stopPomodoroTimer();
    $('pomo-btn').textContent = '▶️ Resume';
    updatePomodoroDisplay();
}

actions['pomo-toggle'] = () => (pomo.running ? pausePomodoro() : startPomodoro());
actions['pomo-reset'] = () => setPomodoroMode(pomo.mode);
actions['pomo-mode'] = (mode) => setPomodoroMode(mode);

function notifyPomodoro(title, body) {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
        try { new Notification(title, { body }); } catch { /* not allowed */ }
    }
}

function pomodoroCompleted() {
    stopPomodoroTimer();
    const s = appData.pomodoroSettings;
    if (s.sound) playNotificationSound();
    let next;
    if (pomo.mode === 'work') {
        appData.pomodoroSessions++;
        appData.totalStudyMinutes += s.work;
        award(25);
        recordActivity(5);
        commit();
        showToast(`Focus session complete! 🎉 +25 XP (${appData.pomodoroSessions} total)`, 'success');
        notifyPomodoro('Focus session complete 🎉', 'Time for a break.');
        next = appData.pomodoroSessions % 4 === 0 ? 'long' : 'short';
    } else {
        showToast('Break is over! Time to study! 💪', 'info');
        notifyPomodoro('Break is over', 'Ready for another focus session?');
        next = 'work';
    }
    setPomodoroMode(next);
    if (s.autoStart) startPomodoro();
}

function updatePomodoroDisplay() {
    const m = Math.floor(pomo.timeLeft / 60);
    const sec = pomo.timeLeft % 60;
    const text = `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
    $('pomo-time').textContent = text;
    const circumference = 2 * Math.PI * 90;
    const progress = pomo.totalTime ? pomo.timeLeft / pomo.totalTime : 1;
    $('pomo-circle').style.strokeDashoffset = circumference * (1 - progress);
    $('pomo-sessions').textContent = appData.pomodoroSessions;
    const dots = $('session-dots');
    const done = Math.min(appData.pomodoroSessions, 8);
    dots.innerHTML = Array.from({ length: 8 }, (_, i) => `<div class="session-dot ${i < done ? 'completed' : ''}"></div>`).join('');
    document.title = pomo.running
        ? `${text} ${POMO_LABELS[pomo.mode]} - ReviseForFun`
        : 'ReviseForFun - Make Studying Actually Fun 🎮';
}

inputs['pomo-settings'] = () => {
    const clamp = (id, min, max, fallback) => Math.min(Math.max(parseInt($(id).value, 10) || fallback, min), max);
    const s = appData.pomodoroSettings;
    s.work = clamp('pomo-work-duration', 1, 180, 25);
    s.short = clamp('pomo-short-duration', 1, 60, 5);
    s.long = clamp('pomo-long-duration', 1, 120, 15);
    s.autoStart = $('pomo-auto-start').checked;
    s.sound = $('pomo-sound').checked;
    saveData();
    if (!pomo.running) setPomodoroMode(pomo.mode);
};

function playNotificationSound() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        [800, 1000].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = freq;
            osc.type = 'sine';
            const t = ctx.currentTime + i * 0.2;
            gain.gain.setValueAtTime(0.3, t);
            gain.gain.exponentialRampToValueAtTime(0.01, t + 0.5);
            osc.start(t);
            osc.stop(t + 0.5);
        });
    } catch { /* audio not supported */ }
}

// ==================== BACKUP RESTORE ====================
document.addEventListener('change', (e) => {
    if (e.target.id !== 'backup-file') return;
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 20 * 1024 * 1024) return showToast('That file is too large.', 'error');
    const reader = new FileReader();
    reader.onload = () => {
        try {
            const imported = migrate(JSON.parse(String(reader.result)));
            if (!confirm(`Merge this backup (${plural(imported.flashcards.length, 'card')}, ${plural(imported.notes.length, 'note')}) into your current data?`)) return;
            appData = migrate(Core.mergeData(appData, imported));
            commit();
            applyTheme(appData.theme);
            renderers.stats();
            showToast('Backup restored and merged. ✅', 'success');
        } catch {
            showToast('That file is not a valid ReviseForFun backup.', 'error');
        }
    };
    reader.readAsText(file);
});
