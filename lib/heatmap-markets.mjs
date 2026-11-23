// The heatmap's markets beyond US stocks (those come from /api/screener):
//  - Crypto: the largest coins by market cap from CoinGecko's free API (no key), without
//    stablecoins, wrapped/staked copies and tokenized stocks, funds or gold. Charts open on the
//    coin's Binance USDT pair when it has one, else on Yahoo ("YAHOO:BTC-USD").
//  - Stock markets outside the US (lib/markets.mjs): the largest companies on each market's
//    exchanges from Yahoo's screener, grouped by Yahoo's sectors, sized by market cap in the
//    market's own currency.
// Pure shaping functions first (unit-tested in test/heatmap-markets.test.mjs), then the fetching
// and caching behind server.mjs's /api/heatmap?market=...

import { gzipSync } from 'node:zlib';
import { MARKETS, companyKey } from './markets.mjs';
import { technicals } from './screener.mjs';

const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const num = (v) => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Market id → name, for the markets this module serves. */
export const HEATMAP_MARKETS = {
  crypto: 'Crypto',
  GB: 'United Kingdom', DE: 'Germany', FR: 'France', NL: 'Netherlands', IT: 'Italy', ES: 'Spain', CH: 'Switzerland',
  SE: 'Sweden', JP: 'Japan', CN: 'China', HK: 'Hong Kong', KR: 'South Korea', TW: 'Taiwan', IN: 'India',
  CA: 'Canada', AU: 'Australia', BR: 'Brazil',
};

// ---------------------------------------------------------------------------
// Stock markets
// ---------------------------------------------------------------------------

/** Yahoo's sectors (its screener can filter on them). */
export const SECTORS = ['Technology', 'Financial Services', 'Healthcare', 'Consumer Cyclical', 'Industrials',
  'Communication Services', 'Consumer Defensive', 'Energy', 'Basic Materials', 'Real Estate', 'Utilities'];

const MINOR = { GBp: 'GBP', GBX: 'GBP', ZAc: 'ZAR', ILA: 'ILS' };
const major = (c) => MINOR[c] || c;

/** The currency a market's prices are quoted in, and the one its market caps are in (London: pence, pounds). */
export const marketCurrency = (code) => ({ cur: MARKETS[code].cur, capCur: major(MARKETS[code].cur) });

// The euro markets' companies, strictly (lib/markets.mjs counts the whole euro area as home for news).
const HOME = { DE: ['Germany'], FR: ['France', 'Monaco'], NL: ['Netherlands'], IT: ['Italy'], ES: ['Spain'] };
// Where companies are registered rather than run: says nothing about their home market.
const HAVENS = new Set(['?', 'Ireland', 'Bermuda', 'Cayman Islands', 'Luxembourg', 'Jersey', 'Guernsey', 'Isle of Man',
  'British Virgin Islands', 'Bahamas', 'Panama', 'Marshall Islands', 'Curacao', 'Cyprus']);

// A company's own listing trades every day; foreign companies' lines (Apple in Frankfurt, US
// stocks' Canadian and Brazilian receipts, Airbus in Madrid) and spare share classes hardly do.
// Turnover: average value traded a day as a share of the market cap.
export const MIN_TURNOVER = 4e-5; // 0.004 % a day
const FOREIGN_TURNOVER = 3e-4; // a foreign company traded at least this much here counts as local (Stellantis in Milan)

// Funds Yahoo lists as stocks (Brazil's real-estate funds, "FII").
const FUND = /\b(fundo|fund|fii|fiagro)\b/i;

/** Average daily value traded / market cap (prices in pence count as 1/100 pound). */
export function turnover(q) {
  const px = q.currency && MINOR[q.currency] ? q.regularMarketPrice / 100 : q.regularMarketPrice;
  const v = q.averageDailyVolume3Month || q.averageDailyVolume10Day || 0;
  return q.marketCap > 0 && px > 0 ? (v * px) / q.marketCap : 0;
}

/** True when the US list (Nasdaq's countries, lib/markets.mjs usCountries) says this company is from elsewhere. */
function foreignHere(name, code, us) {
  const k = companyKey(name);
  // Nasdaq's names for depositary receipts often keep "Sponsored" ("Nokia Corporation Sponsored").
  const set = us?.get(k) || us?.get(`${k} sponsored`);
  if (!set) return false;
  const home = HOME[code] || MARKETS[code].home;
  return ![...set].some((c) => home.includes(c) || HAVENS.has(c));
}

