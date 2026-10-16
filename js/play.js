/* ==========================================
   REVISEFORFUN - QUIZ & GAMES
   ========================================== */

// ==================== CONFETTI ====================
function confetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const layer = document.createElement('div');
    layer.className = 'confetti-layer';
    const colors = ['#6c5ce7', '#00cec9', '#fd79a8', '#fdcb6e', '#00b894', '#e17055'];
    for (let i = 0; i < 60; i++) {
        const piece = document.createElement('i');
        piece.style.left = Math.random() * 100 + '%';
        piece.style.background = colors[i % colors.length];
        piece.style.animationDelay = Math.random() * 0.6 + 's';
        piece.style.animationDuration = 1.8 + Math.random() * 1.5 + 's';
        piece.style.setProperty('--drift', (Math.random() * 200 - 100) + 'px');
        layer.appendChild(piece);
    }
    document.body.appendChild(layer);
    setTimeout(() => layer.remove(), 4000);
}

function poolFor(subject) {
    return appData.flashcards.filter((c) => subject === 'all' || c.subject === subject);
}

// ==================== QUIZ ====================
let quizState = null;

renderers.quiz = () => {
    if (quizState && quizState.running) return; // keep an active quiz on screen
    resetQuiz();
};

function resetQuiz() {
    if (quizState) clearInterval(quizState.timer);
    quizState = null;
    $('quiz-results').hidden = true;
    $('quiz-active').hidden = true;
    $('quiz-setup').hidden = false;
    const banner = $('quiz-challenge-banner');
    if (banner) { banner.hidden = true; banner.textContent = ''; }
    fillSubjectSelect($('quiz-subject'));
    const none = appData.flashcards.length === 0;
    $('start-quiz-btn').disabled = none;
    $('quiz-requirement').hidden = !none && appData.flashcards.length >= 4;
}
actions['reset-quiz'] = resetQuiz;

actions['start-quiz'] = () => {
    const subject = $('quiz-subject').value;
    const mode = $('quiz-mode').value;
    const count = parseInt($('quiz-count').value, 10);
    const timePerQ = parseInt($('quiz-time').value, 10);
    const pool = poolFor(subject);
    if (!pool.length) return showToast('No flashcards in that subject yet.', 'error');
    if (mode === 'choice' && appData.flashcards.length < 4) {
        $('quiz-requirement').hidden = false;
        return showToast('Multiple choice needs at least 4 flashcards – or try “Type the answer”.', 'error');
    }
    const questions = Core.shuffle([...pool]).slice(0, Math.min(count, pool.length));
    beginQuiz({ questions, subject, mode, timePerQ });
};

/**
 * `pool` is where wrong answers come from (a friend challenge uses its own
 * cards) and `challenge` marks a run that scores on someone else's board
 * instead of your own stats.
 */
function beginQuiz({ questions, subject, mode, timePerQ, pool, challenge }) {
    quizState = {
        questions, subject, mode, timePerQ, index: 0, score: 0, answers: [], timer: null,
        locked: false, running: true, pool: pool || appData.flashcards, challenge: challenge || null,
    };
    $('quiz-setup').hidden = true;
    $('quiz-results').hidden = true;
    $('quiz-active').hidden = false;
    $('quiz-total-num').textContent = questions.length;
    const banner = $('quiz-challenge-banner');
    if (banner) {
        banner.hidden = !challenge;
        if (challenge) banner.textContent = `⚔️ ${challenge.title} · by ${challenge.author} · 20s per question`;
    }
    showQuizQuestion();
}

actions['retake-quiz'] = () => {
    const q = quizState;
    if (!q) return resetQuiz();
    if (q.challenge) return startChallengeQuiz(q.challenge.payload, q.challenge);
    beginQuiz({ questions: Core.shuffle([...q.questions]), subject: q.subject, mode: q.mode, timePerQ: q.timePerQ });
};

