// Tests for the stock screener: metrics, signals, insights (lib/screener.mjs) and the
// ideas/filters/sorting in the panel (public/js/screener.js).
import assert from 'node:assert/strict';
import { rsi, technicals, signals, buildRow, insights } from '../lib/screener.mjs';
import { applyScreen, IDEAS, fmtCap } from '../public/js/screener.js';

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const NOW = 1_800_000_000;

test('RSI: 100 on a steady rise, 0 on a steady fall, 50 when flat', () => {
  const rise = Array.from({ length: 30 }, (_, i) => 100 + i);
  assert.equal(rsi(rise), 100);
  assert.equal(rsi(rise.slice().reverse()), 0);
  assert.equal(rsi(Array(30).fill(10)), 50);
  assert.equal(rsi([1, 2, 3]), null);
});

test('technicals: returns, breakout, streak', () => {
  const closes = Array.from({ length: 260 }, (_, i) => 100 + i * 0.1);
  closes.push(150); // jumps above the last 20 days' range
  const t = technicals(closes);
  assert.ok(t.hi20 && !t.lo20);
  assert.ok(t.r1w > 0 && t.r1m > 0 && t.r3m > 0);
  assert.ok(t.streak >= 2, `streak ${t.streak}`);
  assert.ok(t.rsi > 70);
});

test('technicals: spots a fresh golden cross', () => {
  // Long slide, then a sharp rally: the 50-day average climbs back over the 200-day.
  const closes = [...Array.from({ length: 200 }, (_, i) => 200 - i * 0.5), ...Array.from({ length: 60 }, (_, i) => 100 + i * 4)];
  let found = null;
  for (let end = 230; end <= closes.length; end++) {
    const t = technicals(closes.slice(0, end));
    if (t.cross?.type === 'golden') { found = t.cross; break; }
  }
  assert.ok(found && found.daysAgo === 0, JSON.stringify(found));
});

test('technicals: too little history gives nulls, not errors', () => {
  const t = technicals([10, 11, 12]);
  assert.equal(t.rsi, null);
  assert.equal(t.r1m, null);
  assert.equal(t.cross, null);
  assert.equal(technicals([]), null);
});

const base = { s: 'TEST', n: 'Test Inc', p: 100, c: 1, v: 1e6, m: 5e9, sec: 'Technology', ind: 'Software' };
const quote = (extra) => ({
  regularMarketPrice: 110, regularMarketChangePercent: 5, regularMarketVolume: 3e6, averageDailyVolume10Day: 1e6,
  regularMarketOpen: 108, regularMarketPreviousClose: 104.76, fiftyDayAverage: 100, twoHundredDayAverage: 90,
  fiftyTwoWeekHigh: 110, fiftyTwoWeekLow: 60, marketCap: 6e9, earningsTimestamp: NOW + 2 * 86400, ...extra,
});

test('buildRow: metrics from quote data', () => {
  const r = buildRow(base, quote(), null, NOW);
  assert.equal(r.p, 110);
  assert.equal(r.c, 5);
  assert.equal(r.rv, 3);
  assert.equal(r.d50, 10);
  assert.equal(r.d200, 22.22); // (110 - 90) / 90
  assert.equal(r.gap, 3.09);
  assert.equal(r.h52, 0);
  assert.equal(r.m, 6e9);
});

test('signals: new high, unusual volume, gap up, uptrend, earnings', () => {
  const r = buildRow(base, quote(), { rsi: 75, cross: { type: 'golden', daysAgo: 3 } }, NOW);
  for (const tag of ['new-high', 'unusual-volume', 'gap-up', 'uptrend', 'earnings', 'overbought', 'golden-cross']) {
    assert.ok(r.sig.includes(tag), `${tag} missing from ${r.sig}`);
  }
  assert.ok(!r.sig.includes('downtrend') && !r.sig.includes('new-low'));
});

test('signals: new low, gap down, downtrend, oversold', () => {
  const q = quote({ regularMarketPrice: 60, regularMarketOpen: 58, regularMarketPreviousClose: 64, fiftyDayAverage: 70, twoHundredDayAverage: 80, regularMarketVolume: 1e6 });
  const r = buildRow(base, q, { rsi: 22 }, NOW);
  for (const tag of ['new-low', 'gap-down', 'downtrend', 'oversold']) assert.ok(r.sig.includes(tag), `${tag} missing from ${r.sig}`);
  assert.ok(!r.sig.includes('unusual-volume'));
});

test('buildRow works with list data only (no quote, no history)', () => {
  const r = buildRow(base, null, null, NOW);
  assert.equal(r.p, 100);
  assert.equal(r.rv, null);
  assert.equal(r.rsi, null);
  assert.deepEqual(r.sig, []);
});

test('earnings more than a week away is not flagged', () => {
  assert.ok(!signals({ p: 1, er: NOW + 9 * 86400 }, NOW).includes('earnings'));
});

test('insights: breadth, participation, sectors', () => {
  const rows = [
    { c: 2, d50: 1, d200: 1, sec: 'Tech', m: 10, sig: ['new-high'] },
    { c: 1, d50: 1, d200: -1, sec: 'Tech', m: 10, sig: [] },
    { c: -1, d50: -1, d200: -1, sec: 'Energy', m: 10, sig: ['new-low', 'unusual-volume'] },
    ...Array.from({ length: 5 }, () => ({ c: 3, d50: 2, d200: 2, sec: 'Tech', m: 10, sig: [] })),
    ...Array.from({ length: 5 }, () => ({ c: -2, d50: -2, d200: -2, sec: 'Energy', m: 10, sig: [] })),
  ];
  const i = insights(rows);
  assert.equal(i.up, 7);
  assert.equal(i.down, 6);
  assert.equal(i.newHighs, 1);
  assert.equal(i.newLows, 1);
  assert.equal(i.unusualVolume, 1);
  assert.equal(i.sectors[0].sec, 'Tech');
  assert.ok(i.sectors[0].change > 0 && i.sectors.at(-1).change < 0);
  assert.equal(i.above50, 54);
});

