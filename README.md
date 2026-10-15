# 📚 ReviseForFun

> Make studying actually fun! A free revision tool with **700+ ready-made flashcards**, spaced repetition, quizzes, games, notes – and an optional tiny backend for accounts, cloud sync, deck sharing and a leaderboard.

## ✨ Features

| | |
|---|---|
| 📦 **Deck library** | 31 curated decks / 700+ cards: Biology, Chemistry, Physics, Maths, English, History, Geography, Computer Science, French, Spanish, Study Skills… one click to add. |
| 🧠 **Spaced repetition** | Rate cards *Again / Hard / Good / Easy* (SM-2 style). Daily "due" queue, new/learning/mastered tracking, reverse mode, starring, keyboard shortcuts. |
| ✅ **Quizzes** | Multiple choice (smart distractors from the same subject) or type-the-answer (typo tolerant), per-question timer, mistake review; missed cards return to your queue. |
| 🎮 **Games** | *Match Pairs* memory game and the 60-second *Speed Round* (true/false with streak bonuses). |
| 📝 **Notes** | Markdown (safe subset) with preview. Write `question :: answer` lines and turn them into flashcards. |
| ⏱️ **Pomodoro** | Drift-free timer, desktop notifications, auto-start, XP for finished sessions. |
| 📊 **Progress** | XP & levels, daily goal, streaks, 12-week heatmap, mastery bar, 19 achievements, per-subject stats. |
| 🛠️ **Data tools** | Bulk add, CSV import/export, JSON backup & restore, dark mode, installable PWA that works offline. |
| ☁️ **Backend (optional)** | Accounts, cloud sync that merges devices without losing work, share decks via an 8-letter code, leaderboard. |

Everything works **without** the backend – data lives in your browser's `localStorage`.

## 🚀 Run it

```bash
npm start            # http://localhost:3000 – serves the app AND the API (no dependencies, Node 18+)
npm test             # unit + API tests (+ browser smoke test if jsdom is installed)
npm run build        # regenerate data/library.json after editing a deck
```

Or just open it on GitHub Pages – the workflow in `.github/workflows/static.yml` publishes the static app. To enable accounts/sync there, host the backend somewhere and enter its URL on the **Community** page.

### Backend configuration

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where to listen |
| `DATA_DIR` | `./.data` | Accounts, sessions, shared decks and per-user study data (JSON files, atomic writes) |
| `CORS_ORIGIN` | `*` | `Access-Control-Allow-Origin` (auth uses bearer tokens, not cookies) |
| `TRUST_PROXY` | – | Set to `1` behind a reverse proxy so rate limiting uses `X-Forwarded-For` |

### API

| Endpoint | Auth | Description |
|---|---|---|
| `GET /api/health` | – | Status, deck and card counts |
| `GET /api/decks?q=&subject=` · `GET /api/decks/:id` | – | Preset library (listing / full deck) |
| `POST /api/auth/register` · `/login` · `/logout` | – / token | scrypt-hashed passwords, 30-day session tokens, rate limited |
| `GET/PATCH /api/auth/me` · `DELETE /api/auth/account` | token | Profile, leaderboard opt-out, account deletion |
| `GET/PUT /api/sync` | token | Fetch / merge-and-store your study data (per-item newest-wins, tombstoned deletes, counters never go backwards) |
| `GET /api/leaderboard` | – | Top students by XP (self-reported – friendly competition) |
| `POST/GET/DELETE /api/share` · `GET /api/share/:code` | token / public | Share a deck with a code |

All incoming data is validated and length-capped (`server/sanitize.js`); only an allow-list of static files is served.

## 🧱 Project layout

```
index.html, css/, js/       the app (vanilla JS, no build step)
  js/core.js                pure logic shared with the server: scheduling, XP, merge, CSV…
  js/api.js, community.js   optional backend client, sync, sharing
data/decks/*.deck           preset decks in a simple text format (edit & PR!)
data/library.json           generated bundle for static hosting (npm run build)
lib/decks.js                deck parser
server/                     zero-dependency Node backend + tests
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