function showQuizQuestion() {
    const q = quizState;
    if (q.index >= q.questions.length) return finishQuiz();
    const card = q.questions[q.index];
    q.locked = false;
    $('quiz-question-num').textContent = q.index + 1;
    $('quiz-question-text').textContent = card.front;
    $('quiz-current-score').textContent = q.score;
    $('quiz-feedback').hidden = true;
    $('quiz-next').hidden = true;

    const options = $('quiz-options');
    const typed = $('quiz-typed');
    if (q.mode === 'choice') {
        typed.hidden = true;
        options.hidden = false;
        const choices = Core.shuffle([card.back, ...Core.pickDistractors(card, q.pool, 3)]);
        options.innerHTML = '';
        choices.forEach((text, i) => {
            const btn = document.createElement('button');
            btn.className = 'quiz-option';
            btn.type = 'button';
            btn.dataset.value = text;
            const letter = document.createElement('span');
            letter.className = 'quiz-option-letter';
            letter.textContent = 'ABCD'[i];
            const label = document.createElement('span');
            label.textContent = text;
            btn.append(letter, label);
            btn.addEventListener('click', () => answerQuiz(text));
            options.appendChild(btn);
        });
    } else {
        options.hidden = true;
        typed.hidden = false;
        $('quiz-typed-input').value = '';
        $('quiz-typed-input').disabled = false;
        $('quiz-typed-submit').disabled = false;
        setTimeout(() => $('quiz-typed-input').focus(), 30);
    }
    startQuizTimer();
}

function startQuizTimer() {
    const q = quizState;
    clearInterval(q.timer);
    const timerEl = $('quiz-timer');
    if (!q.timePerQ) { timerEl.hidden = true; return; }
    timerEl.hidden = false;
    let left = q.timePerQ;
    const paint = () => {
        $('quiz-timer-text').textContent = left + 's';
        $('quiz-timer-fill').style.width = (left / q.timePerQ) * 100 + '%';
    };
    paint();
    q.timer = setInterval(() => {
        left--;
        paint();
        if (left <= 0) {
            clearInterval(q.timer);
            if (!q.locked) answerQuiz(null, true);
        }
    }, 1000);
}

function answerQuiz(given, timedOut = false) {
    const q = quizState;
    if (!q || q.locked) return;
    q.locked = true;
    clearInterval(q.timer);
    const card = q.questions[q.index];
    let status;
    if (timedOut || given == null) status = 'wrong';
    else if (q.mode === 'choice') status = given === card.back ? 'correct' : 'wrong';
    else status = Core.checkTypedAnswer(given, card.back);
    const correct = status !== 'wrong';
    if (correct) q.score++;
    q.answers.push({ card, given: timedOut ? '' : given, status, timedOut });

    if (q.mode === 'choice') {
        document.querySelectorAll('#quiz-options .quiz-option').forEach((btn) => {
            btn.classList.add('disabled');
            if (btn.dataset.value === card.back) btn.classList.add('correct');
            else if (btn.dataset.value === given) btn.classList.add('incorrect');
        });
    } else {
        $('quiz-typed-input').disabled = true;
        $('quiz-typed-submit').disabled = true;
    }
    const fb = $('quiz-feedback');
    fb.hidden = false;
    fb.className = `quiz-feedback ${correct ? 'good' : 'bad'}`;
    fb.textContent = timedOut ? `⏰ Time's up! Answer: ${card.back}`
        : status === 'correct' ? '✅ Correct!'
        : status === 'close' ? `✅ Close enough! Exact answer: ${card.back}`
        : `❌ Not quite. Answer: ${card.back}`;
    $('quiz-current-score').textContent = q.score;
    $('quiz-next').hidden = false;
    const nextBtn = $('quiz-next').querySelector('button');
    nextBtn.textContent = q.index + 1 >= q.questions.length ? 'See results →' : 'Next →';
    nextBtn.focus();
}

actions['quiz-next'] = () => {
    const q = quizState;
    if (!q || !q.locked) return;
    q.index++;
    showQuizQuestion();
};

$('quiz-typed').addEventListener('submit', (e) => {
    e.preventDefault();
    if (quizState && !quizState.locked) answerQuiz($('quiz-typed-input').value);
});

