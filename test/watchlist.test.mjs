// Tests for the watchlist's order and sections (public/js/watchlist.js).
import assert from 'node:assert/strict';
import {
  isSection, sectionName, sectionOf, symbolsOf, cleanList, uniqueName, addSection, renameSection,
  removeSection, moveEntry, sectionsBySymbol,
} from '../public/js/watchlist.js';

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const L = ['A', 'B', '§Crypto', 'BTC', 'ETH', '§Tech', 'AAPL', 'NVDA'];

test('sections are marked entries in the same list', () => {
  assert.equal(isSection('§Crypto'), true);
  assert.equal(isSection('YAHOO:AAPL'), false);
  assert.equal(sectionName('§Crypto'), 'Crypto');
  assert.equal(sectionOf('Tech'), '§Tech');
  assert.deepEqual(symbolsOf(L), ['A', 'B', 'BTC', 'ETH', 'AAPL', 'NVDA']);
});

test('old saved lists load unchanged; bad entries are dropped', () => {
  assert.deepEqual(cleanList(['YAHOO:AAPL', 'BINANCE:BTCUSDT']), ['YAHOO:AAPL', 'BINANCE:BTCUSDT']);
  assert.deepEqual(cleanList(['A', 'A', 3, null, '', '§', '§  ', '§ X ', '§X']), ['A', '§X']);
  assert.equal(cleanList('nope'), null);
});

test('new sections get unique names and go at the end', () => {
  assert.equal(uniqueName(L, 'Crypto'), 'Crypto 2');
  assert.equal(uniqueName(L, '  '), 'Section');
  assert.equal(uniqueName(L, 'Crypto', 'Crypto'), 'Crypto');
  const { list, name } = addSection(L, 'Tech');
  assert.equal(name, 'Tech 2');
  assert.deepEqual(list.slice(-1), ['§Tech 2']);
});

test('renaming keeps names unique; a blank name changes nothing', () => {
  assert.deepEqual(renameSection(L, 'Tech', 'Stocks').list, ['A', 'B', '§Crypto', 'BTC', 'ETH', '§Stocks', 'AAPL', 'NVDA']);
  assert.equal(renameSection(L, 'Tech', 'Crypto').name, 'Crypto 2');
  assert.equal(renameSection(L, 'Tech', '   ').name, 'Tech');
});

test('deleting a section keeps its symbols', () => {
  assert.deepEqual(removeSection(L, 'Crypto'), ['A', 'B', 'BTC', 'ETH', '§Tech', 'AAPL', 'NVDA']);
});

test('a symbol moves anywhere, into or out of sections', () => {
  assert.deepEqual(moveEntry(L, 0, 2), ['B', 'A', '§Crypto', 'BTC', 'ETH', '§Tech', 'AAPL', 'NVDA']); // down one
  assert.deepEqual(moveEntry(L, 7, 0), ['NVDA', 'A', 'B', '§Crypto', 'BTC', 'ETH', '§Tech', 'AAPL']); // to the top
  assert.deepEqual(moveEntry(L, 0, 4), ['B', '§Crypto', 'BTC', 'A', 'ETH', '§Tech', 'AAPL', 'NVDA']); // into Crypto
  assert.deepEqual(moveEntry(L, 3, 8), ['A', 'B', '§Crypto', 'ETH', '§Tech', 'AAPL', 'NVDA', 'BTC']); // to the end
  assert.deepEqual(moveEntry(L, 3, 3), L); // onto itself
  assert.deepEqual(moveEntry(L, 3, 4), L);
});

test('a section moves with its symbols, only between sections', () => {
  assert.deepEqual(moveEntry(L, 5, 2), ['A', 'B', '§Tech', 'AAPL', 'NVDA', '§Crypto', 'BTC', 'ETH']);
  assert.deepEqual(moveEntry(L, 2, 8), ['A', 'B', '§Tech', 'AAPL', 'NVDA', '§Crypto', 'BTC', 'ETH']);
  // Dropped among the ungrouped symbols at the top or inside another section: snaps to the next section.
  assert.deepEqual(moveEntry(L, 5, 0), ['A', 'B', '§Tech', 'AAPL', 'NVDA', '§Crypto', 'BTC', 'ETH']);
  assert.deepEqual(moveEntry(L, 2, 7), ['A', 'B', '§Tech', 'AAPL', 'NVDA', '§Crypto', 'BTC', 'ETH']);
  assert.deepEqual(moveEntry(L, 2, 4), L); // inside itself
  assert.equal(symbolsOf(moveEntry(L, 2, 8)).length, 6);
});

test('each symbol knows its section', () => {
  const m = sectionsBySymbol(L);
  assert.equal(m.get('A'), '');
  assert.equal(m.get('ETH'), 'Crypto');
  assert.equal(m.get('NVDA'), 'Tech');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
