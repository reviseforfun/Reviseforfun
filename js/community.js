/* ==========================================
   REVISEFORFUN - COMMUNITY: ACCOUNTS, CLOUD SYNC, SHARING, LEADERBOARD
   Everything here is optional and degrades gracefully when no backend exists
   (for example on GitHub Pages) – the rest of the app never depends on it.
   ========================================== */

// ==================== SYNC ====================
const Sync = {
    dirty: false,
    inFlight: false,
    timer: null,
    lastSynced: Number(localStorage.getItem('rff_last_sync')) || 0,
    error: null,

    active() { return API.isLoggedIn() && API.state.online; },

    markDirty() {
        this.dirty = true;
        if (!this.active()) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.now({ quiet: true }), 4000);
    },

    async now({ quiet = false } = {}) {
        if (!this.active() || this.inFlight) return false;
        this.inFlight = true;
        paintSyncStatus();
        try {
            const res = await API.sync(appData);
            appData = migrate(Core.mergeData(appData, res.data));
            saveData({ silent: true });
            this.dirty = false;
            this.error = null;
            this.lastSynced = res.syncedAt || Date.now();
            localStorage.setItem('rff_last_sync', String(this.lastSynced));
            applyTheme(appData.theme);
            updateChrome();
            if (['home', 'stats', 'community'].includes(currentPage)) renderers[currentPage]();
            else if (currentPage === 'flashcards' && !study) renderFlashcards();
            if (!quiet) showToast('Synced ✅', 'success');
            return true;
        } catch (e) {
            this.error = e.message;
            if (!quiet) showToast(`Sync failed: ${e.message}`, 'error');
            return false;
        } finally {
            this.inFlight = false;
            paintSyncStatus();
        }
    },
};

setInterval(() => { if (Sync.active() && Sync.dirty) Sync.now({ quiet: true }); }, 120000);
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && Sync.active() && Sync.dirty) Sync.now({ quiet: true });
});

function paintSyncStatus() {
    const el = $('sync-status');
    if (!el) return;
    el.textContent = Sync.inFlight ? 'Syncing…'
        : Sync.error ? `⚠️ ${Sync.error}`
        : Sync.lastSynced ? `Last synced ${formatDate(Sync.lastSynced)}${Sync.dirty ? ' · changes pending' : ''}` : 'Not synced yet';
}

// ==================== COMMUNITY PAGE ====================
renderers.community = async () => {
    if (!API.state.checked) await API.ping();
    paintServerStatus();
    renderAccountCard();
    renderLeaderboard();
    renderSharesCard();
};

function paintServerStatus() {
    $('server-status').innerHTML = API.state.online
        ? '<span class="dot dot-on"></span> Server connected'
        : '<span class="dot"></span> Offline mode';
}

function serverSettingsHtml() {
    return `
        <details class="server-details">
            <summary>Server settings</summary>
            <p class="modal-hint">By default the app talks to the server it was loaded from. Hosting the site separately (e.g. GitHub Pages)? Enter the URL of your ReviseForFun backend.</p>
            <div class="inline-form">
                <input type="url" id="server-url" class="text-input" placeholder="https://your-server.example.com" value="${esc(API.state.base)}" aria-label="Server URL">
                <button class="btn btn-secondary" data-action="save-server">Connect</button>
            </div>
        </details>`;
}

