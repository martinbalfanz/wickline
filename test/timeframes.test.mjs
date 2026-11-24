// Tests for timeframes (public/js/timeframes.js): parsing what people type, labels, which of a
// source's own intervals each timeframe is built from, and grouping bars (history and live).
import assert from 'node:assert/strict';
import {
  parseTf, tfById, tfIdOf, makeTf, TF_GROUPS, basePlan, yahooPlan, utcBucket, aggregateUtc, aggregateSessions,
  sessionStart, guessSessionOpen,
} from '../public/js/timeframes.js';
import { createFeed } from '../public/js/datafeed.js';

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};

const id = (text) => parseTf(text)?.id ?? null;
const utc = (s) => Date.parse(`${s}Z`) / 1000; // '2026-11-23T09:30' → seconds
const bar = (time, o, h, l, c, v = 1) => ({ time, open: o, high: h, low: l, close: c, volume: v });

test('plain numbers are minutes, whole hours become hours', () => {
  assert.equal(id('45'), '45m');
  assert.equal(id('1'), '1m');
  assert.equal(id('60'), '1h');
  assert.equal(id('90'), '90m');
  assert.equal(id('240'), '4h');
  assert.equal(id('720'), '12h');
  assert.equal(id('1440'), '1D');
  assert.equal(id('05'), '5m');
  assert.equal(id('0'), null);
  assert.equal(id('1441'), null);
  assert.equal(id('99999'), null);
});

test('units: m is minutes, M months; h, D, W in either case', () => {
  assert.equal(id('45m'), '45m');
  assert.equal(id('45min'), '45m');
  assert.equal(id('1m'), '1m');
  assert.equal(id('1M'), '1M');
  assert.equal(id('M'), '1M');
  assert.equal(id('m'), '1m');
  assert.equal(id('4h'), '4h');
  assert.equal(id('4H'), '4h');
  assert.equal(id('h'), '1h');
  assert.equal(id('2 hours'), '2h');
  assert.equal(id('24h'), '1D');
  assert.equal(id('D'), '1D');
  assert.equal(id('d'), '1D');
  assert.equal(id('1D'), '1D');
  assert.equal(id('W'), '1W');
  assert.equal(id('1w'), '1W');
  assert.equal(id('1mo'), '1M');
  assert.equal(id(' 3 m '), '3m');
});

test('things that are not timeframes', () => {
  for (const t of ['', '  ', '25h', '2D', '3W', '6M', '30s', '1.5h', 'abc', '7203.T', '0700.HK', 'AAPL', '4hh', '-5', null, undefined]) {
    assert.equal(id(t), null, String(t));
  }
});

