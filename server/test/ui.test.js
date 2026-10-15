'use strict';
/**
 * End-to-end smoke test of the browser app (served by the real backend) in jsdom.
 * jsdom is intentionally NOT a dependency of the project, so this test is skipped
 * unless it is installed:   npm i --no-save jsdom && npm test
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../index');
const { Store } = require('../store');

let JSDOM, ResourceLoader, VirtualConsole;
try {
    ({ JSDOM, ResourceLoader, VirtualConsole } = require('jsdom'));
} catch {
    test('browser UI smoke test (skipped: jsdom not installed)', { skip: true }, () => {});
}

if (JSDOM) {
    class LocalOnly extends ResourceLoader {
        fetch(url, opts) {
            return url.startsWith('http://127.0.0.1') ? super.fetch(url, opts) : Promise.resolve(Buffer.from(''));
        }
    }

    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    async function boot() {
        const { server } = createApp({ store: new Store(null) });
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
            window, document, errors, $,
            get: (expr) => window.eval(expr),
            click: (sel) => { const el = typeof sel === 'string' ? $(sel) : sel; assert.ok(el, `missing ${sel}`); el.click(); },
            act: (name, arg) => { const el = $(`[data-action="${name}"]${arg !== undefined ? `[data-arg="${arg}"]` : ''}`); assert.ok(el, `missing action ${name}`); el.click(); },
            go: async (page) => { window.eval(`showPage('${page}')`); await sleep(60); },
            until: async (fn, label = 'condition') => {
                for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(30); }
                assert.fail(`timed out waiting for ${label}`);
            },
            type: (sel, value) => { const el = $(sel); el.value = value; el.dispatchEvent(new window.Event('input', { bubbles: true })); el.dispatchEvent(new window.Event('change', { bubbles: true })); },
            close: async () => { window.close(); await new Promise((r) => server.close(r)); },
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

    test('browser app: library → study → quiz → games → notes → timer → stats', async () => {
        const ui = await boot();
        try {
            assert.equal(ui.get('API.state.online'), true);
            // Home
            await ui.until(() => ui.document.querySelectorAll('#home-decks .deck-card').length === 6, 'featured decks');
            assert.ok(ui.$('#dashboard').textContent.includes('Daily goal'));

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
            ui.$('#auth-username').value = 'student1';
            ui.$('#auth-password').value = 'a good password';
            ui.act('register');
            await ui.until(() => ui.get('API.isLoggedIn()'), 'registered');
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
            await ui.until(() => ui.$('.share-code-big'), 'share code');
            const code = ui.$('.share-code-big').textContent;
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
}