/**
 * Yahoo screener quotes from one market's exchanges → its own companies, largest first, one line
 * each (the most traded share class): [{ s, n, sec, p, c, y1, m }]. m: market cap in the market's
 * currency (pounds for London). sectors: Map symbol → Yahoo sector ('Other' when unknown).
 */
export function shapeStocks(quotes, code, { us = null, sectors = null } = {}) {
  const mk = MARKETS[code];
  const best = new Map(); // company key -> { q, t }
  for (const q of quotes || []) {
    const s = q?.symbol;
    const n = q?.longName || q?.shortName || '';
    if (!s || !n || (q.quoteType && q.quoteType !== 'EQUITY') || mk.skip?.test(s) || FUND.test(n)) continue;
    if (q.currency && major(q.currency) !== major(mk.cur)) continue; // dollar GDRs in London, B shares in Shenzhen
    if (!(q.marketCap > 0) || !(q.regularMarketPrice > 0)) continue;
    const t = turnover(q);
    if (t < MIN_TURNOVER || (t < FOREIGN_TURNOVER && foreignHere(n, code, us))) continue;
    const k = companyKey(n) || s;
    const prev = best.get(k);
    if (!prev || t > prev.t) best.set(k, { q, t });
  }
  return [...best.values()]
    .map(({ q }) => ({
      s: q.symbol,
      n: q.longName || q.shortName,
      sec: sectors?.get(q.symbol) || 'Other',
      p: round(q.regularMarketPrice, 4),
      c: round(q.regularMarketChangePercent),
      y1: round(q.fiftyTwoWeekChangePercent),
      m: q.marketCap,
    }))
    .sort((a, b) => b.m - a.m);
}

// ---------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------

const PEG_SYMBOL = /usd|^eur|eur$|jpy|gbp|^xau|^pc\d+$/i;
const PEG_NAME = /\b(wrapped|staked|restaked|bridged|liquid staking|binance-peg|peg|tokeni[sz]ed|xstocks?|bstocks?|fund|t-?bills?|treasur(y|ies)|money market|stablecoin|dollar|euro|gold|silver)\b/i;
const PEG_TAGS = new Set(['stablecoin', 'bStocks', 'tCommodities']);
const abs = (v) => (Number.isFinite(v) ? Math.abs(v) : null);

/**
 * True for coins that track something else: stablecoins and other pegged tokens, wrapped or
 * staked copies of a larger coin (WBTC, stETH, JitoSOL), tokenized stocks, funds and gold.
 * `larger`: the coins ahead of it by market cap ({ symbol, current_price }). `tags`: Binance's tags.
 */
export function isPegged(coin, larger = [], tags = null) {
  const sym = String(coin.symbol || '').toLowerCase();
  const name = `${coin.name || ''} ${String(coin.id || '').replace(/-/g, ' ')}`;
  if (tags?.some((t) => PEG_TAGS.has(t))) return true;
  if (PEG_SYMBOL.test(sym) || PEG_NAME.test(name)) return true;
  const d = abs(coin.price_change_percentage_24h_in_currency ?? coin.price_change_percentage_24h);
  const w = abs(coin.price_change_percentage_7d_in_currency);
  const mo = abs(coin.price_change_percentage_30d_in_currency);
  const y = abs(coin.price_change_percentage_1y_in_currency);
  // Flat: pegged to a currency, or a fund's share.
  const known = [d, w, mo].filter((v) => v != null);
  if (known.length >= 2 && (d ?? 0) < 0.35 && (w ?? 0) < 0.8 && (mo ?? 0) < 1.6) return true;
  // Yield-bearing dollar tokens drift up slowly from $1.
  if (coin.current_price > 0.8 && coin.current_price < 1.6 && mo != null && mo < 5 && y != null && y < 8) return true;
  // A copy of a larger coin: its symbol inside (wBTC, cbBTC, wstETH, JitoSOL) and about its price.
  const p = coin.current_price;
  return p > 0 && larger.some((c) => {
    const s = String(c.symbol || '').toLowerCase();
    return s.length >= 3 && s !== sym && sym.includes(s) && p / c.current_price > 0.7 && p / c.current_price < 1.5;
  });
}

