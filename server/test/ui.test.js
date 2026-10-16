'use strict';
/**
 * End-to-end smoke tests of the browser app (served by the real backend) in jsdom.
 * jsdom is intentionally NOT a dependency of the project, so these tests are
 * skipped unless it is installed:   npm i --no-save jsdom@26 && npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const Core = require('../../js/core');

let JSDOM, ResourceLoader, VirtualConsole;
try {
    ({ JSDOM, ResourceLoader, VirtualConsole } = require('jsdom'));
} catch {
    test('browser UI tests (skipped: jsdom not installed)', { skip: true }, () => {});
}

if (JSDOM) {
    class LocalOnly extends ResourceLoader {
        fetch(url, opts) {
            return url.startsWith('http://127.0.0.1') ? super.fetch(url, opts) : Promise.resolve(Buffer.from(''));
        }
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function boot() {
        const app = createApp({ dbPath: ':memory:', silentMail: true, publicUrl: 'http://127.0.0.1' });
        const { server } = app;
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const errors = [];
        const virtualConsole = new VirtualConsole();
        virtualConsole.on('jsdomError', (e) => errors.push(e.message));
        virtualConsole.on('error', (...a) => errors.push(a.join(' ')));
        const dom = await JSDOM.fromURL(`http://127.0.0.1:${server.address().port}/`, {
            runScripts: 'dangerously',
            resources: new LocalOnly(),
            pretendToBeVisual: true,
            virtualConsole,
            beforeParse(window) {
                window.fetch = (url, opts) => fetch(new URL(url, window.location.href), opts);
                window.scrollTo = () => {};
                window.confirm = () => true;
                window.prompt = () => 'correct horse';
            },
        });
        const { window } = dom;
        const { document } = window;
        const $ = (sel) => document.querySelector(sel);
        const api = {
            window, document, errors, $, app, server,
            get: (expr) => window.eval(expr),
            click: (sel) => { const el = typeof sel === 'string' ? $(sel) : sel; assert.ok(el, `missing ${sel}`); el.click(); },
            act: (name, arg) => { const el = $(`[data-action="${name}"]${arg !== undefined ? `[data-arg="${arg}"]` : ''}`); assert.ok(el, `missing action ${name}`); el.click(); },
            go: async (page) => { window.eval(`showPage('${page}')`); await sleep(60); },
            until: async (fn, label = 'condition') => {
                for (let i = 0; i < 150; i++) { if (fn()) return; await sleep(30); }
                assert.fail(`timed out waiting for ${label}`);
            },
            type: (sel, value) => { const el = $(sel); assert.ok(el, `missing ${sel}`); el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); },
            key: (k) => { document.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true })); },
            lastMail: () => app.mailer.last(),
            close: async () => { window.close(); await new Promise((r) => server.close(r)); app.db.close(); },
        };
        try {
            if (document.readyState !== 'complete') await new Promise((r) => window.addEventListener('load', r));
            await api.until(() => api.get('API.state.checked'), 'backend ping');
        } catch (e) {
            await api.close();
            throw e;
        }
        return api;
    }

    /** Installs decks and gives some of the cards a review history. */
    async function seedCards(ui, decks = ['bio-cells', 'chem-atoms']) {
        await ui.go('library');
        await ui.until(() => ui.document.querySelectorAll('#library-grid .deck-card').length > 0, 'library');
        for (const id of decks) ui.act('add-deck', id);
        await ui.until(() => ui.get('appData.installedDecks.length') === decks.length, 'decks installed');
        ui.window.eval(`
            const now = Date.now();
            appData.flashcards.forEach((c, i) => {
                if (i % 3 === 2) return;                       // leave a third unseen
                Object.assign(c, Core.schedule(c, 3, now - (5 + i % 9) * Core.DAY));
            });
            appData.flashcards[0].lapses = 2;                    // a weak spot
            appData.flashcards[1].ease = 1.9;
            commit();
        `);
        assert.ok(ui.get('appData.flashcards.length') >= 20 * decks.length, 'cards installed');
    }

    test('browser app: library → study → quiz → games → notes → timer → stats', async () => {
        const ui = await boot();
        try {
            assert.equal(ui.get('API.state.online'), true);
            // Home
            await ui.until(() => ui.document.querySelectorAll('#home-decks .deck-card').length === 6, 'featured decks');
            assert.ok(ui.$('#dashboard').textContent.includes('Daily goal'));
            assert.ok(ui.$('#dashboard').textContent.includes('streak freeze'), 'the streak card mentions freezes');

            // Library
            await ui.go('library');
            await ui.until(() => ui.document.querySelectorAll('#library-grid .deck-card').length >= 25, 'library decks');
            ui.type('#library-search', 'mitochondria');
            assert.ok(ui.document.querySelectorAll('#library-grid .deck-card').length >= 1);
            ui.type('#library-search', '');
            ui.act('preview-deck', 'bio-cells');
            await ui.until(() => ui.$('#deck-modal').classList.contains('active'), 'preview modal');
            assert.ok(ui.$('#deck-modal-body').textContent.includes('nucleus'));
            ui.act('add-deck', 'bio-cells');
            await ui.until(() => ui.get('appData.flashcards.length') >= 20, 'deck installed');
            ui.click('#deck-modal [data-action="close-modal"]');
            for (const id of ['bio-human', 'chem-atoms', 'phys-energy']) ui.act('add-deck', id);
            await ui.until(() => ui.get('appData.installedDecks.length') === 4, 'four decks');
            const total = ui.get('appData.flashcards.length');
            ui.act('add-deck', 'chem-atoms') ; // already full -> renders "Study" instead, so click is a no-op
            assert.equal(ui.get('appData.flashcards.length'), total);

            // Flashcards + study
            await ui.go('flashcards');
            assert.ok(ui.document.querySelectorAll('#flashcard-grid .card-item').length > 0);
            ui.type('#card-search', 'nucleus');
            assert.ok(ui.document.querySelectorAll('#flashcard-grid .card-item').length >= 1);
            ui.type('#card-search', '');
            ui.click('#study-due-btn');
            assert.equal(ui.$('#flashcard-study-area').hidden, false);
            ui.click('#flashcard-study-area [data-action="flip"].btn');
            assert.equal(ui.$('#study-rate-row').hidden, false);
            const before = ui.get('appData.totalReviews');
            ui.act('rate', 3);
            assert.equal(ui.get('appData.totalReviews'), before + 1);
            assert.ok(ui.get('appData.xp') >= 10);
            ui.act('flip'); ui.act('rate', 1); // "Again" re-queues the card
            assert.ok(ui.get('study.queue.length') >= 1);
            ui.click('[data-action="exit-study"]');

            // Create / edit / delete a card
            ui.act('new-card');
            ui.$('#card-subject').value = 'Test';
            ui.$('#card-front').value = '2 + 2?';
            ui.$('#card-back').value = '4';
            ui.act('save-card');
            assert.ok(ui.get('appData.flashcards.some(c => c.front === "2 + 2?")'));
            const id = ui.get('appData.flashcards.find(c => c.front === "2 + 2?").id');
            ui.act('delete-card', id);
            assert.ok(!ui.get('appData.flashcards.some(c => c.id === ' + JSON.stringify(id) + ')'));
            assert.ok(ui.get(`appData.deleted[${JSON.stringify(id)}] > 0`), 'tombstone recorded');

            // Bulk add
            ui.act('open-bulk-modal');
            ui.$('#bulk-text').value = 'Q1 :: A1\nQ2 :: A2\nnot a card';
            ui.$('#bulk-subject').value = 'Bulk';
            ui.act('save-bulk');
            assert.equal(ui.get('appData.flashcards.filter(c => c.subject === "Bulk").length'), 2);

            // Quiz – multiple choice
            await ui.go('quiz');
            ui.$('#quiz-count').value = '5';
            ui.$('#quiz-time').value = '0';
            ui.click('#start-quiz-btn');
            assert.equal(ui.$('#quiz-active').hidden, false);
            for (let i = 0; i < 5; i++) {
                const q = ui.get('quizState.questions[quizState.index].back');
                const opts = [...ui.document.querySelectorAll('#quiz-options .quiz-option')];
                assert.ok(opts.length === 4, 'four options');
                assert.equal(new Set(opts.map((o) => o.dataset.value)).size, 4, 'unique options');
                opts.find((o) => o.dataset.value === q).click();
                ui.act('quiz-next');
            }
            assert.equal(ui.$('#quiz-results').hidden, false);
            assert.equal(ui.$('#results-percentage').textContent, '100%');
            assert.equal(ui.get('appData.quizHistory.length'), 1);

            // Quiz – typed
            ui.act('reset-quiz');
            ui.$('#quiz-mode').value = 'typed';
            ui.$('#quiz-count').value = '5';
            ui.click('#start-quiz-btn');
            ui.$('#quiz-typed-input').value = 'definitely wrong answer';
            ui.$('#quiz-typed').dispatchEvent(new ui.window.Event('submit', { cancelable: true, bubbles: true }));
            assert.ok(ui.$('#quiz-feedback').textContent.includes('Not quite'));
            ui.act('reset-quiz');

            // Games
            await ui.go('games');
            ui.click('[data-action="start-match"]');
            assert.equal(ui.$('#match-area').hidden, false);
            assert.equal(ui.document.querySelectorAll('.match-tile').length, 12);
            // solve it by peeking at the model
            const pairs = ui.get('game.tiles.map(t => t.pair)');
            const tiles = [...ui.document.querySelectorAll('.match-tile')];
            for (const pair of new Set(pairs)) {
                const idx = pairs.map((p, i) => (p === pair ? i : -1)).filter((i) => i >= 0);
                tiles[idx[0]].click(); tiles[idx[1]].click();
            }
            assert.equal(ui.get('appData.matchWins'), 1);
            await ui.until(() => !ui.$('#game-over').hidden, 'match game over');
            ui.act('exit-game');
            ui.click('[data-action="start-speed"]');
            assert.equal(ui.$('#speed-area').hidden, false);
            const before2 = ui.get('game.answered');
            ui.act('speed-answer', 'true');
            assert.equal(ui.get('game.answered'), before2 + 1);
            await ui.go('home'); // leaving stops the timer
            assert.equal(ui.get('game'), null);

            // Notes
            await ui.go('notes');
            ui.act('new-note');
            ui.type('#note-title-input', 'Cells');
            ui.type('#note-content', '# Cells\n**Bold** and <script>alert(1)</script>\nWhat is the nucleus? :: The control centre');
            ui.act('toggle-note-preview');
            assert.ok(ui.$('#note-preview').innerHTML.includes('<h1>Cells</h1>'));
            assert.ok(!ui.$('#note-preview').innerHTML.includes('<script>'), 'markdown must escape HTML');
            ui.act('note-to-cards');
            assert.ok(ui.get('appData.flashcards.some(c => c.front === "What is the nucleus?")'));

            // Timer
            await ui.go('pomodoro');
            ui.act('pomo-toggle');
            assert.equal(ui.get('pomo.running'), true);
            ui.act('pomo-toggle');
            assert.equal(ui.get('pomo.running'), false);
            ui.act('pomo-mode', 'short');
            assert.equal(ui.$('#pomo-time').textContent, '05:00');

            // Stats
            await ui.go('stats');
            assert.ok(Number(ui.$('#stat-cards').textContent) > 50);
            assert.ok(ui.document.querySelectorAll('#achievements .achievement.unlocked').length >= 3);
            assert.ok(ui.document.querySelectorAll('#heatmap .heatmap-cell').length >= 84);

            // Theme
            ui.click('#theme-toggle');
            assert.equal(ui.document.documentElement.getAttribute('data-theme'), 'dark');

            assert.deepEqual(ui.errors, [], 'no script errors in the console');
        } finally { await ui.close(); }
    });

    test('browser app: account, cloud sync, leaderboard and share codes', async () => {
        const ui = await boot();
        try {
            await ui.go('library');
            await ui.until(() => ui.document.querySelectorAll('#library-grid .deck-card').length > 0, 'library');
            ui.act('add-deck', 'math-trig');
            await ui.go('community');
            await ui.until(() => ui.$('#auth-form'), 'login form');
            assert.ok(ui.document.querySelector('label[for="auth-username"]').textContent.includes('verified email'),
                'the sign-in label mentions a verified email');
            ui.$('#auth-username').value = 'student1';
            ui.$('#auth-password').value = 'a good password';
            ui.act('register');
            await ui.until(() => ui.get('API.isLoggedIn()'), 'registered');
            await ui.until(() => ui.$('#recovery-code'), 'the recovery code dialog');
            ui.act('recovery-saved');
            await ui.until(() => ui.get('Sync.lastSynced') > 0, 'first sync');
            const token = ui.get('API.state.token');
            const res = await fetch(`${ui.window.location.origin}/api/sync`, { headers: { Authorization: `Bearer ${token}` } });
            const body = await res.json();
            assert.ok(body.data.flashcards.length >= 15, 'cards were uploaded');

            // leaderboard lists me once I have xp
            ui.window.eval('award(500); commit();');
            await ui.get('Sync.now({quiet:true})');
            await ui.until(() => ui.$('#leaderboard').textContent.includes('student1'), 'leaderboard');

            // share + import by code
            await ui.get('actions["open-share-modal"]()');
            await ui.until(() => ui.$('#share-title'), 'share form');
            ui.$('#share-title').value = 'Trig deck';
            ui.act('create-share');
            await ui.until(() => ui.$('#share-modal .share-code-big'), 'share code');
            const code = ui.$('#share-modal .share-code-big').textContent.trim();
            assert.match(code, /^[A-Z2-9]{8}$/);

            ui.window.eval('closeModals()');
            ui.act('open-code-modal');
            ui.$('#code-input').value = code;
            ui.$('#code-input').dispatchEvent(new ui.window.Event('input', { bubbles: true }));
            ui.click('#code-btn');
            await ui.until(() => ui.$('#code-btn').dataset.action === 'import-code', 'share lookup');
            ui.click('#code-btn');
            assert.ok(ui.$('#toast-container').textContent.includes('already have'), 'duplicate import is a no-op');

            ui.act('logout');
            await ui.until(() => !ui.get('API.isLoggedIn()'), 'logged out');
            assert.deepEqual(ui.errors, []);
        } finally { await ui.close(); }
    });

    test('plan page: readiness ring, exam dates, forecast and weak-spot rescue', async () => {
        const ui = await boot();
        try {
            await seedCards(ui);
            await ui.go('plan');
            assert.equal(ui.get('currentPage'), 'plan');
            assert.match(ui.$('#plan-overall .plan-ring-value').textContent, /^\d{1,3}%$/);
            assert.ok(ui.$('#plan-overall .plan-ring-fill').getAttribute('style').includes('stroke-dashoffset'));
            assert.ok(ui.$('#plan-freeze').textContent.includes('Streak freezes'));
            assert.ok(ui.document.querySelectorAll('#plan-subjects .plan-subject').length >= 2, 'one card per subject');
            assert.equal(ui.document.querySelectorAll('#plan-forecast .forecast-col').length, 14);
            assert.ok(ui.$('#plan-forecast .forecast-note').textContent.includes('reviews scheduled'));

            // no exam date yet
            assert.ok(ui.$('#plan-subjects').textContent.includes('No exam date'));
            assert.equal(ui.$('#plan-subjects .plan-bar-marker'), null);

            // set an exam date for Biology
            const examDay = new Date();
            examDay.setDate(examDay.getDate() + 24);
            const key = Core.dateKey(examDay);
            ui.type('#exam-biology', key);
            assert.equal(ui.get('appData.exams.Biology'), key, 'the exam date is stored');
            await ui.until(() => ui.$('#plan-subjects .plan-bar-marker'), 'exam marker');
            const card = ui.document.querySelectorAll('#plan-subjects .plan-subject')[0];
            assert.ok(card.textContent.includes('in 24d'), `countdown shown: ${card.textContent.slice(0, 200)}`);
            assert.ok(card.textContent.includes('on the day'), 'the projection is explained');
            assert.ok(card.textContent.includes('new/day'), 'and how many new cards a day');
            assert.ok(/On track|Getting there|Needs work|At risk/.test(card.textContent), 'a status chip');

            // the home banner picks it up
            await ui.go('home');
            await ui.until(() => ui.$('#exam-banner .exam-banner'), 'exam banner');
            assert.ok(ui.$('#exam-banner').textContent.includes('Biology'));
            assert.ok(ui.$('#exam-banner').textContent.includes('24'));

            // clearing the date sticks (and syncs that way)
            await ui.go('plan');
            ui.act('clear-exam', 'Biology');
            assert.equal(ui.get('appData.exams.Biology'), undefined);
            assert.equal(ui.$('#plan-subjects .plan-bar-marker'), null);

            // weak spots + rescue session
            ui.type('#exam-chemistry', key);
            assert.ok(ui.document.querySelectorAll('#plan-weak .weak-item').length >= 1, 'weak spots listed');
            const weakIds = ui.get('Core.weakCards(appData.flashcards, 20).map(c => c.id)');
            ui.act('rescue-weak');
            await ui.until(() => ui.get('study !== null'), 'rescue session started');
            assert.equal(ui.get('currentPage'), 'flashcards');
            assert.deepEqual(JSON.parse(ui.get('JSON.stringify(study.queue)')).sort(), [...weakIds].sort());
            assert.ok(ui.get('study.label').includes('Rescue'));
            ui.act('exit-study');

            // boost readiness takes the cards closest to being forgotten
            await ui.go('plan');
            ui.act('boost-readiness');
            await ui.until(() => ui.get('study !== null'), 'boost session started');
            assert.ok(ui.get('study.queue.length') <= 30);
            assert.ok(ui.get('study.label').includes('Boost'));
            ui.act('exit-study');

            // boost a single subject
            await ui.go('plan');
            ui.act('boost-subject', 'Chemistry');
            await ui.until(() => ui.get('study !== null'), 'subject boost started');
            assert.ok(ui.get('study.label').includes('Chemistry'));
            ui.act('exit-study');

            assert.deepEqual(ui.errors, []);
        } finally { await ui.close(); }
    });

    test('study mode: progressive hints lock Easy, and new cards are capped at 20', async () => {
        const ui = await boot();
        try {
            // 25 brand-new cards, all due
            ui.window.eval(`
                const now = Date.now();
                for (let i = 0; i < 25; i++) {
                    appData.flashcards.push({ ...Core.newSrs(), id: 'new' + i, subject: 'CapTest',
                        front: 'Question ' + i + '?', back: 'Answer ' + i, starred: false, createdAt: now, updatedAt: now });
                }
                commit();
            `);
            await ui.go('flashcards');
            ui.type('#flashcard-subject-filter', 'CapTest');
            assert.equal(ui.get('dueCards("CapTest").length'), 25);
            ui.click('#study-due-btn');
            await ui.until(() => ui.get('study !== null'), 'study session');
            assert.equal(ui.get('study.queue.length'), 20, 'at most 20 new cards per session');
            assert.ok(ui.$('#toast-container').textContent.includes('held back'), 'and the student is told');
            assert.ok(ui.$('#toast-container').textContent.includes('5'));

            // hints
            assert.equal(ui.$('#study-hint').hidden, true);
            assert.equal(ui.$('#rate-easy').disabled, false);
            ui.key('h');
            assert.equal(ui.$('#study-hint').hidden, false);
            assert.equal(ui.get('study.hint'), 1);
            const answer = ui.get('studyAnswer(currentStudyCard())');
            assert.equal(ui.$('#study-hint').textContent.trim(), `💡 ${Core.hint(answer, 1)}`);
            assert.equal(ui.$('#rate-easy').disabled, true, 'Easy is disabled after a hint');
            ui.key('h');
            assert.equal(ui.get('study.hint'), 2);
            assert.equal(ui.$('#study-hint').textContent.trim(), `💡 ${Core.hint(answer, 2)}`);
            ui.key('h');
            assert.equal(ui.get('study.hint'), 2, 'two levels only');
            assert.equal(ui.$('#study-hint-btn').disabled, true);

            // rating Easy through the keyboard is downgraded to Good
            const cardId = ui.get('currentStudyCard().id');
            ui.key(' '); // flip
            assert.equal(ui.$('#study-rate-row').hidden, false);
            ui.key('4');
            const rated = ui.get(`appData.flashcards.find(c => c.id === ${JSON.stringify(cardId)})`);
            assert.equal(rated.interval, 1, 'Good interval for a first review, not the Easy interval of 4');
            assert.equal(ui.get('study.hinted'), 1);

            // the next card starts clean
            ui.key(' ');
            assert.equal(ui.get('study.hint'), 0);
            assert.equal(ui.$('#study-hint').hidden, true);
            assert.equal(ui.$('#rate-easy').disabled, false);
            const nextId = ui.get('currentStudyCard().id');
            ui.key('4');
            assert.equal(ui.get(`appData.flashcards.find(c => c.id === ${JSON.stringify(nextId)}).interval`), 4, 'Easy still works unhinted');

            // the Hint button does the same job as the key
            ui.key(' ');
            ui.click('#study-flip-row [data-action="study-hint"]');
            assert.equal(ui.get('study.hint'), 1);
            ui.act('exit-study');
            assert.deepEqual(ui.errors, []);
        } finally { await ui.close(); }
    });

    test('accounts: optional email, recovery dialog, verify deep link, email login', async () => {
        const ui = await boot();
        try {
            await ui.go('community');
            await ui.until(() => ui.$('#auth-form'), 'sign-in form');

            // the optional email box is collapsed by default
            const box = ui.$('#auth-email-box');
            assert.ok(box, 'there is an optional email box');
            assert.equal(box.open, false);
            assert.ok(ui.$('#auth-email'), 'with an #auth-email input');
            assert.ok(ui.$('[data-action="forgot-dialog"]'), 'a forgotten-password dialog');
            assert.ok(ui.$('[data-action="recover-dialog"]'), 'and a recovery-code dialog');

            box.open = true;
            ui.$('#auth-username').value = 'student2';
            ui.$('#auth-password').value = 'a good password';
            ui.type('#auth-email', 'student2@example.com');
            ui.act('register');

            // recovery code dialog
            await ui.until(() => ui.$('#recovery-code'), 'recovery dialog');
            const code = ui.$('#recovery-code').textContent.trim();
            assert.match(code, /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
            assert.ok(ui.$('[data-action="copy-recovery"]'), 'copy');
            assert.ok(ui.$('[data-action="download-recovery"]'), 'download');
            ui.act('download-recovery'); // jsdom has no createObjectURL – must not explode
            ui.act('recovery-saved');
            await ui.until(() => !ui.$('#info-modal').classList.contains('active'), 'dialog closed');
            assert.equal(ui.get('API.isLoggedIn()'), true);

            // the account panel shows an unverified address
            await ui.until(() => ui.$('#account-email'), 'account panel');
            assert.ok(ui.$('#account-email').textContent.includes('not verified'));
            assert.ok(ui.$('[data-action="change-password-dialog"]'));
            assert.ok(ui.$('[data-action="devices-dialog"]'));
            assert.ok(ui.$('[data-action="replace-recovery-dialog"]'));
            assert.ok(ui.$('[data-action="delete-account"]'));

            // devices list
            ui.act('devices-dialog');
            await ui.until(() => ui.$('.device-item'), 'devices');
            assert.ok(ui.$('.device-item').textContent.includes('this device'));
            ui.window.eval('closeModals()');

            // verify through the emailed deep link
            const mail = ui.lastMail();
            assert.ok(mail && mail.to === 'student2@example.com');
            const token = /#community\?verify=([A-Za-z0-9_-]+)/.exec(mail.text)[1];
            ui.window.location.hash = `#community?verify=${token}`;
            await ui.until(() => ui.get('API.state.user.emailVerified === true'), 'email verified');
            assert.ok(ui.$('#toast-container').textContent.includes('verified'));
            assert.ok(!ui.window.location.hash.includes(token), 'the token is stripped from the address bar');
            assert.equal(ui.window.location.hash, '#community');
            await ui.until(() => ui.$('#account-email').textContent.includes('is verified'), 'panel updated');

            // devices: sign one out
            ui.act('devices-dialog');
            await ui.until(() => ui.$('.device-item'), 'devices again');
            assert.ok(ui.$('[data-action="revoke-others"]'));
            ui.window.eval('closeModals()');

            // sign out, then back in with the verified email
            ui.act('logout');
            await ui.until(() => !ui.get('API.isLoggedIn()'), 'logged out');
            await ui.until(() => ui.$('#auth-form'), 'sign-in form again');
            ui.$('#auth-username').value = 'student2@example.com';
            ui.$('#auth-password').value = 'a good password';
            ui.$('#auth-form').dispatchEvent(new ui.window.Event('submit', { cancelable: true, bubbles: true }));
            await ui.until(() => ui.get('API.isLoggedIn()'), 'signed in with an email');
            assert.equal(ui.get('API.state.user.username'), 'student2');
            assert.ok(ui.$('#toast-container').textContent.includes('Welcome back'));

            // change password from the panel
            ui.act('change-password-dialog');
            await ui.until(() => ui.$('#cp-old'), 'change password dialog');
            ui.$('#cp-old').value = 'a good password';
            ui.$('#cp-new').value = 'an even better password';
            ui.$('#cp-new2').value = 'an even better password';
            ui.act('do-change-password');
            await ui.until(() => !ui.$('#info-modal').classList.contains('active'), 'password changed');
            assert.ok(ui.$('#toast-container').textContent.includes('Password changed'));

            assert.deepEqual(ui.errors, []);
        } finally { await ui.close(); }
    });

    test('friend challenges: create, share the code, play and land on the board', async () => {
        const ui = await boot();
        try {
            await seedCards(ui, ['bio-cells']);
            await ui.go('community');
            await ui.until(() => ui.$('#auth-form'), 'sign-in form');
            ui.$('#auth-username').value = 'challenger';
            ui.$('#auth-password').value = 'a good password';
            ui.act('register');
            await ui.until(() => ui.get('API.isLoggedIn()'), 'registered');
            await ui.until(() => ui.$('#recovery-code'), 'the recovery code dialog');
            ui.act('recovery-saved');
            await ui.until(() => ui.$('#challenge-card').textContent.includes('Friend challenges'), 'challenge card');

            const xpBefore = ui.get('appData.xp');
            const quizzesBefore = ui.get('appData.quizHistory.length');

            // create
            await ui.get('actions["open-challenge-modal"]()');
            await ui.until(() => ui.$('#challenge-count'), 'challenge form');
            assert.deepEqual([...ui.$('#challenge-count').options].map((o) => o.value), ['5', '10', '15', '20']);
            ui.$('#challenge-count').value = '5';
            ui.$('#challenge-title').value = 'Cells at speed';
            ui.act('create-challenge');
            await ui.until(() => ui.$('#challenge-modal .share-code-big'), 'challenge code');
            const code = ui.$('#challenge-modal .share-code-big').textContent.trim();
            assert.match(code, /^[A-Z2-9]{8}$/);
            assert.ok(ui.$('[data-action="copy-challenge-link"]'), 'a copyable link');
            ui.window.eval('closeModals()');

            await ui.until(() => ui.$('#challenge-card').textContent.includes(code), 'listed on the card');

            // enter the code: a share lookup misses, a challenge lookup hits
            ui.act('open-code-modal');
            ui.type('#code-input', code);
            ui.click('#code-btn');
            await ui.until(() => ui.$('#code-btn').dataset.action === 'start-pending-challenge', 'challenge found');
            assert.ok(ui.$('#code-preview').textContent.includes('Cells at speed'));
            ui.click('#code-btn');
            await ui.until(() => ui.get('quizState && quizState.challenge'), 'challenge quiz running');

            assert.equal(ui.get('currentPage'), 'quiz');
            assert.equal(ui.$('#quiz-challenge-banner').hidden, false);
            assert.ok(ui.$('#quiz-challenge-banner').textContent.includes('challenger'));
            assert.equal(ui.get('quizState.mode'), 'choice');
            assert.equal(ui.get('quizState.timePerQ'), 20, '20 seconds a question');
            assert.equal(ui.get('quizState.questions.length'), 5);
            assert.ok(ui.get('quizState.questions.every(c => /^ch\\d+$/.test(c.id))'), 'challenge cards get their own ids');

            // answer all five correctly, taking a realistic amount of time
            for (let i = 0; i < 5; i++) {
                await sleep(340);
                const back = ui.get('quizState.questions[quizState.index].back');
                const opts = [...ui.document.querySelectorAll('#quiz-options .quiz-option')];
                assert.equal(opts.length, 4, 'options come from the challenge itself');
                opts.find((o) => o.dataset.value === back).click();
                ui.act('quiz-next');
            }
            assert.equal(ui.$('#quiz-results').hidden, false);
            assert.equal(ui.$('#results-percentage').textContent, '100%');

            await ui.until(() => ui.$('#results-review .lb-table'), 'the ranking is shown');
            assert.ok(ui.$('#results-review').textContent.includes('challenger'));
            assert.ok(ui.$('#results-review').textContent.includes('Leaderboard'));
            assert.ok(ui.$('#results-xp').textContent.includes('#1'));

            // no XP, no quiz history – but the streak still counts it
            assert.equal(ui.get('appData.xp'), xpBefore, 'challenges award no XP');
            assert.equal(ui.get('appData.quizHistory.length'), quizzesBefore, 'and write no quiz history');
            assert.ok(ui.get(`appData.activityLog[Core.dateKey()] > 0`), 'the streak still sees the activity');
            assert.equal(ui.get('Core.streakAlive(appData)'), true);

            // the result really reached the server
            const res = await fetch(`${ui.window.location.origin}/api/challenges/${code}`);
            const board = await res.json();
            assert.equal(board.results.length, 1);
            assert.equal(board.results[0].username, 'challenger');
            assert.equal(board.results[0].score, 5);

            // deep link into a challenge
            ui.window.eval('resetQuiz()');
            ui.window.location.hash = `#community?challenge=${code}`;
            await ui.until(() => ui.$('#info-modal').classList.contains('active'), 'challenge deep link');
            assert.ok(ui.$('#info-modal-title').textContent.includes('Cells at speed'));
            assert.ok(ui.$('#info-modal-body').textContent.includes('challenger'), 'the author and the board are shown');
            assert.ok(!ui.window.location.hash.includes(code), 'the code is stripped from the URL');
            ui.act('play-challenge', code);
            await ui.until(() => ui.get('quizState && quizState.challenge'), 'playing again from the deep link');
            assert.equal(ui.get('quizState.questions.length'), 5);

            // delete it
            ui.window.eval('resetQuiz(); showPage("community");');
            await ui.until(() => ui.$('#challenge-card').textContent.includes(code), 'back on the card');
            ui.act('delete-challenge', code);
            await ui.until(() => !ui.$('#challenge-card').textContent.includes(code), 'challenge deleted');
            assert.deepEqual(ui.errors, []);
        } finally { await ui.close(); }
    });

    test('the plan page and account panel work with no backend data at all', async () => {
        const ui = await boot();
        try {
            await ui.go('plan');
            assert.ok(ui.$('#plan-overall').textContent.includes('No cards yet'));
            assert.ok(ui.$('#plan-freeze').textContent.includes('Streak freezes'));
            await ui.go('community');
            await ui.until(() => ui.$('#auth-form'), 'sign-in form');
            assert.ok(ui.$('#challenge-card').textContent.includes('Sign in to create'));
            assert.deepEqual(ui.errors, []);
        } finally { await ui.close(); }
    });
}
