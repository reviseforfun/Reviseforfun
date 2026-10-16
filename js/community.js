/* =========================================
   REVISEFORFUN - COMMUNITY: ACCOUNTS, CLOUD SYNC, SHARING, CHALLENGES
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
            // A background sync must never repaint over a half-typed form or dialog.
            if (isUserTyping()) { /* skip: the next sync, or leaving the field, catches up */ }
            else if (['home', 'stats', 'community', 'plan'].includes(currentPage)) renderers[currentPage]();
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

/**
 * True while repainting would destroy what the user is doing: a dialog is open
 * (the sign-in, email, password, share and challenge modals live in #info-modal
 * and friends) or the focus is in a text field.
 */
function isUserTyping() {
    if (document.querySelector('.modal.active')) return true;
    const el = document.activeElement;
    return !!(el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) && !el.disabled);
}

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

// ==================== GENERIC DIALOG ====================
/** #info-modal powers every account dialog (recovery code, devices, reset…). */
function infoModal({ title, body, footer, wide = false }) {
    $('info-modal-title').textContent = title;
    $('info-modal-body').innerHTML = body;
    $('info-modal-footer').innerHTML = footer || '<button class="btn btn-secondary" data-action="close-modal">Close</button>';
    $('info-modal').querySelector('.modal').classList.toggle('modal-wide', wide);
    openModal('info-modal');
}

// ==================== COMMUNITY PAGE ====================
renderers.community = async () => {
    if (!API.state.checked) await API.ping();
    paintServerStatus();
    renderAccountCard();
    renderLeaderboard();
    renderSharesCard();
    renderChallengesCard();
    handleCommunityDeepLink();
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
                <p>To get accounts, cloud sync, deck sharing, challenges and the leaderboard, run the backend (<code>npm start</code>) or connect to one below.</p>
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
                <div class="form-group"><label for="auth-username">Username or verified email</label><input type="text" id="auth-username" class="text-input" autocomplete="username" maxlength="64" required></div>
                <div class="form-group"><label for="auth-password">Password</label><input type="password" id="auth-password" class="text-input" autocomplete="current-password" minlength="8" required></div>
                <details class="server-details" id="auth-email-box">
                    <summary>Optional: add an email address</summary>
                    <p class="modal-hint">Only needed if you ever forget your password. You will get a link to confirm it, and until then it cannot be used to sign in.</p>
                    <input type="email" id="auth-email" class="text-input" placeholder="you@example.com" autocomplete="email" maxlength="254">
                </details>
                <div class="auth-buttons">
                    <button class="btn btn-primary" type="submit">Log in</button>
                    <button class="btn btn-secondary" type="button" data-action="register">Create account</button>
                </div>
                <div class="auth-links">
                    <button type="button" class="link-btn" data-action="forgot-dialog">Forgot your password?</button>
                    <button type="button" class="link-btn" data-action="recover-dialog">Use recovery code</button>
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
        <div class="account-email" id="account-email">${emailStatusHtml(u)}</div>
        <label class="checkbox-label account-opt"><input type="checkbox" data-input="leaderboard-optin" ${u.showOnLeaderboard !== false ? 'checked' : ''}> Show me on the leaderboard</label>
        <div class="account-actions">
            <button class="btn btn-secondary btn-sm" data-action="email-dialog">✉️ Email</button>
            <button class="btn btn-secondary btn-sm" data-action="change-password-dialog">🔒 Change password</button>
            <button class="btn btn-secondary btn-sm" data-action="replace-recovery-dialog">🔑 Recovery code</button>
            <button class="btn btn-secondary btn-sm" data-action="devices-dialog">📱 Devices</button>
        </div>
        <div class="auth-buttons">
            <button class="btn btn-secondary" data-action="logout">Log out</button>
            <button class="btn btn-secondary" data-action="logout-all">Log out everywhere</button>
            <button class="btn btn-danger" data-action="delete-account">Delete account</button>
        </div>
        ${serverSettingsHtml()}`;
    paintSyncStatus();
}

function emailStatusHtml(u) {
    if (!u.email) {
        return '<div class="email-status email-none">📭 <strong>No email address.</strong> You can only sign in with your username – add one to get password resets.</div>';
    }
    if (!u.emailVerified) {
        return `<div class="email-status email-pending">⚠️ <strong>${esc(u.email)}</strong> is not verified yet.
            <button class="link-btn" data-action="resend-verification">Resend the link</button></div>`;
    }
    return `<div class="email-status email-ok">✅ <strong>${esc(u.email)}</strong> is verified – you can sign in with it and reset your password.</div>`;
}

// ---------- sign in / register ----------
async function doAuth(kind) {
    const identifier = $('auth-username').value.trim();
    const password = $('auth-password').value;
    if (!identifier || !password) return showToast('Enter a username and password.', 'error');
    try {
        if (kind === 'register') {
            const email = ($('auth-email') && $('auth-email').value.trim()) || '';
            const r = await API.register(identifier, password, email);
            showToast('Account created! 🎉', 'success');
            if (r.recoveryCode) showRecoveryDialog(r.recoveryCode, { first: true });
            await Sync.now({ quiet: true });
            renderers.community();
            if (email) showToast('Check your inbox to verify that email address.', 'info');
        } else {
            const r = await API.login(identifier, password);
            showToast(`Welcome back, ${r.user.username}!`, 'success');
            await Sync.now({ quiet: true });
            renderers.community();
        }
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

actions['logout-all'] = async () => {
    if (!confirm('Sign out of every device, including this one?')) return;
    await API.logoutAll();
    showToast('Signed out everywhere.', 'info');
    renderers.community();
};

actions['sync-now'] = async () => { await Sync.now(); };

// ---------- recovery code ----------
let pendingRecovery = '';

function showRecoveryDialog(code, { first = false } = {}) {
    pendingRecovery = code;
    infoModal({
        title: first ? '🔑 Save your recovery code' : '🔑 Your new recovery code',
        body: `<p class="modal-hint">${first
            ? 'This is the only way back into your account if you lose your password and your email. It is shown <strong>once</strong> – only a hash of it is stored.'
            : 'Your old recovery code stops working immediately. Save the new one somewhere safe.'}</p>
            <div class="share-code-big recovery-code" id="recovery-code">${esc(code)}</div>
            <p class="modal-hint">Use it with your username on the sign-in form (“Use recovery code”) to set a new password.</p>`,
        footer: `<button class="btn btn-secondary" data-action="copy-recovery">📋 Copy</button>
            <button class="btn btn-secondary" data-action="download-recovery">⬇️ Download</button>
            <button class="btn btn-primary" data-action="recovery-saved">I've saved it</button>`,
    });
}

