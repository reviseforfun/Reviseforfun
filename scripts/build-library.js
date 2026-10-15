#!/usr/bin/env node
'use strict';
// Bundles data/decks/*.deck into data/library.json so the static site (GitHub
// Pages, no backend) can load every preset deck with a single request.
const fs = require('node:fs');
const path = require('node:path');
const { loadDecks } = require('../lib/decks');

const decks = loadDecks();
const out = path.join(__dirname, '..', 'data', 'library.json');
const json = JSON.stringify({ decks }) + '\n';
if (process.argv.includes('--check')) {
    const current = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
    if (current !== json) {
        console.error('data/library.json is out of date – run `npm run build`.');
        process.exit(1);
    }
    console.log(`library.json is up to date (${decks.length} decks).`);
} else {
    fs.writeFileSync(out, json);
    const cards = decks.reduce((n, d) => n + d.cardCount, 0);
    console.log(`Wrote ${out} – ${decks.length} decks, ${cards} cards.`);
}