function finishQuiz() {
    const q = quizState;
    clearInterval(q.timer);
    q.running = false;
    const total = q.questions.length;
    const pct = Math.round((q.score / total) * 100);
    const now = Date.now();

    if (q.challenge) return finishChallengeQuiz(q, total, pct);

    appData.quizHistory.push({
        id: generateId(), subject: q.subject === 'all' ? 'All Subjects' : q.subject, mode: q.mode,
        score: q.score, total, percentage: pct, date: now,
    });
    if (appData.quizHistory.length > 500) appData.quizHistory.splice(0, appData.quizHistory.length - 500);

    // Missed cards come back into the review queue straight away.
    let queued = 0;
    for (const a of q.answers) {
        if (a.status !== 'wrong') continue;
        const live = findCard(a.card.id);
        if (live && live.due > now) { live.due = now; live.updatedAt = now; queued++; }
    }
    const xp = q.score * 5 + 10 + (pct === 100 && total >= 5 ? 20 : 0);
    award(xp);
    recordActivity(total);
    commit();

    $('quiz-active').hidden = true;
    $('quiz-results').hidden = false;
    $('results-score').textContent = q.score;
    $('results-total').textContent = total;
    $('results-percentage').textContent = pct + '%';
    const [emoji, title] = pct === 100 ? ['🏆', 'Perfect Score!'] : pct >= 80 ? ['🎉', 'Excellent!'] : pct >= 60 ? ['👍', 'Good Job!']
        : pct >= 40 ? ['💪', 'Keep Practicing!'] : ['📚', 'More Study Needed'];
    $('results-emoji').textContent = emoji;
    $('results-title').textContent = title;
    $('results-xp').textContent = `+${xp} XP${queued ? ` · ${plural(queued, 'missed card')} added to your review queue` : ''}`;

    const wrong = q.answers.filter((a) => a.status === 'wrong');
    $('results-review').innerHTML = wrong.length ? `<h4>Review your mistakes</h4>${wrong.map((a) => `
        <div class="review-item">
            <div class="review-q">${esc(a.card.front)}</div>
            <div class="review-given">${a.timedOut ? '⏰ No answer' : `❌ ${esc(a.given || '—')}`}</div>
            <div class="review-correct">✅ ${esc(a.card.back)}</div>
        </div>`).join('')}` : '<p class="empty-text">No mistakes – flawless! 🌟</p>';
    if (pct >= 80 && total >= 5) confetti();
}

// ==================== FRIEND CHALLENGES ====================
/**
 * Runs a shared challenge as a multiple-choice quiz: 20 seconds a question,
 * distractors taken from the challenge's own cards, no XP and no quiz history –
 * it still counts towards your streak, and the result lands on the board.
 */
function startChallengeQuiz(payload, previous) {
    const cards = (payload.cards || []).map((c, i) => ({ ...c, id: `ch${i}` }));
    if (!cards.length) return showToast('That challenge has no cards.', 'error');
    const challenge = {
        code: payload.code, title: payload.title, author: payload.author || 'a friend',
        startedAt: Date.now(), payload, previous,
    };
    showPage('quiz');
    beginQuiz({
        questions: Core.shuffle([...cards]), subject: 'Challenge', mode: 'choice',
        timePerQ: 20, pool: cards, challenge,
    });
    return true;
}