/** Binance's spot products (its website's list) → Map base asset → { pair, price, tags } for trading USDT pairs. */
export function binanceProducts(list) {
  const out = new Map();
  for (const x of list || []) {
    if (x?.q !== 'USDT' || x.st !== 'TRADING' || !x.b || !/^[A-Z0-9]+$/.test(x.b)) continue;
    out.set(x.b, { pair: `${x.b}USDT`, price: num(x.c), tags: Array.isArray(x.tags) ? x.tags : [] });
  }
  return out;
}

/** Binance's /api/v3/ticker/price (every pair, no status or tags) → the same Map, without tags. */
export function binancePrices(list) {
  const out = new Map();
  for (const x of list || []) {
    const m = /^([A-Z0-9]+)USDT$/.exec(x?.symbol || '');
    if (m) out.set(m[1], { pair: x.symbol, price: num(x.price), tags: null });
  }
  return out;
}

// Exchanges' own tokens, which Binance doesn't list (BNB aside) or tags as something else.
const EXCHANGE_TOKENS = new Set(['binancecoin', 'leo-token', 'whitebit', 'okb', 'crypto-com-chain', 'bitget-token', 'kucoin-shares',
  'gatechain-token', 'htx-dao', 'mx-token', 'btse-token', 'bnb48-club-token', 'bitmart-token', 'huobi-token', 'ftx-token']);
// Well-known coins that aren't on Binance.
const KNOWN = {
  kaspa: 'Layer 1 & 2', 'xdce-crowd-sale': 'Layer 1 & 2', 'flare-networks': 'Layer 1 & 2', monad: 'Layer 1 & 2', 'pi-network': 'Layer 1 & 2',
  'canton-network': 'Layer 1 & 2', mantle: 'Layer 1 & 2', 'bitcoin-cash-sv': 'Payments', ecash: 'Payments', monero: 'Payments',
  'akash-network': 'AI', grass: 'AI', 'aioz-network': 'Infrastructure', 'spx6900': 'Meme', memecore: 'Meme',
};
// Binance's tags → groups. The first that matches wins.
const TAG_GROUPS = [['Meme', 'Meme'], ['Payments', 'Payments'], ['Layer1_Layer2', 'Layer 1 & 2'], ['defi', 'DeFi'], ['AI', 'AI'],
  ['RWA', 'Real-world assets'], ['Gaming', 'Gaming & NFT'], ['NFT', 'Gaming & NFT'], ['Infrastructure', 'Infrastructure'], ['storage-zone', 'Infrastructure']];

/** A coin's group: its category when Binance's tags (or the built-in list) know it, else 'Other'. */
export function coinCategory(id, tags) {
  if (EXCHANGE_TOKENS.has(id)) return 'Exchange tokens';
  if (KNOWN[id]) return KNOWN[id];
  for (const [tag, group] of TAG_GROUPS) if (tags?.includes(tag)) return group;
  return 'Other';
}

/** Rank tiers, for when there are no categories to group by. */
export function rankTier(rank) {
  return rank <= 10 ? 'Top 10' : rank <= 25 ? '11–25' : rank <= 50 ? '26–50' : rank <= 100 ? '51–100' : '101+';
}

/** True when Binance's pairs came with its tags (so coins can be grouped by category). */
export const hasTags = (pairs) => !!pairs && [...pairs.values()].some((x) => x.tags);

/**
 * CoinGecko /coins/markets rows → heatmap rows, largest first: [{ s, n, full, sec, p, m, c, r1w,
 * r1m, y1, rank }] (r3m is filled in later). pairs: binanceProducts() or binancePrices() (or
 * null when Binance couldn't be reached). Groups by category when pairs carry tags, else by rank.
 */
export function shapeCoins(coins, { pairs = null } = {}) {
  const byCat = hasTags(pairs);
  const kept = [];
  const seen = new Set();
  const larger = [];
  for (const c of coins || []) {
    if (!c?.id || !c.symbol || !(c.market_cap > 0) || !(c.current_price > 0)) continue;
    const s = String(c.symbol).toUpperCase();
    const bn = pairs?.get(s);
    // Binance's pair is this coin when its price agrees (tickers can be shared by unrelated coins).
    const same = bn && bn.price > 0 && Math.abs(bn.price / c.current_price - 1) < 0.05;
    const pegged = isPegged(c, larger, same ? bn.tags : null);
    larger.push(c);
    if (pegged || seen.has(s)) continue; // the same token listed twice: keep the larger
    seen.add(s);
    kept.push({
      s,
      n: c.name || s,
      full: same ? `BINANCE:${bn.pair}` : /^[A-Z0-9]+$/.test(s) ? `YAHOO:${s}-USD` : null,
      sec: byCat ? coinCategory(c.id, same ? bn.tags : null) : null,
      p: c.current_price,
      m: c.market_cap,
      c: round(c.price_change_percentage_24h_in_currency ?? c.price_change_percentage_24h),
      r1w: round(c.price_change_percentage_7d_in_currency),
      r1m: round(c.price_change_percentage_30d_in_currency),
      r3m: null,
      y1: round(c.price_change_percentage_1y_in_currency),
    });
  }
  kept.forEach((r, i) => { r.rank = i + 1; if (!byCat) r.sec = rankTier(r.rank); });
  return kept;
}