actions['copy-recovery'] = async () => {
    try { await navigator.clipboard.writeText(pendingRecovery); showToast('Recovery code copied 📋', 'success'); }
    catch { showToast(`Your code: ${pendingRecovery}`, 'info'); }
};

actions['download-recovery'] = () => {
    const user = API.state.user ? API.state.user.username : 'account';
    downloadFile(`reviseforfun-recovery-${user}.txt`,
        `ReviseForFun recovery code for ${user}\n\n${pendingRecovery}\n\nKeep this somewhere safe. It is shown only once and cannot be replaced.\n`);
    showToast('Recovery code downloaded.', 'success');
};

actions['recovery-saved'] = () => { pendingRecovery = ''; closeModals(); renderers.community(); };

actions['replace-recovery-dialog'] = () => {
    infoModal({
        title: '🔑 Replace your recovery code',
        body: `<p class="modal-hint">Your current code stops working as soon as you make a new one.</p>
            <div class="form-group"><label for="rc-password">Your password</label>
            <input type="password" id="rc-password" class="text-input" autocomplete="current-password"></div>`,
        footer: '<button class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="do-replace-recovery">Make a new code</button>',
    });
};

actions['do-replace-recovery'] = async () => {
    const password = $('rc-password').value;
    if (!password) return showToast('Enter your password.', 'error');
    try {
        const r = await API.newRecoveryCode(password);
        showRecoveryDialog(r.recoveryCode, { first: false });
    } catch (e) { showToast(e.message, 'error'); }
};

// ---------- forgot / reset / recover ----------
actions['forgot-dialog'] = () => {
    infoModal({
        title: '🔑 Forgot your password?',
        body: `<p class="modal-hint">Enter your username or your <strong>verified</strong> email. If we can reach you, a reset link is on its way.</p>
            <div class="form-group"><label for="forgot-identifier">Username or email</label>
            <input type="text" id="forgot-identifier" class="text-input" autocomplete="username"></div>`,
        footer: '<button class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="do-forgot">Send reset link</button>',
    });
};