function renderAccountCard() {
    const card = $('account-card');
    if (!API.state.online) {
        card.innerHTML = `
            <h3>👤 Account</h3>
            <div class="offline-note">
                <div class="empty-icon">📴</div>
                <p><strong>Backend not connected.</strong> ReviseForFun works fully offline – everything is saved in this browser.</p>
                <p>To get accounts, cloud sync, deck sharing and the leaderboard, run the backend (<code>npm start</code>) or connect to one below.</p>
                <button class="btn btn-primary" data-action="retry-server">🔄 Try again</button>
            </div>
            ${serverSettingsHtml()}`;
        return;
    }
    if (!API.isLoggedIn()) {
        card.innerHTML = `
            <h3>👤 Sign in to sync</h3>
            <p class="modal-hint">Keep your cards, notes and streak on every device. Your current progress is merged into your account – nothing is lost.</p>
            <form id="auth-form" autocomplete="on">
                <div class="form-group"><label for="auth-username">Username</label><input type="text" id="auth-username" class="text-input" autocomplete="username" maxlength="20" required></div>
                <div class="form-group"><label for="auth-password">Password</label><input type="password" id="auth-password" class="text-input" autocomplete="current-password" minlength="8" required></div>
                <div class="auth-buttons">
                    <button class="btn btn-primary" type="submit">Log in</button>
                    <button class="btn btn-secondary" type="button" data-action="register">Create account</button>
                </div>
                <p class="modal-hint">Usernames are 3–20 letters, numbers or underscores; passwords at least 8 characters. Your username appears on the public leaderboard (you can opt out after signing in).</p>
            </form>
            ${serverSettingsHtml()}`;
        $('auth-form').addEventListener('submit', (e) => { e.preventDefault(); doAuth('login'); });
        return;
    }
    const u = API.state.user;
    card.innerHTML = `
        <h3>👤 ${esc(u.username)}</h3>
        <p class="modal-hint">Signed in. Your progress syncs automatically.</p>
        <div class="sync-row"><span id="sync-status"></span><button class="btn btn-primary btn-sm" data-action="sync-now">🔄 Sync now</button></div>
        <label class="checkbox-label account-opt"><input type="checkbox" data-input="leaderboard-optin" ${u.showOnLeaderboard !== false ? 'checked' : ''}> Show me on the leaderboard</label>
        <div class="auth-buttons">
            <button class="btn btn-secondary" data-action="logout">Log out</button>
            <button class="btn btn-danger" data-action="delete-account">Delete account</button>
        </div>
        ${serverSettingsHtml()}`;
    paintSyncStatus();
}

async function doAuth(kind) {
    const username = $('auth-username').value.trim();
    const password = $('auth-password').value;
    if (!username || !password) return showToast('Enter a username and password.', 'error');
    try {
        if (kind === 'register') await API.register(username, password);
        else await API.login(username, password);
        showToast(kind === 'register' ? 'Account created! 🎉' : `Welcome back, ${username}!`, 'success');
        await Sync.now({ quiet: true });
        renderers.community();
    } catch (e) {
        showToast(e.message, 'error');
    }
}
actions.register = () => doAuth('register');

actions.logout = async () => {
    await API.logout();
    showToast('Logged out. Your data stays on this device.', 'info');
    renderers.community();
};

actions['sync-now'] = async () => { await Sync.now(); };

actions['delete-account'] = async () => {
    const password = prompt('This permanently deletes your account and cloud data (local data on this device stays).\n\nEnter your password to confirm:');
    if (!password) return;
    try {
        await API.deleteAccount(password);
        showToast('Account deleted.', 'info');
        renderers.community();
    } catch (e) { showToast(e.message, 'error'); }
};

inputs['leaderboard-optin'] = async (el) => {
    try {
        await API.setLeaderboard(el.checked);
        showToast(el.checked ? 'You are on the leaderboard.' : 'You are hidden from the leaderboard.', 'info');
        renderLeaderboard();
    } catch (e) { showToast(e.message, 'error'); el.checked = !el.checked; }
};

actions['save-server'] = async () => {
    API.setBase($('server-url').value);
    API.state.checked = false;
    showToast('Connecting…', 'info');
    await API.ping();
    showToast(API.state.online ? 'Connected to the server ✅' : 'Could not reach that server.', API.state.online ? 'success' : 'error');
    renderers.community();
};

actions['retry-server'] = async () => {
    await API.ping();
    renderers.community();
    if (!API.state.online) showToast('Still offline – is the backend running?', 'error');
};