/** % change from the first to the last of a list of closes (null when there are fewer than two). */
export function changeOver(closes) {
  const c = (closes || []).filter((v) => Number.isFinite(v) && v > 0);
  return c.length >= 2 ? round(((c.at(-1) - c[0]) / c[0]) * 100) : null;
}

// ---------------------------------------------------------------------------
// Fetching and caching (deps from server.mjs: its Yahoo session and the US company countries)
// ---------------------------------------------------------------------------

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const YAHOO_HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const BINANCE_REST = ['https://data-api.binance.vision', 'https://api.binance.com'];
const MIN = 60 * 1000, HOUR = 60 * MIN;
const PRICE_TTL = MIN; // stock prices
const LIST_TTL = 6 * HOUR; // which stocks a market's map has
const SECTOR_TTL = 24 * HOUR; // which sector each stock is in
const TECH_TTL = 6 * HOUR; // 1-week, 1-month, 3-month changes
const COIN_TTL = 3 * MIN; // CoinGecko's free API is rate-limited: once every few minutes is plenty
const PAIR_TTL = 6 * HOUR;
const RETRY = 30 * MIN; // after a failed fetch of closes
const BODY_TTL = 15 * 1000;
const STOCK_ROWS = 500;
const WANT_ROWS = 300; // keep paging (largest first) until a market has this many of its own companies...
const MAX_OFFSET = 1250; // ...or six pages: Frankfurt's and São Paulo's largest lines are mostly foreign companies'

// Concurrent requests for the same thing share one fetch.
const inflight = new Map();
const once = (key, fn) => {
  if (!inflight.has(key)) inflight.set(key, fn().finally(() => inflight.delete(key)));
  return inflight.get(key);
};

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
async function mapLimit(items, limit, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) await fn(items[i++]); }));
}
async function getJson(url, init = {}) {
  const r = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...init.headers }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return r.json();
}

let deps = { getYahooSession: null, getUsCountries: async () => null };

/** One page (250) of Yahoo's screener, largest companies first. */
async function screen(query, offset = 0, retry = true) {
  const sess = await deps.getYahooSession();
  const r = await fetch(`https://query1.finance.yahoo.com/v1/finance/screener?lang=en-US&region=US&formatted=false&crumb=${encodeURIComponent(sess.crumb)}`, {
    method: 'POST',
    headers: { 'User-Agent': UA, Cookie: sess.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ size: 250, offset, sortField: 'intradaymarketcap', sortType: 'DESC', quoteType: 'EQUITY', query, userId: '', userIdType: 'guid' }),
    signal: AbortSignal.timeout(15000),
  });
  if ((r.status === 401 || r.status === 403) && retry) { await deps.getYahooSession(true); return screen(query, offset, false); }
  if (!r.ok) throw new Error(`Yahoo screener HTTP ${r.status}`);
  return (await r.json()).finance?.result?.[0]?.quotes || [];
}
const onExchanges = (ex) => (ex.length > 1
  ? { operator: 'or', operands: ex.map((e) => ({ operator: 'eq', operands: ['exchange', e] })) }
  : { operator: 'eq', operands: ['exchange', ex[0]] });

/** Daily closes for many Yahoo symbols (spark, 20 a request): Map symbol → closes. Missing symbols are left out. */
async function sparkCloses(symbols, range) {
  const out = new Map();
  for (const host of YAHOO_HOSTS) {
    try {
      const j = await getJson(`https://${host}/v7/finance/spark?symbols=${encodeURIComponent(symbols.join(','))}&range=${range}&interval=1d`);
      for (const x of j.spark?.result || []) {
        const r = x.response?.[0];
        if (r) out.set(x.symbol, { closes: r.indicators?.quote?.[0]?.close || [], price: r.meta?.regularMarketPrice ?? null });
      }
      return out;
    } catch { /* try the other host */ }
  }
  throw new Error('Yahoo spark failed');
}