actions['do-forgot'] = async () => {
    const identifier = $('forgot-identifier').value.trim();
    if (!identifier) return showToast('Enter your username or email.', 'error');
    try {
        const r = await API.forgot(identifier);
        $('info-modal-body').innerHTML = `<p class="modal-hint">${esc(r.message || 'If that account exists, a reset link is on its way.')}</p>
            <p class="modal-hint">No email? Use your recovery code from the sign-in form instead.</p>`;
        $('info-modal-footer').innerHTML = '<button class="btn btn-primary" data-action="close-modal">Done</button>';
    } catch (e) { showToast(e.message, 'error'); }
};

function openResetDialog(token) {
    infoModal({
        title: '🔓 Choose a new password',
        body: `<p class="modal-hint">You opened a password-reset link. Pick a new password – every device will be signed out.</p>
            <div class="form-group"><label for="reset-password">New password</label>
            <input type="password" id="reset-password" class="text-input" autocomplete="new-password" minlength="8"></div>
            <div class="form-group"><label for="reset-password2">Repeat it</label>
            <input type="password" id="reset-password2" class="text-input" autocomplete="new-password" minlength="8"></div>`,
        footer: '<button class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="do-reset">Set new password</button>',
    });
    $('info-modal-body').dataset.token = token;
}

actions['do-reset'] = async () => {
    const token = $('info-modal-body').dataset.token;
    const password = $('reset-password').value;
    if (password !== $('reset-password2').value) return showToast('The two passwords do not match.', 'error');
    try {
        await API.reset(token, password);
        closeModals();
        showToast('Password changed – please sign in again.', 'success');
        renderers.community();
    } catch (e) { showToast(e.message, 'error'); }
};

actions['recover-dialog'] = () => {
    infoModal({
        title: '🔑 Use your recovery code',
        body: `<p class="modal-hint">Lost your password and your email? Your recovery code gets you back in – the old code is burned and you get a new one.</p>
            <div class="form-group"><label for="recover-username">Username</label><input type="text" id="recover-username" class="text-input" autocomplete="username"></div>
            <div class="form-group"><label for="recover-code">Recovery code</label><input type="text" id="recover-code" class="text-input recovery-input" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" maxlength="24"></div>
            <div class="form-group"><label for="recover-password">New password</label><input type="password" id="recover-password" class="text-input" autocomplete="new-password" minlength="8"></div>`,
        footer: '<button class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="do-recover">Recover my account</button>',
    });
};

actions['do-recover'] = async () => {
    const username = $('recover-username').value.trim();
    const code = $('recover-code').value.trim();
    const password = $('recover-password').value;
    if (!username || !code || !password) return showToast('Fill in all three fields.', 'error');
    try {
        const r = await API.recover(username, code, password);
        closeModals();
        showToast(`Welcome back, ${r.user.username}!`, 'success');
        if (r.recoveryCode) showRecoveryDialog(r.recoveryCode, { first: false });
        await Sync.now({ quiet: true });
        renderers.community();
    } catch (e) { showToast(e.message, 'error'); }
};

// ---------- email ----------
actions['resend-verification'] = async () => {
    try {
        await API.resendVerification();
        showToast('Verification email sent 📬', 'success');
    } catch (e) { showToast(e.message, 'error'); }
};

actions['email-dialog'] = () => {
    const u = API.state.user || {};
    infoModal({
        title: '✉️ Your email address',
        body: `<p class="modal-hint">An email is optional. A verified address lets you sign in with it and reset a lost password. It is never shown to other students.</p>
            <div class="form-group"><label for="email-input">Email address</label>
            <input type="email" id="email-input" class="text-input" value="${esc(u.email || '')}" placeholder="you@example.com" autocomplete="email"></div>
            <div class="form-group"><label for="email-password">Confirm with your password</label>
            <input type="password" id="email-password" class="text-input" autocomplete="current-password"></div>
            ${u.email ? '<p class="modal-hint">Leave the box empty and save to remove the address from your account.</p>' : ''}`,
        footer: '<button class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="do-set-email">Save</button>',
    });
};

