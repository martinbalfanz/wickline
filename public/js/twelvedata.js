// Twelve Data (twelvedata.com): history, search and quotes for stocks, ETFs, forex and indices,
// called straight from the browser with the visitor's own free API key.
//
// Charts keep Yahoo-style symbols (AAPL, VOW3.DE, EURUSD=X, ^GSPC) so saved charts, the
// watchlist and Yahoo's live stream all keep working; they are translated here.

import { settings } from './env.js';
import { basePlan, aggregateSessions, sessionStart, guessSessionOpen } from './timeframes.js';

const BASE = 'https://api.twelvedata.com';

export class NeedsKeyError extends Error {
  constructor() {
    super('Stocks, ETFs, forex and indices need a free Twelve Data key on this site (crypto works without one).');
    this.code = 'NEEDS_KEY';
  }
}

// --- rate limiting (free plan: 8 requests per minute) --------------------------
const spent = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire(cost) {
  for (;;) {
    const now = Date.now();
    while (spent.length && now - spent[0] > 60500) spent.shift();
    const limit = Math.max(1, settings.tdRate);
    if (spent.length + cost <= limit || !spent.length) {
      for (let k = 0; k < cost; k++) spent.push(now);
      return;
    }
    await sleep(Math.max(250, 60500 - (now - spent[0])));
  }
}

async function tdGet(path, params, { cost = 1, key = true } = {}) {
  const apikey = settings.tdKey.trim();
  if (key && !apikey) throw new NeedsKeyError();
  if (key) await acquire(cost);
  const q = new URLSearchParams(params);
  if (key) q.set('apikey', apikey);
  const r = await fetch(`${BASE}${path}?${q}`);
  const j = await r.json().catch(() => null);
  if (!r.ok || !j || j.status === 'error' || (j.code && j.code >= 400)) {
    const err = new Error(j?.message ? `Twelve Data: ${j.message}` : `Twelve Data HTTP ${r.status}`);
    err.code = j?.code || r.status;
    throw err;
  }
  return j;
}

// --- symbol translation -------------------------------------------------------------
const SUFFIX_MIC = {
  DE: 'XETR', F: 'XFRA', L: 'XLON', PA: 'XPAR', AS: 'XAMS', BR: 'XBRU', MI: 'XMIL', MC: 'XMAD', SW: 'XSWX',
  CO: 'XCSE', ST: 'XSTO', HE: 'XHEL', OL: 'XOSL', VI: 'XWBO', LS: 'XLIS', IR: 'XDUB', WA: 'XWAR', T: 'XJPX',
  HK: 'XHKG', SS: 'XSHG', SZ: 'XSHE', KS: 'XKRX', KQ: 'XKOS', TW: 'XTAI', NS: 'XNSE', BO: 'XBOM', AX: 'XASX',
  NZ: 'XNZE', SI: 'XSES', TO: 'XTSE', V: 'XTSX', SA: 'BVMF', MX: 'XMEX', JK: 'XIDX', BK: 'XBKK', KL: 'XKLS',
  IS: 'XIST', TA: 'XTAE',
};
const MIC_SUFFIX = Object.fromEntries(Object.entries(SUFFIX_MIC).map(([s, m]) => [m, s]));
const US_MICS = new Set(['XNGS', 'XNAS', 'XNCM', 'XNMS', 'XNYS', 'ARCX', 'BATS', 'XASE', 'XNYSE', 'IEXG']);
const INDICES = { '^GSPC': 'SPX', '^NDX': 'NDX', '^DJI': 'DJI', '^IXIC': 'IXIC', '^RUT': 'RUT', '^VIX': 'VIX' };
const METALS = { 'GC=F': 'XAU/USD', 'SI=F': 'XAG/USD', 'PL=F': 'XPT/USD', 'PA=F': 'XPD/USD' };