function finishChallengeQuiz(q, total, pct) {
    const timeMs = Date.now() - q.challenge.startedAt;
    // Counts towards the streak, but not towards XP or your quiz history.
    recordActivity(total);
    commit();

    $('quiz-active').hidden = true;
    $('quiz-results').hidden = false;
    $('results-score').textContent = q.score;
    $('results-total').textContent = total;
    $('results-percentage').textContent = pct + '%';
    const [emoji, title] = pct === 100 ? ['🏆', 'Flawless!'] : pct >= 80 ? ['🎉', 'Excellent!'] : pct >= 60 ? ['👍', 'Good job!']
        : pct >= 40 ? ['💪', 'Not bad!'] : ['📚', 'Worth another go'];
    $('results-emoji').textContent = emoji;
    $('results-title').textContent = title;
    $('results-xp').textContent = `⚔️ ${q.challenge.title} · ${Math.round(timeMs / 1000)}s · submitting your score…`;
    $('results-review').innerHTML = '<p class="empty-text">Sending your result…</p>';

    const wrong = q.answers.filter((a) => a.status === 'wrong');
    API.submitChallengeResult(q.challenge.code, { score: q.score, total, timeMs })
        .then((r) => {
            if (!quizState || quizState !== q) return; // the student moved on
            $('results-xp').textContent = `⚔️ ${q.challenge.title} · ${Math.round(timeMs / 1000)}s · you are #${r.rank}${r.best && r.best.score > q.score ? ` (best ${r.best.score}/${total})` : ''}`;
            $('results-review').innerHTML = challengeBoardHtml(r.results, API.state.user && API.state.user.username, total)
                + (wrong.length ? `<h4>Review your mistakes</h4>${wrong.map((a) => `
                    <div class="review-item">
                        <div class="review-q">${esc(a.card.front)}</div>
                        <div class="review-given">${a.timedOut ? '⏰ No answer' : `❌ ${esc(a.given || '—')}`}</div>
                        <div class="review-correct">✅ ${esc(a.card.back)}</div>
                    </div>`).join('')}` : '');
            if (pct === 100) confetti();
        })
        .catch((e) => {
            $('results-xp').textContent = `⚔️ ${q.challenge.title} · ${Math.round(timeMs / 1000)}s`;
            $('results-review').innerHTML = `<p class="empty-text">Your score could not be submitted: ${esc(e.message)}</p>`;
        });
}

function challengeBoardHtml(results, me, total) {
    if (!results || !results.length) return '';
    return `<h4>Leaderboard</h4><table class="lb-table"><thead><tr><th>#</th><th>Student</th><th>Score</th><th>Time</th></tr></thead><tbody>${
        results.map((r) => `<tr class="${r.username === me ? 'lb-me' : ''}">
            <td>${['🥇', '🥈', '🥉'][r.rank - 1] || r.rank}</td><td>${esc(r.username)}</td>
            <td>${r.score}/${r.total || total}</td><td>${(r.timeMs / 1000).toFixed(1)}s</td></tr>`).join('')
    }</tbody></table>`;
}

keyHandlers.push((e) => {
    const q = quizState;
    if (currentPage !== 'quiz' || !q || !q.running || $('quiz-active').hidden) return false;
    if (q.locked) {
        if (e.key === 'Enter' || e.key === ' ') { actions['quiz-next'](); return true; }
        return false;
    }
    if (q.mode === 'choice') {
        if (e.key.length !== 1) return false;
        const key = e.key.toLowerCase();
        let idx = '1234'.indexOf(key);
        if (idx < 0) idx = 'abcd'.indexOf(key);
        const btn = document.querySelectorAll('#quiz-options .quiz-option')[idx];
        if (idx >= 0 && btn) { btn.click(); return true; }
    }
    return false;
});

leaveHooks.push((from, to) => {
    if (from === 'quiz' && to !== 'quiz' && quizState) {
        clearInterval(quizState.timer);
        quizState = null;
        const banner = $('quiz-challenge-banner');
        if (banner) banner.hidden = true;
    }
});

// ==================== GAMES ====================
let game = null;

function showGameView(view) {
    $('games-hub').hidden = view !== 'hub';
    $('match-area').hidden = view !== 'match';
    $('speed-area').hidden = view !== 'speed';
    $('game-over').hidden = view !== 'over';
}

function stopGame() {
    if (game) {
        clearInterval(game.timer);
        clearTimeout(game.flipTimer);
    }
    game = null;
}

renderers.games = () => {
    stopGame();
    showGameView('hub');
    fillSubjectSelect($('match-subject'));
    fillSubjectSelect($('speed-subject'));
    $('games-requirement').hidden = appData.flashcards.length >= 4;
};

