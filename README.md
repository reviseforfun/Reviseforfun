# 📚 ReviseForFun 3.0

> Make studying actually fun! A free, offline-first revision tool with **700+ ready-made GCSE flashcards**, spaced repetition, an **exam planner**, quizzes, games, notes, **friend challenges** – and an optional zero-dependency backend for accounts, cloud sync and sharing.

**Requires Node 22.13+** (the backend uses the built-in `node:sqlite`). No npm packages are needed at runtime, and there is no build step for the front end.

## ✨ Features

| | |
|---|---|
| 📦 **Deck library** | 31 curated decks / 700+ cards: Biology, Chemistry, Physics, Maths, English, History, Geography, Computer Science, French, Spanish, Study Skills… one click to add. |
| 🧠 **Spaced repetition** | Rate cards *Again / Hard / Good / Easy* (SM-2 style). Daily "due" queue, new/learning/mastered tracking, reverse mode, starring, keyboard shortcuts, and a maximum of 20 new cards per session so reviews are never buried. |
| 💡 **Progressive hints** | Press <kbd>H</kbd> (or the Hint button) to reveal the first letter of each word, then the first half. A hinted card cannot be rated *Easy* – it is downgraded to *Good*. |
| 🗺️ **Exam planner** (new in 3.0) | Per-subject readiness from the forgetting curve, exam dates with a countdown, "X% today → Y% on exam day if you stop now", new-cards-per-day targets, a 14-day review workload chart, weak-spot rescue sessions and one-click "Boost readiness". |
| ❄️ **Streak freezes** (new in 3.0) | Earn one every 7-day streak, bank up to two. A freeze is spent automatically to bridge a single missed day. |
| ✅ **Quizzes** | Multiple choice (smart distractors from the same subject) or type-the-answer (typo tolerant), per-question timer, mistake review; missed cards return to your queue. |
| ⚔️ **Friend challenges** (new in 3.0) | Turn any subject into a timed 20-seconds-a-question quiz, share an 8-character code or link, and compare scores on the challenge board. Best attempt counts; no XP, but it keeps your streak alive. |
| 🎮 **Games** | *Match Pairs* memory game and the 60-second *Speed Round* (true/false with streak bonuses). |
| 📝 **Notes** | Markdown (safe subset) with preview. Write `question :: answer` lines and turn them into flashcards. |
| ⏱️ **Pomodoro** | Drift-free timer, desktop notifications, auto-start, XP for finished sessions. |
| 📊 **Progress** | XP & levels, daily goal, streaks, 12-week heatmap, mastery bar, 19 achievements, per-subject stats. |
| 👤 **Accounts** (new in 3.0) | Username + password (email **optional**), scrypt hashing, 30-day sessions, a device list, account lockout after 5 wrong passwords, a one-time recovery code, and optional verified email for password resets. |
| 🛠️ **Data tools** | Bulk add, CSV import/export, JSON backup & restore, dark mode, installable PWA that works offline. |
| ☁️ **Backend (optional)** | SQLite storage, cloud sync that merges devices without losing work (row-level diffs), share decks via a code, leaderboard. |

Everything works **without** the backend – data lives in your browser's `localStorage`, and the sync client merges it back when an account appears.

## 🚀 Run it

```bash
npm start            # http://localhost:3000 – serves the app AND the API (no dependencies, Node 22.13+)
npm run dev          # the same, with --watch
npm test             # core + storage + API tests (+ browser tests if jsdom is installed)
npm run build        # regenerate data/library.json after editing a deck
npm run check        # fail if data/library.json is out of date (used by CI)
```

Optional browser tests – jsdom is deliberately **not** a dependency:

```bash
npm i --no-save jsdom@26 && npm test
```

### GitHub Pages

`.github/workflows/static.yml` publishes the static app (index.html, css, js, icons, manifest, service worker and `data/library.json`) to GitHub Pages. **Pages hosts the front end only** – accounts, cloud sync, sharing and challenges need the Node server running somewhere (a small VPS, Fly.io, Render…). Put its URL in *Community → Server settings* and the static site will use it.