actions['do-set-email'] = async () => {
    const email = $('email-input').value.trim();
    const password = $('email-password').value;
    if (!password) return showToast('Enter your password to change your email.', 'error');
    try {
        const user = await API.setEmail(email || null, password);
        closeModals();
        showToast(email ? `Verification link sent to ${email} 📬` : 'Email address removed.', 'success');
        renderAccountCard();
        void user;
    } catch (e) { showToast(e.message, 'error'); }
};

// ---------- password ----------
actions['change-password-dialog'] = () => {
    infoModal({
        title: '🔒 Change your password',
        body: `<p class="modal-hint">Other devices are signed out when you change it – this one stays signed in.</p>
            <div class="form-group"><label for="cp-old">Current password</label><input type="password" id="cp-old" class="text-input" autocomplete="current-password"></div>
            <div class="form-group"><label for="cp-new">New password</label><input type="password" id="cp-new" class="text-input" autocomplete="new-password" minlength="8"></div>
            <div class="form-group"><label for="cp-new2">Repeat new password</label><input type="password" id="cp-new2" class="text-input" autocomplete="new-password" minlength="8"></div>`,
        footer: '<button class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="do-change-password">Change password</button>',
    });
};

actions['do-change-password'] = async () => {
    const oldPassword = $('cp-old').value;
    const newPassword = $('cp-new').value;
    if (!oldPassword || !newPassword) return showToast('Fill in both passwords.', 'error');
    if (newPassword !== $('cp-new2').value) return showToast('The two new passwords do not match.', 'error');
    try {
        await API.changePassword(oldPassword, newPassword);
        closeModals();
        showToast('Password changed. Other devices were signed out.', 'success');
    } catch (e) { showToast(e.message, 'error'); }
};

// ---------- devices ----------
actions['devices-dialog'] = async () => {
    infoModal({ title: '📱 Your devices', body: '<p class="empty-text">Loading…</p>' });
    try {
        const { sessions } = await API.sessions();
        paintDevices(sessions);
    } catch (e) {
        $('info-modal-body').innerHTML = `<p class="empty-text">${esc(e.message)}</p>`;
    }
};

function paintDevices(sessions) {
    $('info-modal-body').innerHTML = sessions.length ? `
        <p class="modal-hint">Every browser signed in to your account. Sessions last 30 days and each account keeps its 10 most recent.</p>
        <div class="device-list">${sessions.map((s) => `
            <div class="device-item">
                <div><strong>${esc(s.device || 'Unknown device')}</strong>
                    <div class="dash-sub">Added ${formatDate(s.createdAt)} · used ${s.lastUsed ? formatDate(s.lastUsed) : 'never'}${s.current ? ' · <strong>this device</strong>' : ''}</div>
                </div>
                ${s.current ? '<span class="status-chip status-mastered">current</span>'
                    : `<button class="btn btn-danger btn-sm" data-action="revoke-device" data-arg="${esc(s.id)}">Sign out</button>`}
            </div>`).join('')}</div>` : '<p class="empty-text">No sessions found.</p>';
    $('info-modal-footer').innerHTML = `
        <button class="btn btn-secondary" data-action="close-modal">Close</button>
        <button class="btn btn-danger" data-action="revoke-others">Sign out all other devices</button>`;
}

actions['revoke-device'] = async (id) => {
    try {
        await API.revokeSession(id);
        const { sessions } = await API.sessions();
        paintDevices(sessions);
        showToast('That device was signed out.', 'info');
    } catch (e) { showToast(e.message, 'error'); }
};

actions['revoke-others'] = async () => {
    try {
        const { sessions } = await API.sessions();
        for (const s of sessions) if (!s.current) await API.revokeSession(s.id);
        const after = await API.sessions();
        paintDevices(after.sessions);
        showToast('Every other device was signed out.', 'success');
    } catch (e) { showToast(e.message, 'error'); }
};

actions['delete-account'] = () => {
    infoModal({
        title: '🗑️ Delete your account',
        body: `<p class="modal-hint">This permanently deletes your account, your synced data, your shared decks and your challenges. Data on this device stays.</p>
            <div class="form-group"><label for="delete-password">Your password</label>
            <input type="password" id="delete-password" class="text-input" autocomplete="current-password"></div>`,
        footer: '<button class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn btn-danger" data-action="do-delete-account">Delete forever</button>',
    });
};