// Sector of each stock, from one screener query per sector (cached a day).
const sectorCache = new Map(); // code -> { t, map }
async function sectorMap(code) {
  const hit = sectorCache.get(code);
  if (hit && Date.now() - hit.t < SECTOR_TTL) return hit.map;
  return once(`sectors:${code}`, () => loadSectors(code, hit));
}
async function loadSectors(code, hit) {
  const map = new Map(hit?.map || []);
  let failed = 0;
  await mapLimit(SECTORS, 4, async (sector) => {
    try {
      const quotes = await screen({ operator: 'and', operands: [onExchanges(MARKETS[code].ex), { operator: 'eq', operands: ['sector', sector] }] });
      for (const q of quotes) if (q.symbol) map.set(q.symbol, sector);
    } catch { failed++; }
  });
  // Partly failed: use what there is and try again in 10 minutes.
  sectorCache.set(code, { t: failed ? Date.now() - SECTOR_TTL + 10 * MIN : Date.now(), map });
  return map;
}

// The US list tells foreign companies' lines apart; don't wait long for it (the turnover check catches most).
const usCountriesSoon = () => Promise.race([
  Promise.resolve().then(() => deps.getUsCountries()).catch(() => null),
  new Promise((r) => { setTimeout(() => r(null), 10000).unref?.(); }),
]);

/** A market's largest companies (with the screener's prices), kept for hours. */
const listCache = new Map(); // code -> { t, rows }
async function listing(code) {
  const hit = listCache.get(code);
  if (hit && Date.now() - hit.t < LIST_TTL) return hit;
  return once(`list:${code}`, async () => {
    try {
      const query = onExchanges(MARKETS[code].ex);
      const [first, second, us, sectors] = await Promise.all([
        screen(query, 0), screen(query, 250).catch(() => []), usCountriesSoon(), sectorMap(code),
      ]);
      const quotes = [...first, ...second];
      let rows = shapeStocks(quotes, code, { us, sectors });
      for (let offset = 500, last = second; rows.length < WANT_ROWS && last.length === 250 && offset <= MAX_OFFSET; offset += 250) {
        last = await screen(query, offset).catch(() => []);
        quotes.push(...last);
        rows = shapeStocks(quotes, code, { us, sectors });
      }
      if (rows.length < 10) throw new Error(`only ${rows.length} stocks`);
      const entry = { t: Date.now(), rows: rows.slice(0, STOCK_ROWS) };
      listCache.set(code, entry);
      priceCache.set(code, { t: Date.now(), map: new Map() }); // the screener's prices are fresh
      return entry;
    } catch (e) {
      if (hit) { hit.t = Date.now() - LIST_TTL + 10 * MIN; return hit; } // serve the last good copy; retry in 10 minutes
      throw Object.assign(new Error(`Couldn't load ${HEATMAP_MARKETS[code]} stocks from Yahoo: ${e.message}`), { status: 502 });
    }
  });
}