test('saved ids from older versions keep working unchanged', () => {
  for (const old of ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1D', '1W', '1M']) assert.equal(tfIdOf(old), old);
  assert.equal(tfById('nonsense').id, '1h'); // as before
  assert.equal(tfById('1M').sec, 2629800);
  assert.equal(tfById('1W').sec, 604800);
  assert.equal(tfById('1D').daily, true);
  assert.equal(tfById('4h').daily, false);
});

test('labels for the header and the interval box', () => {
  const lab = (t) => [tfById(t).label, tfById(t).long];
  assert.deepEqual(lab('1m'), ['1m', '1 minute']);
  assert.deepEqual(lab('45m'), ['45m', '45 minutes']);
  assert.deepEqual(lab('1h'), ['1H', '1 hour']);
  assert.deepEqual(lab('4h'), ['4H', '4 hours']);
  assert.deepEqual(lab('1D'), ['D', '1 day']);
  assert.deepEqual(lab('1W'), ['W', '1 week']);
  assert.deepEqual(lab('1M'), ['M', '1 month']);
  assert.equal(makeTf(90, 'm').sec, 5400);
});

test('the menu lists the common timeframes, all valid and in order', () => {
  const all = TF_GROUPS.flatMap((g) => g.ids);
  assert.deepEqual(TF_GROUPS.map((g) => g.title), ['Minutes', 'Hours', 'Days']);
  assert.equal(all.length, 18);
  for (const g of TF_GROUPS) {
    const secs = g.ids.map((x) => tfById(x).sec);
    assert.ok(g.ids.every((x) => tfIdOf(x) === x), g.title);
    assert.deepEqual(secs, [...secs].sort((a, b) => a - b), g.title);
  }
});

test('base interval: the source\'s own when it has it, else the largest that divides', () => {
  const plan = (t, src) => { const p = basePlan(tfById(t), src); return `${p.native}×${p.factor}${p.agg ? '' : ' native'}`; };
  // Binance: 1m 3m 5m 15m 30m 1h 2h 4h 6h 8h 12h 1d 1w 1M
  assert.equal(plan('10m', 'binance'), '5m×2');
  assert.equal(plan('2m', 'binance'), '1m×2');
  assert.equal(plan('3m', 'binance'), '3m×1 native');
  assert.equal(plan('45m', 'binance'), '15m×3');
  assert.equal(plan('90m', 'binance'), '30m×3');
  assert.equal(plan('3h', 'binance'), '1h×3');
  assert.equal(plan('6h', 'binance'), '6h×1 native');
  assert.equal(plan('10h', 'binance'), '2h×5');
  assert.equal(plan('1W', 'binance'), '1w×1 native');
  // Coinbase: 1m 5m 15m 1h 6h 1D (granularity seconds)
  assert.equal(plan('30m', 'coinbase'), '900×2');
  assert.equal(plan('12h', 'coinbase'), '21600×2');
  assert.equal(plan('8h', 'coinbase'), '3600×8');
  assert.equal(plan('1W', 'coinbase'), '86400×7');
  assert.equal(basePlan(tfById('1M'), 'coinbase').agg, 'M');
  // Yahoo: deeper history wins (1m keeps 7 days, 2m–30m 60 days, 60m two years)
  assert.equal(plan('3m', 'yahoo'), '1m×3');
  assert.equal(plan('6m', 'yahoo'), '2m×3');
  assert.equal(plan('10m', 'yahoo'), '5m×2');
  assert.equal(plan('45m', 'yahoo'), '15m×3');
  assert.equal(plan('90m', 'yahoo'), '30m×3');
  assert.equal(plan('3h', 'yahoo'), '60m×3');
  assert.equal(plan('12h', 'yahoo'), '60m×12');
  // Twelve Data: 1min 5min 15min 30min 45min 1h 2h 4h 8h 1day 1week 1month
  assert.equal(plan('45m', 'twelvedata'), '45min×1 native');
  assert.equal(plan('90m', 'twelvedata'), '45min×2');
  assert.equal(plan('10m', 'twelvedata'), '5min×2');
  assert.equal(plan('3h', 'twelvedata'), '1h×3');
  assert.equal(plan('6h', 'twelvedata'), '2h×3');
  assert.equal(plan('16h', 'twelvedata'), '8h×2');
  // Every common timeframe works on every source.
  for (const t of TF_GROUPS.flatMap((g) => g.ids)) {
    for (const src of ['binance', 'coinbase', 'yahoo', 'twelvedata']) assert.ok(basePlan(tfById(t), src).native, `${t} on ${src}`);
  }
});

test('Yahoo requests: the old timeframes ask for what they did, new ones fit Yahoo\'s limits', () => {
  assert.deepEqual(yahooPlan(tfById('1m')), { interval: '1m', range: '7d', live: '1d', spacing: 60 });
  assert.deepEqual(yahooPlan(tfById('15m')), { interval: '15m', range: '60d', live: '1d', spacing: 900 });
  assert.deepEqual(yahooPlan(tfById('1h')), { interval: '60m', range: '730d', live: '5d', spacing: 3600 });
  assert.deepEqual(yahooPlan(tfById('4h')), { interval: '60m', range: '730d', live: '5d', spacing: 3600, aggregate: 14400 });
  assert.deepEqual(yahooPlan(tfById('1D')), { interval: '1d', full: true, live: '5d', spacing: 86400, daily: true });
  assert.deepEqual(yahooPlan(tfById('1M')), { interval: '1mo', full: true, live: '3mo', spacing: 28 * 86400, daily: true });
  assert.deepEqual(yahooPlan(tfById('45m')), { interval: '15m', range: '60d', live: '1d', spacing: 900, aggregate: 2700 });
  assert.deepEqual(yahooPlan(tfById('2m')), { interval: '2m', range: '60d', live: '1d', spacing: 120 });
  assert.deepEqual(yahooPlan(tfById('90m')), { interval: '30m', range: '60d', live: '1d', spacing: 1800, aggregate: 5400 });
});

test('crypto bar grid: restarts at 00:00 UTC each day, weeks on Monday, months on the 1st', () => {
  const b = (s, t) => new Date(utcBucket(utc(s), tfById(t)) * 1000).toISOString().slice(0, 16);
  assert.equal(b('2026-11-23T09:37', '10m'), '2026-11-23T09:30');
  assert.equal(b('2026-11-23T09:37', '45m'), '2026-11-23T09:00');
  assert.equal(b('2026-11-23T23:59', '5h'), '2026-11-23T20:00'); // 5h doesn't divide a day: last bar is 4h
  assert.equal(b('2026-11-24T00:10', '5h'), '2026-11-24T00:00');
  assert.equal(b('2026-11-23T09:37', '1D'), '2026-11-23T00:00');
  assert.equal(b('2026-11-26T09:37', '1W'), '2026-11-23T00:00'); // Thursday → Monday
  assert.equal(b('2026-11-26T09:37', '1M'), '2026-11-01T00:00');
});

test('grouping crypto bars: OHLCV, and a first bar missing its start is dropped', () => {
  const t0 = utc('2026-11-23T09:05');
  const five = [
    bar(t0, 10, 12, 9, 11, 1), // 09:05 belongs to 09:00–09:10, whose first 5 minutes aren't here
    bar(t0 + 300, 11, 15, 10, 14, 2), bar(t0 + 600, 14, 14, 8, 9, 3), // 09:10–09:20
    bar(t0 + 900, 9, 10, 7, 8, 4), bar(t0 + 1200, 8, 20, 8, 19, 5), // 09:20–09:30
    bar(t0 + 1500, 19, 19, 18, 18, 6), // 09:30, running
  ];
  const out = aggregateUtc(five, tfById('10m'));
  assert.deepEqual(out, [
    { time: utc('2026-11-23T09:10'), open: 11, high: 15, low: 8, close: 9, volume: 5 },
    { time: utc('2026-11-23T09:20'), open: 9, high: 20, low: 7, close: 19, volume: 9 },
    { time: utc('2026-11-23T09:30'), open: 19, high: 19, low: 18, close: 18, volume: 6 },
  ]);
  assert.deepEqual(aggregateUtc([], tfById('10m')), []);
});

test('grouping stock bars: by session from each day\'s first bar', () => {
  // Two US sessions of 15m bars, 9:30–16:00 (exchange time), → 45m bars.
  const day = (d) => Array.from({ length: 26 }, (_, i) => bar(utc(`2026-11-${d}T09:30`) + i * 900, 100 + i, 101 + i, 99 + i, 100.5 + i));
  const out = aggregateSessions([...day(19), ...day(20)], 2700);
  const times = out.map((b) => new Date(b.time * 1000).toISOString().slice(8, 16).replace('T', ' '));
  assert.deepEqual(times.slice(0, 10), ['19 09:30', '19 10:15', '19 11:00', '19 11:45', '19 12:30', '19 13:15', '19 14:00', '19 14:45', '19 15:30', '20 09:30']);
  assert.equal(out.length, 18);
  assert.deepEqual({ ...out[0] }, { time: utc('2026-11-19T09:30'), open: 100, high: 103, low: 99, close: 102.5, volume: 3 });
  assert.equal(out[8].volume, 2); // 15:30–16:00 is a half bar
});

test('grouping stock bars: a first day cut mid-session lines up with the next day', () => {
  // A 24-hour market whose history starts at 13:05: 13:05–13:30 is part of the 12:45 bar → dropped.
  const bars = [];
  for (let t = utc('2026-11-19T13:05'); t < utc('2026-11-21T00:00'); t += 300) bars.push(bar(t, 1, 2, 0.5, 1.5));
  const out = aggregateSessions(bars, 2700);
  assert.equal(new Date(out[0].time * 1000).toISOString().slice(11, 16), '13:30');
  assert.ok(out.every((b) => ((b.time % 86400) % 2700) === 0), 'all on the midnight grid');
  assert.equal(out[0].volume, 9);
});

test('Binance 10m from the 5m kline stream keeps the current 10m candle right', () => {
  const feed = createFeed('BINANCE:BTCUSDT', tfById('10m'));
  assert.equal(feed.interval, '5m');
  const k = (s, o, h, l, c, v) => bar(utc(s), o, h, l, c, v);
  // History ends inside the 10:00 bar: its first kline (10:00) is done, 10:05 is running.
  feed.remember([k('2026-11-23T09:50', 1, 1, 1, 1, 1), k('2026-11-23T09:55', 1, 1, 1, 1, 1), k('2026-11-23T10:00', 100, 110, 95, 105, 10), k('2026-11-23T10:05', 105, 106, 104, 105, 1)]);
  const live = () => { const b = feed.liveBar(); return { ...b, time: b.time - feed.shift }; };
  assert.deepEqual(live(), { time: utc('2026-11-23T10:00'), open: 100, high: 110, low: 95, close: 105, volume: 11 });
  // Stream updates of the running kline (cumulative, as Binance sends them).
  feed.remember([k('2026-11-23T10:05', 105, 120, 104, 118, 4)]);
  assert.deepEqual(live(), { time: utc('2026-11-23T10:00'), open: 100, high: 120, low: 95, close: 118, volume: 14 });
  // An older, smaller copy of the same kline (e.g. from a slow REST reply) doesn't undo it.
  feed.remember([k('2026-11-23T10:05', 105, 106, 104, 105, 1)]);
  assert.equal(live().close, 118);
  // Next 10m bar: starts fresh from its first kline.
  feed.remember([k('2026-11-23T10:10', 118, 119, 117, 117.5, 2)]);
  assert.deepEqual(live(), { time: utc('2026-11-23T10:10'), open: 118, high: 119, low: 117, close: 117.5, volume: 2 });
  // A late update of the previous bar's last kline is ignored.
  feed.remember([k('2026-11-23T10:05', 105, 121, 104, 119, 5)]);
  assert.equal(live().time, utc('2026-11-23T10:10'));
  assert.equal(live().open, 118);
  // History bars are grouped on the same grid, in the viewer's time.
  const chart = feed.toChart([k('2026-11-23T10:00', 1, 2, 0, 1, 1), k('2026-11-23T10:05', 1, 3, 1, 2, 1), k('2026-11-23T10:10', 2, 2, 2, 2, 1)]);
  assert.deepEqual(chart.map((b) => b.time - feed.shift), [utc('2026-11-23T10:00'), utc('2026-11-23T10:10')]);
  // Live trades land in the right bar, also across 00:00 UTC for sizes that don't divide a day.
  const five = createFeed('BINANCE:BTCUSDT', tfById('5h'));
  assert.equal(five.bucketOf(utc('2026-11-24T00:00:30') + five.shift) - five.shift, utc('2026-11-24T00:00'));
  assert.equal(createFeed('BINANCE:BTCUSDT', tfById('1D')).bucketOf, null); // the chart handles daily bars
});

// Binance history for grouped timeframes: pages of 1000 (futures weigh 10 above that), two at a
// time, no more after a short page, and a pause after 429/418. Fake exchange: 1m klines from `start`.
await (async () => {
  const name = 'Binance history pages: 1000 a page, two at a time, stop at the start, back off on 429';
  const realFetch = globalThis.fetch;
  try {
    const MIN = 60000;
    const now = Math.floor(Date.now() / MIN) * MIN;
    let start = 0, urls = [], inflight = 0, most = 0, answer = null;
    globalThis.fetch = async (url) => {
      const n = urls.push(url);
      inflight++; most = Math.max(most, inflight);
      await new Promise((r) => setTimeout(r, 2));
      inflight--;
      const special = answer?.(n);
      if (special) return { ok: false, status: special.status, json: async () => ({ msg: 'slow down' }), headers: { get: (h) => (h === 'Retry-After' ? special.retryAfter : null) } };
      const q = new URL(url).searchParams;
      const limit = Number(q.get('limit'));
      const last = Math.min(now, Math.floor(Number(q.get('endTime') ?? now) / MIN) * MIN);
      const rows = [];
      for (let t = last; t >= start && rows.length < limit; t -= MIN) rows.unshift([t, '1', '1', '1', '1', '1']);
      return { ok: true, status: 200, json: async () => rows, headers: { get: () => null } };
    };
    // Plenty of history: 6 pages of 1m klines for 7m bars, contiguous; the newest alone, then two
    // at a time, placed by the exchange's newest kline even when this computer's clock is off.
    start = now - 100000 * MIN;
    const realNow = Date.now;
    let feed, raw;
    for (const skew of [0, -180000, 240000]) {
      Date.now = () => realNow() + skew;
      urls = []; most = 0;
      feed = createFeed('BINANCEF:BTCUSDT', tfById('7m'));
      assert.equal(feed.pages, 6);
      raw = await feed.fetchRaw(null);
      Date.now = realNow;
      assert.equal(urls.length, 6);
      assert.ok(!/endTime/.test(urls[0]) && urls.slice(1).every((u) => /endTime/.test(u)), urls.join(' '));
      assert.ok(urls.every((u) => /fapi\/v1\/klines\?.*limit=1000/.test(u)), urls[0]);
      assert.equal(most, 2);
      assert.equal(raw.length, 6000, `skew ${skew}`);
      assert.ok(raw.every((b, i) => !i || b.time - raw[i - 1].time === 60), `oldest first, no gaps or repeats (skew ${skew})`);
      assert.equal(raw.at(-1).time, now / 1000);
      assert.equal(feed.canLoadMore, true);
    }
    // Scrolling back continues before the oldest kline.
    urls = [];
    const older = await feed.fetchRaw(raw[0].time * 1000 - 1);
    assert.equal(older.at(-1).time, raw[0].time - 60);
    assert.equal(older.length, 6000);
    // History starting 1500 minutes ago: the second page is short, so no more pages are asked for.
    start = now - 1500 * MIN;
    urls = [];
    feed = createFeed('BINANCEF:BTCUSDT', tfById('7m'));
    raw = await feed.fetchRaw(null);
    assert.equal(urls.length, 3); // the newest, then a pair: 500 klines and none
    assert.equal(raw.length, 1501);
    assert.equal(feed.canLoadMore, false);
    // A failure after the first pages keeps the pages that came.
    start = now - 100000 * MIN;
    urls = [];
    answer = (n) => (n === 4 ? { status: 500 } : null);
    raw = await createFeed('BINANCEF:BTCUSDT', tfById('7m')).fetchRaw(null);
    assert.equal(raw.length, 3000);
    await new Promise((r) => setTimeout(r, 20)); // the failed pair's other request finishes
    // 429 (spot: from both hosts): no more requests to that market until Retry-After has passed.
    urls = [];
    answer = () => ({ status: 429, retryAfter: '30' });
    feed = createFeed('BINANCE:BTCUSDT', tfById('7m'));
    await assert.rejects(feed.fetchRaw(null), (e) => e.status === 429);
    const asked = urls.length;
    assert.ok(asked >= 2 && asked <= 4, String(asked));
    await assert.rejects(feed.fetchRaw(null), (e) => e.status === 429);
    assert.equal(urls.length, asked, 'nothing sent while backing off');
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  } finally {
    globalThis.fetch = realFetch;
  }
})();

// After a reconnect a grouped timeframe fetches its newest bar's klines again; until that works
// the bar gets no official updates, so a failure is retried.
await (async () => {
  const name = 'Binance grouped live bar: the klines fetch after a reconnect is retried until it works';
  const realFetch = globalThis.fetch, realWs = globalThis.WebSocket;
  try {
    let calls = 0;
    const kline = () => { const t = Math.floor(Date.now() / 300000) * 300000; return [[t, '1', '2', '0.5', '1.5', '3']]; };
    globalThis.fetch = async () => (++calls === 1
      ? { ok: false, status: 500, json: async () => ({}), headers: { get: () => null } }
      : { ok: true, status: 200, json: async () => kline(), headers: { get: () => null } });
    const sockets = [];
    globalThis.WebSocket = class { constructor(url) { this.url = url; sockets.push(this); } close() { this.onclose?.(); } };
    const feed = createFeed('BINANCEF:ETHUSDT', tfById('10m'));
    const got = [];
    feed.subscribe({ bars: (b) => got.push(...b), tick: () => {}, status: () => {} });
    sockets[0].onopen(); // not seeded (no history loaded): the fetch fails once
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls, 1);
    assert.equal(feed.seeded, false);
    await new Promise((r) => setTimeout(r, 2200)); // retried after 2 s
    assert.equal(calls, 2);
    assert.equal(feed.seeded, true);
    assert.equal(got.at(-1)?.close, 1.5);
    feed.close();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  } finally {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWs;
  }
})();