/** Yahoo-style ticker → { symbol, mic_code? } for Twelve Data, or null if there is no equivalent. */
export function toTd(t) {
  if (INDICES[t]) return { symbol: INDICES[t] };
  if (METALS[t]) return { symbol: METALS[t] };
  if (/^[A-Z]{6}=X$/.test(t)) return { symbol: `${t.slice(0, 3)}/${t.slice(3, 6)}` };
  if (/^[A-Z]{3}=X$/.test(t)) return { symbol: `USD/${t.slice(0, 3)}` };
  if (/^[A-Z0-9]+-(USD|EUR|GBP|BTC|ETH)$/.test(t) && !/^[A-Z]{1,5}-[A-Z]$/.test(t)) {
    const [base, quote] = t.split('-');
    return { symbol: `${base}/${quote}` };
  }
  const m = /^(.+)\.([A-Z]{1,2})$/.exec(t);
  if (m && SUFFIX_MIC[m[2]]) return { symbol: m[1], mic_code: SUFFIX_MIC[m[2]] };
  if (t.startsWith('^') || t.includes('=')) return null; // other indices, futures: not on Twelve Data
  return { symbol: t.replace(/-/g, '.') }; // US share classes: BRK-B → BRK.B
}

/** A Twelve Data search row → Yahoo-style ticker, or null. */
function fromTd(row) {
  const type = row.instrument_type || '';
  if (type === 'Physical Currency') return row.symbol.includes('/') ? `${row.symbol.replace('/', '')}=X` : null;
  if (type === 'Digital Currency') return null; // crypto comes from the exchanges directly
  const idx = Object.entries(INDICES).find(([, v]) => v === row.symbol);
  if (type === 'Index') return idx ? idx[0] : null;
  if (US_MICS.has(row.mic_code) || row.country === 'United States') return row.symbol.replace(/\./g, '-');
  const suffix = MIC_SUFFIX[row.mic_code];
  return suffix ? `${row.symbol}.${suffix}` : null;
}

// Twelve Data's intervals are in timeframes.js (NATIVE.twelvedata); others are grouped from them.

/** Current offset (seconds) of a time zone from UTC. */
export function tzOffset(tz) {
  if (!tz) return 0;
  try {
    const now = new Date();
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(now).map((x) => [x.type, x.value]));
    return Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - now.getTime()) / 1000);
  } catch {
    return 0;
  }
}

/** "2026-11-12 15:55:00" (exchange time) → chart time; the chart shows exchange time as if it were UTC. */
const parseTime = (s) => {
  const [d, t = '00:00:00'] = s.split(' ');
  const [y, mo, da] = d.split('-').map(Number);
  const [h, mi, se] = t.split(':').map(Number);
  return Date.UTC(y, mo - 1, da, h, mi, se || 0) / 1000;
};
const formatTime = (sec, daily) => {
  const d = new Date(sec * 1000);
  const p = (x) => String(x).padStart(2, '0');
  const date = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return daily ? date : `${date} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};
const decimals = (s) => { const x = String(s).replace(/0+$/, ''); const i = x.indexOf('.'); return i < 0 ? 0 : x.length - i - 1; };
/** Display decimals: pairs (forex, metals) up to 5; stocks 2, or 4 below 1. */
const precisionFor = (pair, closes) => {
  if (pair) return Math.min(5, Math.max(2, ...closes.map(decimals)));
  const last = +closes[closes.length - 1];
  return last > 0 && last < 1 ? 4 : 2;
};

/**
 * Price history. Returns { meta, bars }. `before` (chart time) fetches the bars before it.
 * `since` (chart time, the start of the current day): for the live poll of a grouped timeframe.
 * `open`: the session open (seconds after midnight, meta.sessionOpen of the first answer), so
 * later answers group bars on the same grid.
 */
export async function tdBars(ticker, tf, { before = null, outputsize = 5000, since = null, open = null } = {}) {
  const sym = toTd(ticker);
  if (!sym) throw new Error(`${ticker} isn't available from Twelve Data. Futures and some indices need the optional server.`);
  // A timeframe Twelve Data doesn't have (10m, 3h) comes from a smaller interval, grouped by
  // session. A short request (the live poll) then still needs the whole current session: from
  // the day's start when the caller knows it, else a day's worth of the small bars.
  const plan = basePlan(tf, 'twelvedata');
  const fromDay = plan.agg && since != null && before == null;
  if (fromDay) outputsize = 5000; // up to the dates asked for
  else if (plan.agg) outputsize = Math.min(5000, Math.max(outputsize, Math.ceil(86400 / plan.base.sec) + 2 * plan.factor));
  const params = { ...sym, interval: plan.native, outputsize: String(outputsize), order: 'ASC' };
  // Pairs (forex, metals, crypto) have no exchange; without this Twelve Data uses Sydney time.
  const pair = sym.symbol.includes('/');
  if (pair) params.timezone = 'UTC';
  if (fromDay) params.start_date = formatTime(since, false); // exchange time (UTC for pairs), like end_date
  if (before != null) params.end_date = formatTime(before - (tf.daily ? 86400 : 1), tf.daily);
  const j = await tdGet('/time_series', params);
  const values = j.values || [];
  let bars = values.map((v) => ({
    time: parseTime(v.datetime), open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +(v.volume || 0),
  })).filter((b) => Number.isFinite(b.close));
  bars.sort((a, b) => a.time - b.time);
  const full = values.length >= outputsize;
  // Twelve Data has the regular session only, in exchange time: the earliest first bar of a day
  // is the open. Grouped bars restart there each day (a late first trade doesn't move the grid);
  // a first bucket cut off by outputsize is dropped, so loading older bars completes it.
  const sessionOpen = tf.daily ? null : open ?? guessSessionOpen(bars);
  if (plan.agg) {
    const anchor = sessionOpen == null ? null : (t) => sessionStart(t, sessionOpen);
    bars = aggregateSessions(bars, tf.sec, { anchor, trimFirst: !anchor || (full && !fromDay) });
  }
  const m = j.meta || {};
  const precision = precisionFor(pair, values.slice(-50).map((v) => v.close));
  return {
    meta: {
      symbol: ticker,
      name: m.currency_base && m.currency_quote ? `${m.currency_base} / ${m.currency_quote}` : ticker,
      exchange: m.exchange || (m.type === 'Physical Currency' ? 'Forex' : ''),
      currency: m.currency || '',
      type: m.type || '',
      precision,
      tzOffset: pair ? 0 : tzOffset(m.exchange_timezone),
      sessionOpen,
    },
    bars,
    full,
  };
}