/** Yahoo quotes (200 a request, needs the session's crumb). */
async function quoteBatch(symbols, retry = true) {
  const sess = await deps.getYahooSession();
  const q = new URLSearchParams({ symbols: symbols.join(','), fields: 'regularMarketPrice,regularMarketChangePercent,marketCap,fiftyTwoWeekChangePercent', crumb: sess.crumb });
  const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/quote?${q}`, {
    headers: { 'User-Agent': UA, Cookie: sess.cookie }, signal: AbortSignal.timeout(15000),
  });
  if ((r.status === 401 || r.status === 403) && retry) { await deps.getYahooSession(true); return quoteBatch(symbols, false); }
  if (!r.ok) throw new Error(`Yahoo quotes HTTP ${r.status}`);
  return (await r.json()).quoteResponse?.result || [];
}

/** Today's prices for a market's stocks, refreshed every minute: Map symbol → { p, c, y1, m }. */
const priceCache = new Map(); // code -> { t, map }
async function prices(code, symbols) {
  const hit = priceCache.get(code);
  if (hit && Date.now() - hit.t < PRICE_TTL) return hit.map;
  return once(`prices:${code}`, async () => {
    // From the last prices: a batch that fails keeps its stocks' (not the listing's hours-old ones).
    const map = new Map(hit?.map || []);
    let got = 0;
    await mapLimit(chunks(symbols, 200), 3, async (batch) => {
      try {
        for (const q of await quoteBatch(batch)) {
          const x = {};
          if (q.regularMarketPrice > 0) x.p = round(q.regularMarketPrice, 4);
          if (Number.isFinite(q.regularMarketChangePercent)) x.c = round(q.regularMarketChangePercent);
          if (Number.isFinite(q.fiftyTwoWeekChangePercent)) x.y1 = round(q.fiftyTwoWeekChangePercent);
          if (q.marketCap > 0) x.m = q.marketCap;
          map.set(q.symbol, x);
          got++;
        }
      } catch { /* keep these stocks' earlier prices */ }
    });
    if (!got && hit) { hit.t = Date.now() - PRICE_TTL + 15000; return hit.map; } // keep the last good data
    priceCache.set(code, { t: Date.now(), map });
    return map;
  });
}

async function stockRows(code) {
  const { rows } = await listing(code);
  const latest = await prices(code, rows.map((r) => r.s));
  return rows.map((r) => ({ ...r, ...latest.get(r.s) }));
}

// 1-week, 1-month and 3-month changes from a year of daily closes, computed in the background.
const techCache = new Map(); // symbol -> { t, tech }
let techJob = null;
function refreshTechnicals(symbols) {
  if (techJob) return;
  const stale = symbols.filter((s) => !(techCache.get(s)?.t > Date.now() - TECH_TTL));
  if (!stale.length) return;
  techJob = mapLimit(chunks(stale, 20), 2, async (batch) => {
    try {
      const closes = await sparkCloses(batch, '1y');
      for (const s of batch) techCache.set(s, { t: closes.has(s) ? Date.now() : Date.now() - TECH_TTL + RETRY, tech: closes.has(s) ? technicals(closes.get(s).closes) : null });
    } catch {
      // Yahoo unreachable: these have no multi-day changes for now (so the panel can grey those periods out).
      for (const s of batch) techCache.set(s, { t: Date.now() - TECH_TTL + RETRY, tech: null });
    }
  }).finally(() => { techJob = null; });
}

async function stockMarket(code) {
  const rows = await stockRows(code);
  const symbols = rows.map((r) => r.s);
  refreshTechnicals(symbols);
  return {
    ...marketCurrency(code),
    grouping: 'sector',
    tech: { done: symbols.filter((s) => techCache.has(s)).length, total: symbols.length },
    rows: rows.map((r) => {
      const t = techCache.get(r.s)?.tech;
      return { ...r, r1w: t?.r1w ?? null, r1m: t?.r1m ?? null, r3m: t?.r3m ?? null };
    }),
  };
}

let coinCache = { t: 0, coins: null };
async function coinList() {
  if (coinCache.coins && Date.now() - coinCache.t < COIN_TTL) return coinCache.coins;
  return once('coins', loadCoins);
}
async function loadCoins() {
  try {
    const coins = await getJson('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=1&sparkline=false&price_change_percentage=24h,7d,30d,1y');
    if (!Array.isArray(coins) || coins.length < 20) throw new Error('no coins');
    coinCache = { t: Date.now(), coins };
  } catch (e) {
    if (coinCache.coins) { coinCache.t = Date.now() - COIN_TTL + MIN; return coinCache.coins; } // keep the last good list; retry in a minute
    throw Object.assign(new Error(`Couldn't load crypto market caps from CoinGecko${e.status === 429 ? ' (too many requests, try again in a minute)' : `: ${e.message}`}`), { status: 502 });
  }
  return coinCache.coins;
}

let pairCache = { t: 0, pairs: null };
async function binancePairs() {
  if (pairCache.t && Date.now() - pairCache.t < PAIR_TTL) return pairCache.pairs;
  return once('pairs', loadPairs);
}
async function loadPairs() {
  let pairs = null;
  try {
    // Binance's website list has each pair's status and its tags (Layer 1, DeFi, Meme...).
    const j = await getJson('https://www.binance.com/bapi/asset/v2/public/asset-service/product/get-products?includeEtf=true');
    pairs = binanceProducts(j?.data);
    if (pairs.size < 100) pairs = null;
  } catch { /* fall back to the public API */ }
  if (!pairs) {
    for (const host of BINANCE_REST) {
      try { pairs = binancePrices(await getJson(`${host}/api/v3/ticker/price`)); if (pairs.size > 100) break; pairs = null; } catch { /* next host */ }
    }
  }
  const tagged = hasTags(pairs);
  if (pairs) pairCache = { t: tagged ? Date.now() : Date.now() - PAIR_TTL + 30 * MIN, pairs };
  else pairCache.t = Date.now() - PAIR_TTL + 10 * MIN; // Binance unreachable (some countries): try again in 10 minutes
  return pairCache.pairs;
}