actions['do-delete-account'] = async () => {
    const password = $('delete-password').value;
    if (!password) return showToast('Enter your password to confirm.', 'error');
    try {
        await API.deleteAccount(password);
        closeModals();
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

function challengeLink(code) {
    return `${location.origin}${location.pathname}#community?challenge=${code}`;
}

actions['copy-challenge-link'] = async (code) => {
    const link = challengeLink(code);
    try { await navigator.clipboard.writeText(link); showToast('Challenge link copied 🔗', 'success'); }
    catch { showToast(`Link: ${link}`, 'info'); }
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

// ==================== FRIEND CHALLENGES ====================
let pendingShare = null;
let pendingChallenge = null;

async function renderChallengesCard() {
    const card = $('challenge-card');
    if (!card) return;
    const header = `<h3>⚔️ Friend challenges</h3>
        <p class="modal-hint">Turn a subject into a timed multiple-choice quiz, then send the code to your friends. Fastest, most accurate answer wins the board.</p>
        <div class="auth-buttons"><button class="btn btn-secondary" data-action="open-code-modal">Enter a code</button>
        <button class="btn btn-primary" data-action="open-challenge-modal">Create a challenge</button></div>`;
    if (!API.state.online || !API.isLoggedIn()) {
        card.innerHTML = header + '<p class="empty-text">Sign in to create and play challenges.</p>';
        return;
    }
    card.innerHTML = header + '<p class="empty-text">Loading…</p>';
    try {
        const { challenges } = await API.myChallenges();
        card.innerHTML = header + (challenges.length ? `<div class="share-list">${challenges.map((c) => `
            <div class="share-item">
                <div><strong>${esc(c.title)}</strong>
                    <div class="dash-sub">${plural(c.cardCount, 'question')} · ${plural(c.players, 'player')} · ${formatDate(c.createdAt)}</div></div>
                <code class="share-code">${esc(c.code)}</code>
                <button class="btn btn-ghost btn-sm" data-action="copy-challenge-link" data-arg="${esc(c.code)}" title="Copy link">🔗</button>
                <button class="btn btn-ghost btn-sm" data-action="challenge-ranking" data-arg="${esc(c.code)}" title="See the ranking">🏆</button>
                <button class="btn btn-ghost btn-sm" data-action="play-challenge" data-arg="${esc(c.code)}" title="Play it">▶️</button>
                <button class="btn btn-ghost btn-sm" data-action="delete-challenge" data-arg="${esc(c.code)}" title="Delete">🗑️</button>
            </div>`).join('')}</div>` : '<p class="empty-text">You haven’t created a challenge yet.</p>');
    } catch (e) {
        card.innerHTML = header + `<p class="empty-text">${esc(e.message)}</p>`;
    }
}

actions['open-challenge-modal'] = async () => {
    if (!API.state.checked) await API.ping();
    const body = $('challenge-body');
    const footer = $('challenge-footer');
    footer.innerHTML = '<button class="btn btn-secondary" data-action="close-modal">Close</button>';
    if (!API.state.online) {
        body.innerHTML = '<p>Challenges need the backend, which isn’t connected.</p>';
    } else if (!API.isLoggedIn()) {
        body.innerHTML = '<p>Please <a href="#community" data-action="goto" data-arg="community">sign in</a> first.</p>';
    } else if (!appData.flashcards.length) {
        body.innerHTML = '<p>You need some flashcards to build a challenge.</p>';
    } else {
        const subjects = getSubjects().filter((s) => appData.flashcards.filter((c) => c.subject === s).length >= 4);
        if (!subjects.length) {
            body.innerHTML = '<p>A challenge needs at least 4 cards in one subject (so the wrong answers can come from the same deck).</p>';
            return openModal('challenge-modal');
        }
        body.innerHTML = `
            <div class="form-group"><label for="challenge-subject">Subject</label>
                <select id="challenge-subject" class="select-input">${subjects.map((s) => `<option value="${esc(s)}">${esc(s)} (${appData.flashcards.filter((c) => c.subject === s).length})</option>`).join('')}</select></div>
            <div class="form-group"><label for="challenge-count">Questions</label>
                <select id="challenge-count" class="select-input">${[5, 10, 15, 20].map((n) => `<option value="${n}"${n === 10 ? ' selected' : ''}>${n}</option>`).join('')}</select></div>
            <div class="form-group"><label for="challenge-title">Title</label>
                <input type="text" id="challenge-title" class="text-input" maxlength="80" placeholder="e.g. Who is the fastest at cells?"></div>
            <p class="modal-hint">20 seconds per question, wrong answers come from the same challenge, and your best score is the one that counts.</p>`;
        $('challenge-title').value = `${subjects[0]} challenge`;
        footer.innerHTML = '<button class="btn btn-secondary" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="create-challenge">Create challenge</button>';
    }
    openModal('challenge-modal');
};

actions['create-challenge'] = async () => {
    const subject = $('challenge-subject').value;
    const count = parseInt($('challenge-count').value, 10) || 10;
    const title = $('challenge-title').value.trim() || `${subject} challenge`;
    const cards = Core.shuffle(appData.flashcards.filter((c) => c.subject === subject))
        .slice(0, Math.min(count, 50))
        .map((c) => ({ front: c.front, back: c.back, subject: c.subject }));
    if (cards.length < 3) return showToast('That subject needs at least 3 cards.', 'error');
    try {
        const r = await API.createChallenge(title, cards);
        const link = challengeLink(r.code);
        $('challenge-body').innerHTML = `
            <p><strong>${esc(r.title)}</strong> is live with ${plural(r.cardCount, 'question')}! Send this code:</p>
            <div class="share-code-big">${esc(r.code)}</div>
            <p class="modal-hint">or the link <code class="challenge-link">${esc(link)}</code></p>`;
        $('challenge-footer').innerHTML = `
            <button class="btn btn-secondary" data-action="close-modal">Done</button>
            <button class="btn btn-secondary" data-action="copy-challenge-link" data-arg="${esc(r.code)}">🔗 Copy link</button>
            <button class="btn btn-primary" data-action="copy-code" data-arg="${esc(r.code)}">📋 Copy code</button>`;
        renderChallengesCard();
    } catch (e) { showToast(e.message, 'error'); }
};

actions['play-challenge'] = async (code) => {
    try {
        const challenge = await API.getChallenge(code);
        closeModals();
        startChallengeQuiz(challenge);
    } catch (e) { showToast(e.message, 'error'); }
};

actions['challenge-ranking'] = async (code) => {
    try {
        const c = await API.getChallenge(code);
        const me = API.state.user && API.state.user.username;
        infoModal({
            title: `🏆 ${c.title}`,
            wide: true,
            body: `<p class="modal-hint">by ${esc(c.author)} · ${plural(c.cards.length, 'question')} · code <code>${esc(c.code)}</code></p>
                ${c.results.length ? challengeBoardHtml(c.results, me, c.cards.length) : '<p class="empty-text">Nobody has played it yet.</p>'}`,
            footer: `<button class="btn btn-secondary" data-action="close-modal">Close</button>
                <button class="btn btn-primary" data-action="play-challenge" data-arg="${esc(c.code)}">▶️ Play it</button>`,
        });
    } catch (e) { showToast(e.message, 'error'); }
};

actions['delete-challenge'] = async (code) => {
    if (!confirm('Delete this challenge? The code stops working and the scores go with it.')) return;
    try { await API.deleteChallenge(code); showToast('Challenge deleted.', 'info'); renderChallengesCard(); }
    catch (e) { showToast(e.message, 'error'); }
};

// ==================== CODE LOOKUP (share, then challenge) ====================
actions['open-code-modal'] = async () => {
    pendingShare = null;
    pendingChallenge = null;
    $('code-input').value = '';
    $('code-preview').innerHTML = '';
    const btn = $('code-btn');
    btn.textContent = 'Find it';
    btn.dataset.action = 'lookup-code';
    openModal('code-modal');
    if (!API.state.checked) await API.ping();
    if (!API.state.online) $('code-preview').innerHTML = '<p class="quiz-requirement">The backend isn’t connected, so codes can’t be looked up right now.</p>';
};

actions['lookup-code'] = async () => {
    const code = $('code-input').value.trim().toUpperCase();
    if (code.length !== 8) return showToast('Codes are 8 characters long.', 'error');
    const btn = $('code-btn');
    try {
        const share = await API.getShare(code);
        pendingShare = share;
        pendingChallenge = null;
        $('code-preview').innerHTML = `<div class="share-preview"><strong>${esc(share.title)}</strong>
            <div class="dash-sub">by ${esc(share.author)} · ${plural(share.cards.length, 'card')}</div>
            <div class="preview-list preview-short">${share.cards.slice(0, 5).map((c) => `<div class="preview-row"><div class="preview-q">${esc(c.front)}</div><div class="preview-a">${esc(c.back)}</div></div>`).join('')}</div></div>`;
        btn.textContent = `Add ${share.cards.length} cards`;
        btn.dataset.action = 'import-code';
    } catch (e) {
        if (e.status !== 404) return showToast(e.message, 'error');
        // Not a deck – maybe it is a friend challenge.
        try {
            const challenge = await API.getChallenge(code);
            pendingChallenge = challenge;
            pendingShare = null;
            $('code-preview').innerHTML = `<div class="share-preview"><strong>⚔️ ${esc(challenge.title)}</strong>
                <div class="dash-sub">by ${esc(challenge.author)} · ${plural(challenge.cards.length, 'question')} · 20s each</div>
                ${challenge.results.length ? challengeBoardHtml(challenge.results, API.state.user && API.state.user.username, challenge.cards.length) : '<p class="empty-text">No scores yet – be the first.</p>'}</div>`;
            btn.textContent = 'Take the challenge';
            btn.dataset.action = 'start-pending-challenge';
        } catch (e2) {
            pendingChallenge = null;
            showToast(e2.status === 404 ? 'Nothing found with that code.' : e2.message, 'error');
        }
    }
};

actions['start-pending-challenge'] = () => {
    if (!pendingChallenge) return;
    const challenge = pendingChallenge;
    pendingChallenge = null;
    closeModals();
    startChallengeQuiz(challenge);
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
        if (btn.dataset.action !== 'lookup-code') {
            btn.dataset.action = 'lookup-code';
            btn.textContent = 'Find it';
            $('code-preview').innerHTML = '';
            pendingShare = null;
            pendingChallenge = null;
        }
    }
    if (e.target.id === 'recover-code') {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '');
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.id === 'code-input') { e.preventDefault(); $('code-btn').click(); }
});