const CATEGORY = { 'Common Stock': 'stocks', 'Depositary Receipt': 'stocks', 'American Depositary Receipt': 'stocks', 'Preferred Stock': 'stocks',
  ETF: 'funds', 'Mutual Fund': 'funds', Index: 'indices', 'Physical Currency': 'forex' };

/** Symbol search (works without a key). */
export async function tdSearch(q) {
  const j = await tdGet('/symbol_search', { symbol: q, outputsize: '30' }, { key: false });
  const seen = new Set();
  const out = [];
  for (const row of j.data || []) {
    const t = fromTd(row);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push({
      full: `YAHOO:${t}`, ticker: t, name: row.instrument_name || t, exchange: row.exchange || '',
      type: row.instrument_type || '', category: CATEGORY[row.instrument_type] || 'stocks',
    });
  }
  return out;
}

/** Last price, previous close and change for up to ~8 symbols per request (each costs one credit). */
export async function tdQuotes(tickers) {
  const out = [];
  const plain = [], withMic = [];
  for (const t of tickers) {
    const s = toTd(t);
    if (!s) continue;
    (s.mic_code ? withMic : plain).push([t, s]);
  }
  const parse = (t, q) => {
    const price = +q.close, prev = +q.previous_close;
    if (!Number.isFinite(price)) return;
    out.push({ symbol: t, name: q.name, price, prevClose: Number.isFinite(prev) ? prev : null,
      change: Number.isFinite(+q.percent_change) ? +q.percent_change : null, precision: precisionFor(String(q.symbol || '').includes('/'), [q.close]) });
  };
  for (let i = 0; i < plain.length; i += 8) {
    const chunk = plain.slice(i, i + 8);
    try {
      const j = await tdGet('/quote', { symbol: chunk.map(([, s]) => s.symbol).join(',') }, { cost: chunk.length });
      if (chunk.length === 1) parse(chunk[0][0], j);
      else for (const [t, s] of chunk) if (j[s.symbol] && j[s.symbol].status !== 'error') parse(t, j[s.symbol]);
    } catch (e) {
      if (e.code === 'NEEDS_KEY') throw e;
    }
  }
  for (const [t, s] of withMic) {
    try { parse(t, await tdGet('/quote', s)); } catch (e) { if (e.code === 'NEEDS_KEY') throw e; }
  }
  return out;
}

/** Checks a key with one cheap request. */
export async function tdCheckKey(key) {
  const r = await fetch(`${BASE}/api_usage?apikey=${encodeURIComponent(key)}`);
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.status === 'error' || (j?.code && j.code >= 400)) throw new Error(j?.message || `HTTP ${r.status}`);
  return j; // { current_usage, plan_limit, plan_category, ... }
}