### Backend configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where to listen |
| `DATA_DIR` | `./.data` | Directory holding `rff.sqlite` (created on first boot). A 2.x `db.json` store found here is imported once and renamed to `db.json.migrated`. |
| `PUBLIC_URL` | `http://localhost:$PORT` | **The only** source of email links (`${PUBLIC_URL}/#community?verify=…`). The `Host`, `Origin`, `Referer` and `X-Forwarded-Host` headers are never used, so they cannot be forged into a reset link. |
| `MAIL_WEBHOOK_URL` | – | When set, mail is delivered by `POST {to, subject, text}` to this URL. **Email is off by default**: without it, messages are printed to the console and kept in an in-memory outbox (what the tests read). `/api/health` reports `emailEnabled`. |
| `MAIL_WEBHOOK_TOKEN` | – | Sent as `Authorization: Bearer <token>` with the webhook call. |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` (auth uses bearer tokens, not cookies). |
| `TRUST_PROXY` | – | Set to `1` behind a reverse proxy so rate limiting uses `X-Forwarded-For`. |

### API

Every error is `{ "error": "message" }`. Authenticated routes take `Authorization: Bearer <token>`.

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/health` | – | Status, deck/card counts, `emailEnabled`, storage driver and schema version |
| `GET /api/decks?q=&subject=` · `GET /api/decks/:id` | – | Preset library (listing / full deck) |
| `POST /api/auth/register` | – | `{username, password, email?}` → `{token, user, recoveryCode}`. The recovery code (`XXXX-XXXX-XXXX-XXXX`) is shown once; only its hash is stored. |
| `POST /api/auth/login` | – | `{username, password}` where `username` may be a username **or a verified email**. 5 wrong passwords lock the account for 5 minutes (429). |
| `POST /api/auth/logout` · `/logout-all` | token | Sign out this device / every device |
| `GET /api/auth/me` · `PATCH /api/auth/me` | token | Profile. Patch `{showOnLeaderboard}`, or `{email, password}` to add, change or clear the address (clearing sends no mail; setting it sends a verification link). |
| `POST /api/auth/email/resend` · `/email/verify` | token / – | Resend the confirmation link; `{token}` verifies it (409 if another account already owns the address) |
| `POST /api/auth/password` | token | `{oldPassword, newPassword}` – signs out every other device |
| `POST /api/auth/recovery-code` | token | `{password}` → a replacement recovery code |
| `POST /api/auth/forgot` | – | `{identifier}` – always the same reply; mails a reset link only to a **verified** address. 5/hour per IP, 3/hour per identifier. |
| `POST /api/auth/reset` | – | `{token, newPassword}` – single use, revokes all sessions. A rejected weak password does not burn the link. |
| `POST /api/auth/recover` | – | `{username, recoveryCode, newPassword}` – burns the old code, returns a new one plus a session |
| `GET /api/auth/sessions` · `DELETE /api/auth/sessions/:id` | token | Device list (at most 10 kept) and sign-out; `:id` is the first 16 characters of the token hash |
| `DELETE /api/auth/account` | token | `{password}` – deletes the account and cascades to every owned row |
| `GET /api/sync` · `PUT /api/sync` | token | Fetch the document / merge-and-store it. `PUT {data}` returns `{data: merged, syncedAt}`. Merging is per item by newest `updatedAt`, deletions are tombstoned, counters keep the maximum, exam dates come from the newer document, and only changed rows are written. |
| `GET /api/leaderboard?limit=` | – | Top students by XP (a SQL query over the denormalised `users` columns) |
| `POST /api/share` · `GET /api/share` · `DELETE /api/share/:code` · `GET /api/share/:code` | token / public | Share up to 500 cards with an 8-character code (25 shares per account) |
| `POST /api/challenges` · `GET /api/challenges` · `DELETE /api/challenges/:code` | token | Create (3–50 cards, 25 per account), list with player counts, delete (owner only) |
| `GET /api/challenges/:code` | – | Public challenge: title, author, cards and the top 20 results |
| `POST /api/challenges/:code/results` | token | `{score, total, timeMs}` – `total` must equal the card count, times under `total × 300 ms` are rejected, only your best attempt is kept (score desc, then time asc). Returns `{results, rank, best}`. |

Security: scrypt password hashing, SHA-256 session tokens (never stored in plain), constant-time comparisons, a dummy hash for unknown users, IP rate limits, a static-file allow-list, security headers, and `server/sanitize.js` validating and length-capping every incoming document.

## 🧱 Project layout

```
index.html, css/, js/       the app (vanilla JS, no build step)
  js/core.js                pure logic shared with the server: scheduling, XP, streak freezes,
                            retrievability, exam planning, hints, merge, CSV…
  js/plan.js                the Plan page (readiness, exams, forecast, weak spots)
  js/api.js, community.js   optional backend client, sync, accounts, sharing, challenges
data/decks/*.deck           preset decks in a simple text format (edit & PR!)
data/library.json           generated bundle for static hosting (npm run build)
lib/decks.js                deck parser
server/index.js             HTTP server + API routes
server/db.js                node:sqlite storage: migrations, tx(), row-level document diff
server/auth.js              scrypt, tokens, recovery codes, password policy
server/mailer.js            pluggable mailer (webhook, console + outbox)
server/legacy.js            one-time import of the 2.x JSON store
server/sanitize.js          validation and length caps for incoming documents
server/test/*.test.js       node:test suites (core, db, api, ui)
```

### Adding a deck

Create `data/decks/my-deck.deck`:

```
title: My Deck
subject: Biology
level: GCSE
emoji: 🧬
front-template: Define: {}     # optional
description: One line summary.
---
question :: answer
```

then run `npm run build` and `npm test`.

## 📝 License

MIT – free to use, modify and distribute.

---

Made with ❤️ for students everywhere