const rows = [
  { s: 'AAA', p: 50, c: 6, rv: 3, m: 5e9, av: 2e6, sec: 'Tech', rsi: 60, r1m: 8, gap: 4, sig: ['unusual-volume', 'uptrend', 'gap-up'] },
  { s: 'BBB', p: 20, c: -7, rv: 1, m: 3e9, av: 1e6, sec: 'Energy', rsi: 25, r1m: -12, gap: -5, sig: ['oversold', 'downtrend', 'gap-down'] },
  { s: 'CCC', p: 300, c: 2, rv: 2.5, m: 4e11, av: 5e6, sec: 'Tech', rsi: 55, r1m: 3, gap: 0, sig: ['unusual-volume', 'uptrend'] },
  { s: 'DDD', p: 3, c: 9, rv: 0.5, m: 1e8, av: 5e4, sec: 'Health', rsi: null, r1m: null, gap: 1, sig: [] },
];

test('ideas: gainers largest first, losers smallest first', () => {
  assert.deepEqual(applyScreen(rows, { idea: 'gainers' }).map((r) => r.s), ['DDD', 'AAA', 'CCC']);
  assert.deepEqual(applyScreen(rows, { idea: 'losers' }).map((r) => r.s), ['BBB']);
});

test('ideas: unusual volume, uptrend, oversold, gaps', () => {
  assert.deepEqual(applyScreen(rows, { idea: 'unusual' }).map((r) => r.s), ['AAA', 'CCC']);
  assert.deepEqual(applyScreen(rows, { idea: 'uptrend' }).map((r) => r.s), ['AAA', 'CCC']);
  assert.deepEqual(applyScreen(rows, { idea: 'oversold' }).map((r) => r.s), ['BBB']);
  assert.deepEqual(applyScreen(rows, { idea: 'gaps' }).map((r) => r.s), ['BBB', 'AAA']);
});

test('filters: market cap, volume, sector, price', () => {
  assert.deepEqual(applyScreen(rows, { idea: 'all', cap: 2e9 }).map((r) => r.s), ['CCC', 'AAA', 'BBB']);
  assert.deepEqual(applyScreen(rows, { idea: 'all', vol: 1.5e6 }).map((r) => r.s), ['CCC', 'AAA']);
  assert.deepEqual(applyScreen(rows, { idea: 'all', sector: 'Tech' }).map((r) => r.s), ['CCC', 'AAA']);
  assert.deepEqual(applyScreen(rows, { idea: 'all', priceMin: 25 }).map((r) => r.s), ['CCC', 'AAA']);
});

test('clicked column sorting, with missing values last', () => {
  assert.deepEqual(applyScreen(rows, { idea: 'all' }, ['rsi', 1]).map((r) => r.s), ['BBB', 'CCC', 'AAA', 'DDD']);
  assert.deepEqual(applyScreen(rows, { idea: 'all' }, ['rsi', -1]).map((r) => r.s), ['AAA', 'CCC', 'BBB', 'DDD']);
  assert.deepEqual(applyScreen(rows, { idea: 'all' }, ['s', 1]).map((r) => r.s), ['AAA', 'BBB', 'CCC', 'DDD']);
});

test('every idea has a label, a hint and a sort', () => {
  for (const x of IDEAS) assert.ok(x.id && x.label && x.hint && x.sort?.length === 2, x.id);
});

test('market cap formatting', () => {
  assert.equal(fmtCap(3.2e12), '$3.20T');
  assert.equal(fmtCap(4.5e11), '$450B');
  assert.equal(fmtCap(2.15e9), '$2.1B');
  assert.equal(fmtCap(3.5e8), '$350M');
  assert.equal(fmtCap(null), '—');
});

test('other markets: the size filter works in dollars, caps show in their currency', () => {
  const rows = [
    { s: '7203.T', p: 3000, c: 1, m: 4e13, v: 1e7, sig: [] }, // about $260B at 0.0065
    { s: '9999.T', p: 500, c: 2, m: 1e11, v: 1e6, sig: [] }, // about $650M
  ];
  assert.deepEqual(applyScreen(rows, { idea: 'all', cap: 2e9, fx: 0.0065 }).map((r) => r.s), ['7203.T']);
  assert.deepEqual(applyScreen(rows, { idea: 'all', cap: 2e9, fx: null }).map((r) => r.s), ['7203.T', '9999.T']);
  assert.match(fmtCap(4e13, 'JPY'), /40/);
  assert.match(fmtCap(4e13, 'JPY'), /¥|JP/);
  assert.equal(fmtCap(2.5e12), '$2.50T');
});

test('no volume yet means unknown, not zero relative volume', () => {
  const r = buildRow({ s: '005930.KS', p: 100 }, { regularMarketPrice: 100, regularMarketVolume: 0, averageDailyVolume10Day: 1e6 });
  assert.equal(r.v, null);
  assert.equal(r.rv, null);
  assert.equal(r.av, 1e6);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