// 3-month changes (CoinGecko's list has none): Binance daily candles, or Yahoo's for coins not on Binance.
const coin3m = new Map(); // full symbol -> { t, r3m, ok }
let coinJob = null;
function refreshCoin3m(rows) {
  if (coinJob) return;
  const stale = rows.filter((r) => r.full && !(coin3m.get(r.full)?.t > Date.now() - TECH_TTL));
  if (!stale.length) return;
  const binance = stale.filter((r) => r.full.startsWith('BINANCE:'));
  const yahoo = stale.filter((r) => r.full.startsWith('YAHOO:'));
  coinJob = Promise.all([
    mapLimit(binance, 4, async (r) => {
      for (const host of BINANCE_REST) {
        try {
          const k = await getJson(`${host}/api/v3/klines?symbol=${r.full.slice(8)}&interval=1d&limit=91`);
          coin3m.set(r.full, { t: Date.now(), r3m: changeOver(k.map((b) => Number(b[4]))), ok: true });
          return;
        } catch { /* next host */ }
      }
      coin3m.set(r.full, { t: Date.now() - TECH_TTL + RETRY, r3m: null, ok: true }); // no data for now
    }),
    mapLimit(chunks(yahoo, 20), 2, async (batch) => {
      try {
        const closes = await sparkCloses(batch.map((r) => r.full.slice(6)), '3mo');
        for (const r of batch) {
          const x = closes.get(r.full.slice(6));
          // Yahoo's "XYZ-USD" can be a different coin with the same ticker: check the price.
          const ok = !!x && x.price > 0 && Math.abs(x.price / r.p - 1) < 0.1;
          coin3m.set(r.full, { t: Date.now(), r3m: ok ? changeOver(x.closes) : null, ok });
        }
      } catch {
        // Yahoo unreachable: no 3-month change for now, and keep the (unchecked) chart link.
        for (const r of batch) coin3m.set(r.full, { t: Date.now() - TECH_TTL + RETRY, r3m: null, ok: true });
      }
    }),
  ]).finally(() => { coinJob = null; });
}

async function cryptoMarket() {
  const [coins, pairs] = await Promise.all([coinList(), binancePairs().catch(() => null)]);
  const rows = shapeCoins(coins, { pairs });
  refreshCoin3m(rows);
  return {
    cur: 'USD',
    capCur: 'USD',
    grouping: hasTags(pairs) ? 'category' : 'rank',
    tech: { done: rows.filter((r) => !r.full || coin3m.has(r.full)).length, total: rows.length },
    rows: rows.map((r) => {
      const x = coin3m.get(r.full);
      // No chart for a coin whose Yahoo ticker turned out to be another coin (or isn't there).
      return { ...r, r3m: x?.r3m ?? null, ...(x && !x.ok ? { full: null } : {}) };
    }),
  };
}

/**
 * The gzipped JSON for /api/heatmap?market=<id>: { updated, market, name, cur (prices), capCur
 * (market caps), grouping, tech: { done, total }, rows: [{ s, n, full?, sec, p, m, c, r1w, r1m, r3m, y1 }] }.
 * deps: { getYahooSession, getUsCountries } from server.mjs.
 */
const bodyCache = new Map(); // market -> { t, body }
export async function heatmapMarket(market, d) {
  if (!Object.hasOwn(HEATMAP_MARKETS, market)) throw Object.assign(new Error('Unknown market'), { status: 400 });
  if (d) deps = { ...deps, ...d };
  const hit = bodyCache.get(market);
  if (hit && Date.now() - hit.t < BODY_TTL) return hit.body;
  const data = market === 'crypto' ? await cryptoMarket() : await stockMarket(market);
  const body = gzipSync(JSON.stringify({ updated: Date.now(), market, name: HEATMAP_MARKETS[market], ...data }));
  bodyCache.set(market, { t: Date.now(), body });
  return body;
}