// ==================== DEEP LINKS ====================
/**
 * `#community?verify=TOKEN`, `#community?reset=TOKEN` and
 * `#community?challenge=CODE` arrive from emails and shared links. The token is
 * stripped from the address bar straight away so it cannot be bookmarked or
 * leaked through the history.
 */
function handleCommunityDeepLink() {
    const params = hashParams();
    if (![...params.keys()].length) return false;
    const verify = params.get('verify');
    const reset = params.get('reset');
    const challenge = params.get('challenge');
    clearHashParams('community');
    if (verify) { verifyEmailFromLink(verify); return true; }
    if (reset) { openResetDialog(reset); return true; }
    if (challenge) { openChallengeFromLink(challenge.toUpperCase()); return true; }
    return false;
}

async function verifyEmailFromLink(token) {
    try {
        const r = await API.verifyEmail(token);
        showToast(`Email verified: ${r.email} ✅`, 'success');
        if (API.isLoggedIn()) { try { await API.me(); } catch { /* session gone */ } }
    } catch (e) {
        showToast(`That verification link did not work: ${e.message}`, 'error');
    }
    renderAccountCard();
}

async function openChallengeFromLink(code) {
    if (!API.state.checked) await API.ping();
    if (!API.state.online) return showToast('The backend is not connected, so the challenge cannot be loaded.', 'error');
    try {
        const challenge = await API.getChallenge(code);
        infoModal({
            title: `⚔️ ${challenge.title}`,
            body: `<p class="modal-hint">A challenge from <strong>${esc(challenge.author)}</strong>: ${plural(challenge.cards.length, 'question')}, 20 seconds each. No XP – just the board.</p>
                ${challenge.results.length ? challengeBoardHtml(challenge.results, API.state.user && API.state.user.username, challenge.cards.length) : '<p class="empty-text">No scores yet.</p>'}`,
            footer: `<button class="btn btn-secondary" data-action="close-modal">Not now</button>
                <button class="btn btn-primary" data-action="play-challenge" data-arg="${esc(challenge.code)}">▶️ Take the challenge</button>`,
        });
    } catch (e) {
        showToast(e.status === 404 ? 'That challenge code does not exist (any more).' : e.message, 'error');
    }
}
