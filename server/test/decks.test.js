'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadDecks, parseDeck } = require('../../lib/decks');

test('parseDeck parses headers, template and cards', () => {
    const d = parseDeck('t', 'title: T\nsubject: S\nfront-template: Q: {}\n---\na :: b\n\n# comment\nc :: d :: e\n');
    assert.equal(d.cards.length, 2);
    assert.equal(d.cards[0].front, 'Q: a');
    assert.equal(d.cards[1].back, 'd :: e');
    assert.equal(d.cards[1].id, 't:2');
});

test('parseDeck rejects malformed decks', () => {
    assert.throws(() => parseDeck('t', 'title: T\nsubject: S\na :: b'), /separator/);
    assert.throws(() => parseDeck('t', 'subject: S\n---\na :: b'), /title/);
    assert.throws(() => parseDeck('t', 'title: T\nsubject: S\n---\nno separator here'), /::/);
});

test('every bundled deck is valid, has unique ids and a decent size', () => {
    const decks = loadDecks();
    assert.ok(decks.length >= 25, 'expected a rich library');
    const ids = new Set();
    for (const d of decks) {
        assert.ok(d.cardCount >= 10, `${d.id} is too small`);
        assert.ok(!ids.has(d.id));
        ids.add(d.id);
        const fronts = new Set();
        for (const c of d.cards) {
            assert.ok(!fronts.has(c.front), `duplicate question in ${d.id}: ${c.front}`);
            fronts.add(c.front);
        }
    }
});

test('data/library.json is in sync with data/decks', () => {
    const file = path.join(__dirname, '..', '..', 'data', 'library.json');
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({ decks: loadDecks() }) + '\n', 'run `npm run build`');
});