test('stock sessions: grouped bars restart at the open, a late first trade keeps the grid', () => {
  const open = 9.5 * 3600;
  // An illiquid stock: 5m bars whose first trade each day comes late (09:50, 09:35).
  const bars = ['2026-11-19T09:50', '2026-11-19T10:05', '2026-11-19T15:55', '2026-11-20T09:35', '2026-11-20T09:40', '2026-11-20T10:20']
    .map((s, i) => bar(utc(s), i, i, i, i));
  const anchor = (t) => sessionStart(t, open);
  const hm = (out) => out.map((b) => new Date(b.time * 1000).toISOString().slice(8, 16).replace('T', ' '));
  assert.deepEqual(hm(aggregateSessions(bars, 600, { anchor })), ['19 09:50', '19 10:00', '19 15:50', '20 09:30', '20 09:40', '20 10:20']);
  assert.deepEqual(hm(aggregateSessions(bars, 1500, { anchor })), ['19 09:30', '19 09:55', '19 15:45', '20 09:30', '20 10:20']);
  // Without an anchor: days start at their first bar (09:35 here), and the first bucket is dropped.
  assert.deepEqual(hm(aggregateSessions(bars, 1500)), ['19 10:00', '19 15:50', '20 09:35', '20 10:00']);
  // Trading-period starts win, and a day they miss falls back to the time of day.
  const starts = [utc('2026-11-19T09:30')];
  assert.equal(sessionStart(utc('2026-11-19T12:00'), null, starts), utc('2026-11-19T09:30'));
  assert.equal(sessionStart(utc('2026-11-20T12:00'), null, starts), null);
  assert.equal(sessionStart(utc('2026-11-20T12:00'), open, starts), utc('2026-11-20T09:30'));
  assert.equal(sessionStart(utc('2026-11-20T02:00'), 18 * 3600), utc('2026-11-19T18:00')); // a session that crosses midnight
  assert.equal(guessSessionOpen(bars), 9.5 * 3600 + 300); // earliest first bar of a day: 09:35
});

test('a stock feed starts the first live bar of a new session at the open', () => {
  const feed = createFeed('YAHOO:AAPL', tfById('25m'));
  feed.sessionOpen = 9.5 * 3600;
  const last = utc('2026-11-19T15:45');
  assert.equal(feed.bucketOf(utc('2026-11-20T09:30:05'), last), utc('2026-11-20T09:30')); // not yesterday's grid (09:15)
  assert.equal(feed.bucketOf(utc('2026-11-20T09:56'), last), utc('2026-11-20T09:55'));
  assert.equal(feed.bucketOf(utc('2026-11-20T10:00'), utc('2026-11-20T09:55')), null); // same session: the chart's rule
  feed.sessionOpen = null;
  assert.equal(feed.bucketOf(utc('2026-11-20T09:30:05'), last), null);
  assert.equal(createFeed('YAHOO:AAPL', tfById('1D')).bucketOf(utc('2026-11-20T09:30'), last), null);
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