async function renderLeaderboard() {
    const box = $('leaderboard');
    if (!API.state.online) {
        box.innerHTML = '<p class="empty-text">Connect to a server to see the leaderboard.</p>';
        return;
    }
    box.innerHTML = '<p class="empty-text">Loading…</p>';
    try {
        const { leaderboard } = await API.leaderboard();
        if (!leaderboard.length) {
            box.innerHTML = '<p class="empty-text">No one is on the board yet – sign in, study and be the first! 🥇</p>';
            return;
        }
        const me = API.state.user && API.state.user.username;
        box.innerHTML = `<table class="lb-table"><thead><tr><th>#</th><th>Student</th><th>Level</th><th>XP</th><th>🔥</th></tr></thead><tbody>${
            leaderboard.map((r) => `<tr class="${r.username === me ? 'lb-me' : ''}">
                <td>${['🥇', '🥈', '🥉'][r.rank - 1] || r.rank}</td><td>${esc(r.username)}</td><td>${r.level}</td><td>${r.xp}</td><td>${r.streak}</td></tr>`).join('')
        }</tbody></table>
        <p class="modal-hint">XP is self-reported by each student's app, so treat it as friendly competition.</p>`;
    } catch (e) {
        box.innerHTML = `<p class="empty-text">${esc(e.message)}</p>`;
    }
}

// ==================== SHARING ====================
async function renderSharesCard() {
    const card = $('shares-card');
    const header = `<h3>🔗 Shared decks</h3>
        <p class="modal-hint">Share any of your subjects with a code – perfect for classmates and teachers.</p>
        <div class="auth-buttons"><button class="btn btn-secondary" data-action="open-code-modal">Import by code</button>
        <button class="btn btn-primary" data-action="open-share-modal">Share a deck</button></div>`;
    if (!API.isLoggedIn() || !API.state.online) {
        card.innerHTML = header + '<p class="empty-text">Sign in to see the decks you have shared.</p>';
        return;
    }
    card.innerHTML = header + '<p class="empty-text">Loading…</p>';
    try {
        const { shares } = await API.myShares();
        card.innerHTML = header + (shares.length ? `<div class="share-list">${shares.map((s) => `
            <div class="share-item">
                <div><strong>${esc(s.title)}</strong><div class="dash-sub">${plural(s.cardCount, 'card')} · ${formatDate(s.createdAt)}</div></div>
                <code class="share-code">${esc(s.code)}</code>
                <button class="btn btn-ghost btn-sm" data-action="copy-code" data-arg="${esc(s.code)}">📋</button>
                <button class="btn btn-ghost btn-sm" data-action="delete-share" data-arg="${esc(s.code)}">🗑️</button>
            </div>`).join('')}</div>` : '<p class="empty-text">You haven’t shared anything yet.</p>');
    } catch (e) {
        card.innerHTML = header + `<p class="empty-text">${esc(e.message)}</p>`;
    }
}

actions['copy-code'] = async (code) => {
    try { await navigator.clipboard.writeText(code); showToast('Code copied 📋', 'success'); }
    catch { showToast(`Your code: ${code}`, 'info'); }
};

actions['delete-share'] = async (code) => {
    if (!confirm('Stop sharing this deck? The code will stop working.')) return;
    try { await API.deleteShare(code); showToast('Share removed.', 'info'); renderSharesCard(); }
    catch (e) { showToast(e.message, 'error'); }
};

actions['open-share-modal'] = async () => {
    if (!API.state.checked) await API.ping();
    const body = $('share-body');
    const footer = $('share-footer');
    footer.innerHTML = '<button class="btn btn-secondary" data-action="close-modal">Close</button>';
    if (!API.state.online) {
        body.innerHTML = '<p>Sharing needs the backend, which isn’t connected. Run <code>npm start</code> or connect a server on the <a href="#community" data-action="goto" data-arg="community">Community</a> page.</p>';
    } else if (!API.isLoggedIn()) {
        body.innerHTML = '<p>Please <a href="#community" data-action="goto" data-arg="community">sign in</a> first so your shared decks are tied to your account.</p>';
    } else if (!appData.flashcards.length) {
        body.innerHTML = '<p>You don’t have any flashcards to share yet.</p>';
    } else {
        const options = [`<option value="all">All my cards (${Math.min(appData.flashcards.length, 500)}${appData.flashcards.length > 500 ? ', first 500' : ''})</option>`]
            .concat(getSubjects().map((s) => `<option value="${esc(s)}">${esc(s)} (${appData.flashcards.filter((c) => c.subject === s).length})</option>`)).join('');
        const filter = $('flashcard-subject-filter').value;
        body.innerHTML = `
            <div class="form-group"><label for="share-subject">What to share</label><select id="share-subject" class="select-input">${options}</select></div>
            <div class="form-group"><label for="share-title">Deck title</label><input type="text" id="share-title" class="text-input" maxlength="80" placeholder="e.g. Year 10 Biology revision"></div>`;
        if (filter && filter !== 'all') { $('share-subject').value = filter; $('share-title').value = `${filter} revision`; }
        footer.innerHTML = '<button class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="create-share">Create share code</button>';
    }
    openModal('share-modal');
};