actions['exit-game'] = () => renderers.games();

leaveHooks.push((from, to) => { if (from === 'games' && to !== 'games') stopGame(); });

actions['play-again'] = () => {
    const type = game && game.type;
    const subject = game && game.subject;
    if (type === 'match') startMatch(subject);
    else if (type === 'speed') startSpeed(subject);
    else renderers.games();
};

// ---------- Match Pairs ----------
actions['start-match'] = () => startMatch($('match-subject').value);

function startMatch(subject) {
    const pool = poolFor(subject);
    if (pool.length < 4) return showToast('You need at least 4 flashcards in that subject to play.', 'error');
    stopGame();
    const short = pool.filter((c) => c.front.length <= 70 && c.back.length <= 70);
    const chosen = Core.shuffle([...(short.length >= 4 ? short : pool)]).slice(0, 6);
    const tiles = Core.shuffle(chosen.flatMap((c) => [
        { pair: c.id, kind: 'q', text: c.front }, { pair: c.id, kind: 'a', text: c.back },
    ]));
    game = { type: 'match', subject, tiles, pairs: chosen.length, found: 0, moves: 0, open: [], lock: false, start: Date.now(), timer: null, flipTimer: null };
    $('match-grid').innerHTML = '';
    tiles.forEach((t, i) => {
        const btn = document.createElement('button');
        btn.className = 'match-tile';
        btn.dataset.index = i;
        btn.setAttribute('aria-label', 'Hidden tile');
        btn.innerHTML = '<span class="match-back">?</span><span class="match-front"></span>';
        btn.querySelector('.match-front').textContent = t.text;
        btn.addEventListener('click', () => flipMatchTile(i, btn));
        $('match-grid').appendChild(btn);
    });
    $('match-moves').textContent = 0;
    $('match-time').textContent = '0s';
    $('match-pairs').textContent = `0/${chosen.length}`;
    game.timer = setInterval(() => { $('match-time').textContent = Math.floor((Date.now() - game.start) / 1000) + 's'; }, 500);
    showGameView('match');
}

function flipMatchTile(i, btn) {
    if (!game || game.type !== 'match' || game.lock) return;
    if (btn.classList.contains('open') || btn.classList.contains('matched')) return;
    btn.classList.add('open');
    game.open.push({ i, btn });
    if (game.open.length < 2) return;

    game.moves++;
    $('match-moves').textContent = game.moves;
    const [a, b] = game.open;
    const ta = game.tiles[a.i];
    const tb = game.tiles[b.i];
    game.open = [];
    if (ta.pair === tb.pair && ta.kind !== tb.kind) {
        a.btn.classList.replace('open', 'matched');
        b.btn.classList.replace('open', 'matched');
        game.found++;
        $('match-pairs').textContent = `${game.found}/${game.pairs}`;
        if (game.found === game.pairs) finishMatch();
    } else {
        game.lock = true;
        game.flipTimer = setTimeout(() => {
            a.btn.classList.remove('open');
            b.btn.classList.remove('open');
            if (game) game.lock = false;
        }, 900);
    }
}

function finishMatch() {
    clearInterval(game.timer);
    const secs = Math.round((Date.now() - game.start) / 1000);
    const perfect = game.moves <= game.pairs + 2;
    const xp = 20 + (perfect ? 15 : 0) + Math.max(0, 30 - secs) ;
    appData.matchWins = (appData.matchWins || 0) + 1;
    award(xp);
    recordActivity(game.pairs);
    appData.totalStudyMinutes += Math.max(1, Math.round(secs / 60));
    commit();
    const { moves, pairs } = game;
    setTimeout(() => {
        if (!game || game.type !== 'match') return;
        $('game-over-emoji').textContent = perfect ? '🏆' : '🎉';
        $('game-over-title').textContent = perfect ? 'Amazing memory!' : 'All pairs matched!';
        $('game-over-stats').innerHTML = `
            <div><strong>${pairs}</strong><span>pairs</span></div>
            <div><strong>${moves}</strong><span>moves</span></div>
            <div><strong>${secs}s</strong><span>time</span></div>
            <div><strong>+${xp}</strong><span>XP</span></div>`;
        showGameView('over');
        confetti();
    }, 700);
}

