// Stock screener: turns market data into rows with metrics, trading signals and market-wide
// insights. Pure functions (no network), so they can be unit-tested; server.mjs feeds them.

const DAY = 86400;
const round = (v, d = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : null);
const pctDiff = (a, b) => (Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? ((a - b) / b) * 100 : null);

function sma(values, len, end = values.length) {
  if (end < len) return null;
  let s = 0;
  for (let i = end - len; i < end; i++) s += values[i];
  return s / len;
}

/** Wilder's RSI of the closes (latest value). */
export function rsi(closes, len = 14) {
  if (closes.length <= len) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= len; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  gain /= len; loss /= len;
  for (let i = len + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (len - 1) + Math.max(d, 0)) / len;
    loss = (loss * (len - 1) + Math.max(-d, 0)) / len;
  }
  if (loss === 0) return gain === 0 ? 50 : 100;
  return 100 - 100 / (1 + gain / loss);
}

/**
 * Trend and momentum from a year of daily closes (oldest first, the last one is today's).
 * Returns null fields when there isn't enough history.
 */
export function technicals(closes) {
  const c = closes.filter(Number.isFinite);
  const n = c.length;
  if (n < 2) return null;
  const last = c[n - 1];
  const ret = (k) => (n > k ? pctDiff(last, c[n - 1 - k]) : null);
  // Days since the 50-day average last crossed the 200-day one (within the last 20 sessions).
  let cross = null;
  if (n >= 201) {
    for (let k = 0; k < 20 && n - k - 1 >= 200; k++) {
      const end = n - k;
      const above = sma(c, 50, end) > sma(c, 200, end);
      const wasAbove = sma(c, 50, end - 1) > sma(c, 200, end - 1);
      if (above !== wasAbove) { cross = { type: above ? 'golden' : 'death', daysAgo: k }; break; }
    }
  }
  const prior20 = n > 20 ? c.slice(n - 21, n - 1) : null;
  // Consecutive up (+) or down (-) closes.
  let streak = 0;
  for (let i = n - 1; i > 0; i--) {
    const d = Math.sign(c[i] - c[i - 1]);
    if (d === 0 || (streak && Math.sign(streak) !== d)) break;
    streak += d;
  }
  return {
    rsi: round(rsi(c), 1),
    r1w: round(ret(5)),
    r1m: round(ret(21)),
    r3m: round(ret(63)),
    cross,
    hi20: prior20 ? last > Math.max(...prior20) : null,
    lo20: prior20 ? last < Math.min(...prior20) : null,
    streak,
  };
}

/** The signal tags a row earns. `now` is in seconds. */
export function signals(row, now = Date.now() / 1000) {
  const s = [];
  if (Number.isFinite(row.hi52) && row.p >= row.hi52 * 0.998) s.push('new-high');
  else if (row.hi20) s.push('breakout');
  if (Number.isFinite(row.lo52) && row.p <= row.lo52 * 1.002) s.push('new-low');
  else if (row.lo20) s.push('breakdown');
  if (row.rv >= 2) s.push('unusual-volume');
  if (row.gap >= 3) s.push('gap-up');
  if (row.gap <= -3) s.push('gap-down');
  if (row.d50 > 0 && row.sma50 > row.sma200) s.push('uptrend');
  if (row.d50 < 0 && row.sma50 < row.sma200) s.push('downtrend');
  if (row.rsi != null && row.rsi < 30) s.push('oversold');
  if (row.rsi != null && row.rsi > 70) s.push('overbought');
  if (row.cross?.type === 'golden' && row.cross.daysAgo <= 10) s.push('golden-cross');
  if (row.cross?.type === 'death' && row.cross.daysAgo <= 10) s.push('death-cross');
  if (row.er && row.er >= now - DAY && row.er <= now + 7 * DAY) s.push('earnings');
  return s;
}

/**
 * One row per stock. `base` comes from the full market list ({s, n, p, c, v, m, sec, ind}),
 * `quote` from Yahoo's quote data (optional), `tech` from technicals() (optional).
 */
