'use strict';
/**
 * Preset deck loader.
 *
 * Decks live in data/decks/<id>.deck as plain text:
 *
 *     title: Cell Biology
 *     subject: Biology
 *     level: GCSE
 *     emoji: 🔬
 *     front-template: Define: {}      (optional – wraps every front side)
 *     description: One line summary.
 *     ---
 *     front :: back
 *
 * Card ids are stable ("<deckId>:<n>") so that installing a deck on several
 * devices (or twice) never creates duplicates and syncing stays consistent.
 */
const fs = require('node:fs');
const path = require('node:path');

const DECK_DIR = path.join(__dirname, '..', 'data', 'decks');

function parseDeck(id, text) {
    const normalized = text.replace(/\r\n/g, '\n');
    const sep = normalized.indexOf('\n---\n');
    if (sep === -1) throw new Error(`Deck "${id}" is missing the --- separator`);
    const meta = {};
    for (const line of normalized.slice(0, sep).split('\n')) {
        if (!line.trim()) continue;
        const m = line.match(/^([a-z-]+):\s*(.*)$/);
        if (!m) throw new Error(`Deck "${id}": bad header line "${line}"`);
        meta[m[1]] = m[2].trim();
    }
    for (const required of ['title', 'subject']) {
        if (!meta[required]) throw new Error(`Deck "${id}" is missing "${required}"`);
    }
    const template = meta['front-template'] || '{}';
    const cards = [];
    normalized.slice(sep + 5).split('\n').forEach((line) => {
        if (!line.trim() || line.startsWith('#')) return;
        const i = line.indexOf(' :: ');
        if (i === -1) throw new Error(`Deck "${id}": card line without " :: " -> "${line}"`);
        const front = line.slice(0, i).trim();
        const back = line.slice(i + 4).trim();
        if (!front || !back) throw new Error(`Deck "${id}": empty side -> "${line}"`);
        cards.push({
            id: `${id}:${cards.length + 1}`,
            front: template.replace('{}', front),
            back,
        });
    });
    return {
        id,
        title: meta.title,
        subject: meta.subject,
        level: meta.level || '',
        emoji: meta.emoji || '🎴',
        description: meta.description || '',
        cardCount: cards.length,
        cards,
    };
}

function loadDecks(dir = DECK_DIR) {
    return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.deck'))
        .sort()
        .map((f) => parseDeck(f.replace(/\.deck$/, ''), fs.readFileSync(path.join(dir, f), 'utf8')));
}

/** Deck without its cards – used for listings. */
function summarize(deck) {
    const { cards, ...rest } = deck; // eslint-disable-line no-unused-vars
    return rest;
}

module.exports = { parseDeck, loadDecks, summarize, DECK_DIR };