// ---------- Speed Round ----------
const SPEED_SECONDS = 60;
actions['start-speed'] = () => startSpeed($('speed-subject').value);

function startSpeed(subject) {
    const pool = poolFor(subject);
    if (pool.length < 4 && appData.flashcards.length < 4) return showToast('You need at least 4 flashcards to play.', 'error');
    if (!pool.length) return showToast('No flashcards in that subject yet.', 'error');
    stopGame();
    game = { type: 'speed', subject, pool, score: 0, correct: 0, answered: 0, streak: 0, bestStreak: 0, left: SPEED_SECONDS, current: null, timer: null, locked: false };
    showGameView('speed');
    nextSpeedQuestion();
    paintSpeed();
    game.timer = setInterval(() => {
        game.left--;
        paintSpeed();
        if (game.left <= 0) finishSpeed();
    }, 1000);
}

function paintSpeed() {
    $('speed-score').textContent = game.score;
    $('speed-streak').textContent = game.streak;
    $('speed-time').textContent = Math.max(game.left, 0);
    $('speed-timer-fill').style.width = (Math.max(game.left, 0) / SPEED_SECONDS) * 100 + '%';
}

function nextSpeedQuestion() {
    const card = game.pool[Math.floor(Math.random() * game.pool.length)];
    const truth = Math.random() < 0.5;
    const wrong = Core.pickDistractors(card, appData.flashcards, 1)[0];
    const showTrue = truth || !wrong;
    game.current = { card, isTrue: showTrue };
    game.locked = false;
    $('speed-card').className = 'speed-card';
    $('speed-q').textContent = card.front;
    $('speed-a').textContent = showTrue ? card.back : wrong;
}

actions['speed-answer'] = (arg) => {
    if (!game || game.type !== 'speed' || game.locked || game.left <= 0) return;
    game.locked = true;
    const said = arg === 'true';
    const right = said === game.current.isTrue;
    game.answered++;
    if (right) {
        game.correct++;
        game.streak++;
        game.bestStreak = Math.max(game.bestStreak, game.streak);
        game.score += 1 + (game.streak > 0 && game.streak % 5 === 0 ? 2 : 0);
    } else {
        game.streak = 0;
        game.score = Math.max(0, game.score - 1);
    }
    $('speed-card').className = `speed-card ${right ? 'flash-good' : 'flash-bad'}`;
    paintSpeed();
    setTimeout(() => { if (game && game.type === 'speed' && game.left > 0) nextSpeedQuestion(); }, 280);
};

function finishSpeed() {
    clearInterval(game.timer);
    const g = game;
    const xp = g.correct * 2 + Math.min(g.bestStreak, 20);
    award(xp);
    recordActivity(g.answered);
    appData.totalStudyMinutes += 1;
    commit();
    const acc = g.answered ? Math.round((g.correct / g.answered) * 100) : 0;
    $('game-over-emoji').textContent = g.score >= 25 ? '🏆' : g.score >= 12 ? '🎉' : '👍';
    $('game-over-title').textContent = "Time's up!";
    $('game-over-stats').innerHTML = `
        <div><strong>${g.score}</strong><span>score</span></div>
        <div><strong>${acc}%</strong><span>accuracy</span></div>
        <div><strong>${g.bestStreak}</strong><span>best streak</span></div>
        <div><strong>+${xp}</strong><span>XP</span></div>`;
    showGameView('over');
    if (g.score >= 25) confetti();
}

keyHandlers.push((e) => {
    if (currentPage !== 'games' || !game || game.type !== 'speed' || $('speed-area').hidden) return false;
    if (e.key === 'ArrowRight' || e.key.toLowerCase() === 't') { actions['speed-answer']('true'); return true; }
    if (e.key === 'ArrowLeft' || e.key.toLowerCase() === 'f') { actions['speed-answer']('false'); return true; }
    return false;
});