export function buildRow(base, quote = null, tech = null, now = Date.now() / 1000) {
  const q = quote || {};
  const p = q.regularMarketPrice ?? base.p;
  // No volume yet (a market before its open, e.g. Seoul at 8 am): unknown, not "0× normal".
  const v = q.regularMarketVolume || base.v || null;
  const av = q.averageDailyVolume10Day || q.averageDailyVolume3Month || null;
  const sma50 = q.fiftyDayAverage ?? null, sma200 = q.twoHundredDayAverage ?? null;
  const prev = q.regularMarketPreviousClose ?? null;
  const ext = Number.isFinite(q.postMarketChangePercent) && q.marketState?.startsWith('POST') ? q.postMarketChangePercent
    : Number.isFinite(q.preMarketChangePercent) && q.marketState?.startsWith('PRE') ? q.preMarketChangePercent : null;
  const row = {
    s: base.s,
    n: q.shortName || base.n,
    sec: base.sec || '',
    ind: base.ind || '',
    p: round(p, 4),
    c: round(q.regularMarketChangePercent ?? base.c),
    v,
    av,
    rv: av && v != null ? round(v / av) : null,
    m: q.marketCap || base.m || null,
    gap: round(pctDiff(q.regularMarketOpen, prev)),
    ext: round(ext),
    sma50, sma200,
    d50: round(pctDiff(p, sma50)),
    d200: round(pctDiff(p, sma200)),
    hi52: q.fiftyTwoWeekHigh ?? null,
    lo52: q.fiftyTwoWeekLow ?? null,
    h52: round(pctDiff(p, q.fiftyTwoWeekHigh)),
    y1: round(q.fiftyTwoWeekChangePercent),
    pe: round(q.trailingPE, 1),
    er: q.earningsTimestamp || q.earningsTimestampStart || null,
    rating: q.averageAnalystRating || null,
    rsi: tech?.rsi ?? null,
    r1w: tech?.r1w ?? null,
    r1m: tech?.r1m ?? null,
    r3m: tech?.r3m ?? null,
    cross: tech?.cross ?? null,
    hi20: tech?.hi20 ?? null,
    lo20: tech?.lo20 ?? null,
    streak: tech?.streak ?? null,
  };
  row.sig = signals(row, now);
  return row;
}

/** Market-wide picture: breadth, trend participation, signal counts and sectors. */
export function insights(rows) {
  const live = rows.filter((r) => Number.isFinite(r.c));
  const up = live.filter((r) => r.c > 0).length;
  const down = live.filter((r) => r.c < 0).length;
  const share = (pred, pool) => (pool.length ? round((pool.filter(pred).length / pool.length) * 100, 0) : null);
  const with50 = rows.filter((r) => Number.isFinite(r.d50));
  const with200 = rows.filter((r) => Number.isFinite(r.d200));
  const count = (tag) => rows.filter((r) => r.sig?.includes(tag)).length;
  const bySector = new Map();
  for (const r of live) {
    if (!r.sec) continue;
    const g = bySector.get(r.sec) || { sec: r.sec, n: 0, up: 0, down: 0, sum: 0, cap: 0, capSum: 0 };
    g.n++; g.up += r.c > 0; g.down += r.c < 0; g.sum += r.c;
    if (r.m > 0) { g.cap += r.m; g.capSum += r.c * r.m; }
    bySector.set(r.sec, g);
  }
  const sectors = [...bySector.values()]
    .filter((g) => g.n >= 5)
    .map((g) => ({ sec: g.sec, n: g.n, up: g.up, down: g.down, change: round(g.cap ? g.capSum / g.cap : g.sum / g.n) }))
    .sort((a, b) => b.change - a.change);
  return {
    total: rows.length,
    up, down, flat: live.length - up - down,
    above50: share((r) => r.d50 > 0, with50),
    above200: share((r) => r.d200 > 0, with200),
    newHighs: count('new-high'),
    newLows: count('new-low'),
    unusualVolume: count('unusual-volume'),
    gapsUp: count('gap-up'),
    gapsDown: count('gap-down'),
    earnings: count('earnings'),
    sectors,
  };
}