actions['create-share'] = async () => {
    const subject = $('share-subject').value;
    const title = $('share-title').value.trim();
    if (!title) return showToast('Give your deck a title.', 'error');
    const cards = appData.flashcards
        .filter((c) => subject === 'all' || c.subject === subject)
        .slice(0, 500)
        .map((c) => ({ front: c.front, back: c.back, subject: c.subject }));
    try {
        const r = await API.createShare(title, cards);
        $('share-body').innerHTML = `
            <p>Your deck <strong>${esc(r.title)}</strong> (${plural(r.cardCount, 'card')}) is ready! Share this code:</p>
            <div class="share-code-big">${esc(r.code)}</div>
            <p class="modal-hint">Anyone can enter it under Library → Import by code.</p>`;
        $('share-footer').innerHTML = `<button class="btn btn-secondary" data-action="close-modal">Done</button><button class="btn btn-primary" data-action="copy-code" data-arg="${esc(r.code)}">📋 Copy code</button>`;
        if (currentPage === 'community') renderSharesCard();
    } catch (e) { showToast(e.message, 'error'); }
};

let pendingShare = null;

actions['open-code-modal'] = async () => {
    pendingShare = null;
    $('code-input').value = '';
    $('code-preview').innerHTML = '';
    const btn = $('code-btn');
    btn.textContent = 'Find deck';
    btn.dataset.action = 'lookup-code';
    openModal('code-modal');
    if (!API.state.checked) await API.ping();
    if (!API.state.online) $('code-preview').innerHTML = '<p class="quiz-requirement">The backend isn’t connected, so share codes can’t be looked up right now.</p>';
};

actions['lookup-code'] = async () => {
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 8) return showToast('Share codes are 8 characters long.', 'error');
    try {
        const share = await API.getShare(code);
        pendingShare = share;
        $('code-preview').innerHTML = `<div class="share-preview"><strong>${esc(share.title)}</strong>
            <div class="dash-sub">by ${esc(share.author)} · ${plural(share.cards.length, 'card')}</div>
            <div class="preview-list preview-short">${share.cards.slice(0, 5).map((c) => `<div class="preview-row"><div class="preview-q">${esc(c.front)}</div><div class="preview-a">${esc(c.back)}</div></div>`).join('')}</div></div>`;
        const btn = $('code-btn');
        btn.textContent = `Add ${share.cards.length} cards`;
        btn.dataset.action = 'import-code';
    } catch (e) { showToast(e.message, 'error'); }
};

actions['import-code'] = () => {
    if (!pendingShare) return;
    const added = addCards(pendingShare.cards, pendingShare.title);
    commit();
    closeModals();
    refreshDeckViews();
    showToast(added ? `Added ${plural(added, 'card')} from “${pendingShare.title}” 🎉` : 'You already have all of these cards.', added ? 'success' : 'info');
    pendingShare = null;
};

document.addEventListener('input', (e) => {
    if (e.target.id === 'code-input') {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
        // editing the code resets the lookup
        const btn = $('code-btn');
        if (btn.dataset.action !== 'lookup-code') { btn.dataset.action = 'lookup-code'; btn.textContent = 'Find deck'; $('code-preview').innerHTML = ''; pendingShare = null; }
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'code-input') { e.preventDefault(); $('code-btn').click(); }
});
