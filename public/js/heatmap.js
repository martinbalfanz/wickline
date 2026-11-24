// Heatmap panel: a market's largest stocks (or coins) as tiles grouped by sector, sized by market
// cap and coloured by how much they moved (today, this week, month, 3 months or year). US stocks
// come from the server's /api/screener (the same scan as the Screener); crypto and stock markets
// outside the US from /api/heatmap (lib/heatmap-markets.mjs). Clicking a tile opens its chart.
// The layout, colour and formatting functions are pure and unit-tested in test/heatmap.test.mjs
// and test/heatmap-markets.test.mjs.

import { apiUrl, dataMode } from './env.js';
import { $, esc, store, fixed } from './util.js';
import { t, locale } from './i18n.js';

/**
 * Periods: the row field, its button, its name, and the change that gets the strongest colour.
 * The buttons keep the short Latin labels in every language (the toolbar is tight); the name is the tooltip.
 */
export const PERIODS = [
  ['c', '1D', t('hm.period.today'), 3], ['r1w', '1W', t('hm.period.week'), 6], ['r1m', '1M', t('hm.period.month'), 10],
  ['r3m', '3M', t('hm.period.3months'), 20], ['y1', '1Y', t('hm.period.year'), 40],
];
// Crypto moves more: the same colours stand for twice the change, and changes are rolling.
const CRYPTO_SCALE = 2;
const CRYPTO_TITLES = {
  c: t('hm.crypto.24h'), r1w: t('hm.crypto.7d'), r1m: t('hm.crypto.30d'), r3m: t('hm.crypto.90d'), y1: t('hm.crypto.12m'),
};

/** Markets: id (for /api/heatmap; 'us' is the Screener's scan) and name. */
export const MARKETS = [
  ['us', t('hm.mkt.us')], ['GB', t('hm.mkt.GB')], ['DE', t('hm.mkt.DE')], ['FR', t('hm.mkt.FR')], ['NL', t('hm.mkt.NL')],
  ['IT', t('hm.mkt.IT')], ['ES', t('hm.mkt.ES')], ['CH', t('hm.mkt.CH')], ['SE', t('hm.mkt.SE')], ['JP', t('hm.mkt.JP')], ['CN', t('hm.mkt.CN')],
  ['HK', t('hm.mkt.HK')], ['KR', t('hm.mkt.KR')], ['TW', t('hm.mkt.TW')], ['IN', t('hm.mkt.IN')], ['CA', t('hm.mkt.CA')], ['AU', t('hm.mkt.AU')],
  ['BR', t('hm.mkt.BR')], ['crypto', t('hm.mkt.crypto')],
];
const marketName = (id) => MARKETS.find(([k]) => k === id)?.[1] || id;

// Group names come from the data in English (Nasdaq's and Yahoo's sectors, the crypto categories
// and rank tiers of lib/heatmap-markets.mjs) and stay the ids; these are their display names.
const GROUP_NAMES = {
  Technology: t('hm.sec.technology'), 'Financial Services': t('hm.sec.financialServices'), Finance: t('hm.sec.finance'),
  Healthcare: t('hm.sec.healthcare'), 'Health Care': t('hm.sec.healthCare'), 'Consumer Cyclical': t('hm.sec.consumerCyclical'),
  'Consumer Discretionary': t('hm.sec.consumerDiscretionary'), 'Consumer Defensive': t('hm.sec.consumerDefensive'),
  'Consumer Staples': t('hm.sec.consumerStaples'), Industrials: t('hm.sec.industrials'),
  'Communication Services': t('hm.sec.communication'), Telecommunications: t('hm.sec.telecom'), Energy: t('hm.sec.energy'),
  'Basic Materials': t('hm.sec.materials'), 'Real Estate': t('hm.sec.realEstate'), Utilities: t('hm.sec.utilities'),
  Miscellaneous: t('hm.sec.misc'), Other: t('hm.sec.other'),
  'Exchange tokens': t('hm.sec.exchangeTokens'), 'Layer 1 & 2': t('hm.sec.layer12'), Payments: t('hm.sec.payments'),
  Infrastructure: t('hm.sec.infrastructure'), Meme: t('hm.sec.meme'), 'Real-world assets': t('hm.sec.rwa'),
  'Gaming & NFT': t('hm.sec.gaming'), 'Top 10': t('hm.top', { n: 10 }),
};
/** A sector, category or tier name from the data, in the UI language (the screener and Markets panel use it too). */
export const groupName = (name) => GROUP_NAMES[name] || name;

// What the groups are called: sectors, or (crypto) categories or rank tiers.
const GROUP_TEXT = {
  sector: { all: t('hm.allSectors'), back: t('hm.backSector'), hint: t('hm.hintSector') },
  category: { all: t('hm.allCategories'), back: t('hm.backCategory'), hint: t('hm.hintCategory') },
  group: { all: t('hm.allGroups'), back: t('hm.backGroup'), hint: t('hm.hintGroup') },
};

/** How many tiles each kind of market offers. */
export function sizesFor(market) {
  const n = market === 'us' ? [100, 250, 500, 1000] : market === 'crypto' ? [50, 100, 250] : [50, 100, 250, 500];
  return n.map((v) => [v, t('hm.top', { n: v })]);
}

/** The largest of these sizes that's at most `top` (else the smallest), so one saved choice works for every market. */
export function pickSize(sizes, top) {
  const fit = sizes.filter(([v]) => v <= top);
  return (fit.length ? fit.at(-1) : sizes[0])[0];
}

/**
 * Which periods a market's data can colour: those some rows have, plus (while the server is still
 * working out the multi-day changes) the ones it hasn't finished. Without data yet: all of them.
 */
export function periodsAvailable(data) {
  if (!data?.rows?.length) return new Set(PERIODS.map(([k]) => k));
  const busy = !!data.tech && data.tech.done < data.tech.total;
  return new Set(PERIODS.map(([k]) => k).filter((k) => data.rows.some((r) => r[k] != null) || (busy && k !== 'c')));
}

/** A price or (compact) market cap in a currency: "$61,066.00", "¥3,329", "1,234.5p", "£210B", "$0.00000358". */
export function money(v, cur = 'USD', compact = false) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (cur === 'GBp' || cur === 'GBX') return compact ? money(v / 100, 'GBP', true) : `${v.toLocaleString(locale, { maximumFractionDigits: 2 })}p`;
  const opts = compact ? { notation: 'compact', maximumSignificantDigits: 3 } : Math.abs(v) < 1 ? { maximumSignificantDigits: 4 } : {};
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: cur || 'USD', ...opts }).format(v);
  } catch {
    return `${v.toLocaleString(locale, { maximumSignificantDigits: 6 })} ${cur}`;
  }
}

const SECTOR_LABEL = 16; // px of sector name above its tiles
const REFRESH_MS = 60000;

/**
 * Squarified treemap (Bruls, Huizing & van Wijk): lays out values (largest first works best) in a
 * rectangle as tiles close to square. Returns [{ x, y, w, h }] in the same order as values.
 */
export function squarify(values, x, y, w, h) {
  const n = values.length;
  const out = new Array(n);
  const total = values.reduce((s, v) => s + Math.max(0, v), 0);
  if (!n || total <= 0 || w <= 0 || h <= 0) return values.map(() => ({ x, y, w: 0, h: 0 }));
  const areas = values.map((v) => (Math.max(0, v) / total) * w * h);
  const rect = { x, y, w, h };
  // The worst (largest) aspect ratio of a row of areas laid along a side of this length.
  const worst = (sum, min, max, side) => {
    const s2 = sum * sum, side2 = side * side;
    return Math.max((side2 * max) / s2, s2 / (side2 * min));
  };
  let i = 0;
  while (i < n) {
    const side = Math.min(rect.w, rect.h);
    let j = i, sum = 0, min = Infinity, max = 0, best = Infinity;
    while (j < n) {
      const a = areas[j];
      const r = worst(sum + a, Math.min(min, a), Math.max(max, a), side);
      if (j > i && r > best) break; // adding this tile makes the row worse: start a new row
      best = r; sum += a; min = Math.min(min, a); max = Math.max(max, a); j++;
    }
    if (rect.w >= rect.h) {
      // A column on the left of the remaining space.
      const cw = sum / rect.h || 0;
      let yy = rect.y;
      for (let k = i; k < j; k++) { const hh = cw ? areas[k] / cw : 0; out[k] = { x: rect.x, y: yy, w: cw, h: hh }; yy += hh; }
      rect.x += cw; rect.w -= cw;
    } else {
      // A row along the top.
      const rh = sum / rect.w || 0;
      let xx = rect.x;
      for (let k = i; k < j; k++) { const ww = rh ? areas[k] / rh : 0; out[k] = { x: xx, y: rect.y, w: ww, h: rh }; xx += ww; }
      rect.y += rh; rect.h -= rh;
    }
    i = j;
  }
  return out;
}

// Red to grey to green, like most market maps.
const STOPS = [[-1, [246, 53, 56]], [-0.66, [191, 64, 69]], [-0.33, [139, 68, 78]], [0, [65, 69, 84]],
  [0.33, [53, 118, 78]], [0.66, [47, 158, 79]], [1, [48, 204, 90]]];
/** The tile colour for a change of v% when ±max% is the strongest colour (null: no data). */
export function heatColor(v, max) {
  if (v == null || !Number.isFinite(v)) return 'rgb(46, 48, 56)';
  const t = Math.max(-1, Math.min(1, v / max));
  for (let k = 1; k < STOPS.length; k++) {
    const [t1, c1] = STOPS[k];
    if (t <= t1) {
      const [t0, c0] = STOPS[k - 1];
      const f = (t - t0) / (t1 - t0);
      return `rgb(${c0.map((c, i) => Math.round(c + (c1[i] - c) * f)).join(', ')})`;
    }
  }
  return `rgb(${STOPS.at(-1)[1].join(', ')})`;
}

/** The largest `top` stocks (with a market cap) grouped by sector: [{ name, value, rows }], biggest sector first. */
export function groupBySector(rows, { top = 500, sector = '' } = {}) {
  const largest = rows.filter((r) => r.m > 0).sort((a, b) => b.m - a.m).slice(0, top);
  const by = new Map();
  for (const r of largest) {
    const name = r.sec || 'Other';
    if (sector && name !== sector) continue;
    if (!by.has(name)) by.set(name, { name, value: 0, rows: [] });
    const g = by.get(name);
    g.value += r.m;
    g.rows.push(r);
  }
  return [...by.values()].sort((a, b) => b.value - a.value);
}

/** Tiles for a map of w × h: sectors, then stocks inside each (below its name when there's room). */
export function layoutMap(groups, w, h) {
  const tiles = [];
  const labels = [];
  const boxes = squarify(groups.map((g) => g.value), 0, 0, w, h);
  groups.forEach((g, gi) => {
    const b = boxes[gi];
    const named = b.w > 70 && b.h > 44;
    const top = named ? SECTOR_LABEL : 0;
    if (named) labels.push({ name: g.name, x: b.x, y: b.y, w: b.w, sector: g.name });
    const inner = squarify(g.rows.map((r) => r.m), b.x, b.y + top, b.w, b.h - top);
    g.rows.forEach((r, ri) => tiles.push({ r, ...inner[ri] }));
  });
  return { tiles, labels };
}

/**
 * The code a market's own traders know a stock by, from Yahoo's symbol: no exchange suffix
 * (601398.SS → 601398, 7203.T → 7203), Hong Kong's five digits (0700.HK → 00700), and the share
 * class written the local way (INVE-B.ST → INVE B, BBD-B.TO → BBD.B). US tickers and coins stay.
 */
export function tileCode(sym, market) {
  const s = String(sym || '');
  if (market === 'us' || market === 'crypto') return s;
  const code = s.replace(/\.[A-Z]{1,3}$/, '');
  if (market === 'HK' && /^\d{1,4}$/.test(code)) return code.padStart(5, '0');
  if (market === 'SE') return code.replace(/-/g, ' ');
  if (market === 'GB' || market === 'CA') return code.replace(/-/g, '.');
  return code;
}

// Legal forms and the like at the end of a company name.
const LEGAL = /[\s,]+(?:inc\.?|incorporated|corporation|corp\.?|company|co\.?|ltd\.?|limited|plc|p\.l\.c\.|ag|se|s\.e\.|sa|s\.a\.|n\.v\.|nv|s\.p\.a\.|spa|ab|\(publ\)|oyj|asa|a\/s|kgaa|aktiengesellschaft|holdings?|group|société européenne|société en commandite par actions|s\.m\.e\.|tbk|bhd|berhad)$/iu;

/**
 * A company's everyday name for its tile: no legal form, "Holdings" or "Group", no leading "The"
 * (Toyota Motor Corporation → Toyota Motor, HSBC Holdings plc → HSBC). `cut`: the name may have
 * been cut off mid-word (Yahoo's US short names stop at about 30 characters), so drop a partial last word.
 */
export function tileName(name, { cut = false } = {}) {
  const raw = String(name || '');
  let n = raw;
  if (cut && n.length >= 30 && !/[\s.,)]$/.test(n)) n = n.replace(/\s+\S+$/, '');
  n = n.trim().replace(/^the\s+/i, '');
  for (let prev = ''; prev !== n;) { prev = n; n = n.replace(LEGAL, '').replace(/[\s,&–-]+$/, ''); }
  return n || raw.trim();
}

const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fixed(Math.abs(v), 2)}%`);
// The hover card's change rows, in PERIODS order.
const TIP_STOCKS = [t('hm.period.today'), t('hm.tip.1w'), t('hm.tip.1m'), t('hm.period.3months'), t('hm.period.year')];
const TIP_CRYPTO = [t('hm.tip.24h'), t('hm.tip.7d'), t('hm.tip.30d'), t('hm.tip.90d'), t('hm.period.year')];
/** The chart a row opens: its own symbol (crypto), none (a coin with no chart source), or Yahoo's. */
const chartOf = (r) => (r.full === undefined ? `YAHOO:${r.s}` : r.full);

export class HeatmapPanel {
  constructor({ onPick }) {
    this.onPick = onPick;
    this.el = $('#heatmap');
    this.body = $('#hm-body');
    this.cache = new Map(); // market -> its last data, so switching back is instant
    this.data = null;
    this.error = null;
    this.timer = null;
    this.gen = 0;
    this.rowBy = new Map();
    this.state = { market: 'us', period: 'c', top: 500, sector: '', ...store.get('heatmap', {}) };
    if (!MARKETS.some(([k]) => k === this.state.market)) this.state.market = 'us';
    this.tip = document.createElement('div');
    this.tip.className = 'hm-tip';
    this.tip.hidden = true;
    document.body.append(this.tip);

    this.el.querySelector('#hm-close').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    this.body.addEventListener('mousemove', (e) => this.onHover(e));
    this.body.addEventListener('mouseleave', () => { this.tip.hidden = true; });
    new ResizeObserver(() => { if (this.isOpen && this.data) this.draw(); }).observe(this.body);
    const handle = this.el.querySelector('.ed-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // One update (and map redraw) per frame; the height is saved once, when the drag ends.
      let y = e.clientY, frame = 0, moved = false;
      const apply = () => { frame = 0; this.setHeight(window.innerHeight - y - 28, false); };
      const move = (ev) => { y = ev.clientY; moved = true; if (!frame) frame = requestAnimationFrame(apply); };
      const up = (ev) => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        cancelAnimationFrame(frame);
        if (moved) {
          if (ev.type === 'pointerup') y = ev.clientY;
          this.setHeight(window.innerHeight - y - 28);
        }
        window.dispatchEvent(new Event('resize'));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
      window.addEventListener('pointercancel', up);
    });
    this.setHeight(store.get('heatmapHeight', 460), false);
    // Nothing is fetched or drawn while the window is hidden; catch up when it's shown again.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && this.isOpen && this.stalled) this.load();
    });
    this.renderBar();
  }

  get isOpen() { return !this.el.hidden; }

  get isCrypto() { return this.state.market === 'crypto'; }

  setHeight(h, save = true) {
    const height = Math.round(Math.max(240, Math.min(window.innerHeight * 0.85, h)));
    this.el.style.height = `${height}px`;
    if (save) store.set('heatmapHeight', height);
  }

  async open() {
    this.el.hidden = false;
    document.body.classList.add('heatmap-open');
    window.dispatchEvent(new Event('resize'));
    if ((await dataMode()) !== 'server') {
      this.body.innerHTML = `<div class="st-empty"><b>${esc(t('hm.desktop'))}</b>
        <span>${t('hm.desktopHelp')}</span></div>`;
      return;
    }
    if (!this.data) this.showLoading();
    this.load();
  }

  close() {
    this.el.hidden = true;
    this.tip.hidden = true;
    document.body.classList.remove('heatmap-open');
    clearTimeout(this.timer);
    window.dispatchEvent(new Event('resize'));
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  showLoading() {
    const m = this.state.market;
    const what = m === 'us' ? t('hm.loadingUs') : m === 'crypto' ? t('hm.loadingCrypto') : t('hm.loadingMarket', { market: marketName(m) });
    this.body.innerHTML = `<div class="st-empty"><b>${esc(t('hm.loading'))}</b><span>${esc(what)}</span></div>`;
  }

  showError(msg) {
    this.body.innerHTML = `<div class="st-empty"><b>${esc(t('hm.loadFailed'))}</b><span>${esc(msg)}</span>
      <button type="button" class="btn-ghost hm-retry" data-hm-retry="1">${esc(t('hm.tryAgain'))}</button></div>`;
  }

  async load() {
    clearTimeout(this.timer);
    const gen = ++this.gen;
    const market = this.state.market;
    // Hidden (minimised or covered): no fetching or drawing until visibilitychange says it's back.
    this.stalled = document.hidden;
    if (this.stalled) return;
    try {
      const r = await fetch(apiUrl(market === 'us' ? 'api/screener' : `api/heatmap?market=${encodeURIComponent(market)}`));
      const j = await r.json().catch(() => null);
      if (!r.ok || !j) throw new Error(j?.error || `HTTP ${r.status}`);
      if (!Array.isArray(j.rows)) throw new Error(t('hm.badAnswer'));
      this.cache.set(market, j);
      if (document.hidden && gen === this.gen) { this.stalled = true; return; } // hidden meanwhile: draw it when shown
      if (market === this.state.market) {
        this.data = j;
        this.error = null;
        this.renderBar();
        this.draw();
      }
    } catch (e) {
      if (market !== this.state.market) return;
      this.error = e.message || String(e);
      if (!this.data) this.showError(this.error);
      else this.draw(); // keep the map; the legend says the update failed
    }
    if (!this.isOpen || gen !== this.gen) return;
    const busy = this.data && this.data.tech && this.data.tech.done < this.data.tech.total;
    this.timer = setTimeout(() => this.load(), !this.data ? 30000 : busy && this.state.period !== 'c' ? 15000 : REFRESH_MS);
  }

  save() { store.set('heatmap', this.state); }

  setMarket(id) {
    if (id === this.state.market || !MARKETS.some(([k]) => k === id)) return;
    Object.assign(this.state, { market: id, sector: '' });
    this.save();
    this.data = this.cache.get(id) || null;
    this.error = null;
    this.tip.hidden = true;
    this.renderBar();
    if (this.data) this.draw(); else this.showLoading();
    if (this.isOpen) this.load();
  }

  /** The period shown: the chosen one, or 1D when this market can't colour it. */
  get period() {
    const ok = periodsAvailable(this.data);
    const k = ok.has(this.state.period) ? this.state.period : 'c';
    const p = PERIODS.find(([x]) => x === k) || PERIODS[0];
    return this.isCrypto ? [p[0], p[1], CRYPTO_TITLES[p[0]], p[3] * CRYPTO_SCALE] : p;
  }

  get top() { return pickSize(sizesFor(this.state.market), this.state.top); }

  /** What the groups are called (GROUP_TEXT): sectors, or (crypto) categories or rank tiers. */
  get groupText() {
    if (!this.isCrypto) return GROUP_TEXT.sector;
    return this.data?.grouping === 'rank' ? GROUP_TEXT.group : GROUP_TEXT.category;
  }

  renderBar() {
    const st = this.state;
    const ok = periodsAvailable(this.data);
    const words = this.groupText;
    const sub = this.el.querySelector('.sc-sub');
    if (sub) {
      const d = this.data;
      sub.textContent = st.market === 'us' ? t('hm.sub.us')
        : this.isCrypto ? (d?.grouping === 'rank' ? t('hm.sub.cryptoRank') : t('hm.sub.cryptoCategory'))
          : d?.capCur ? t('hm.sub.stocksCur', { cur: d.capCur }) : t('hm.sub.stocks');
    }
    const key = [st.market, st.period, st.sector, this.top, words.all, [...ok].join()].join('|');
    if (key === this.barKey) return; // unchanged: don't rebuild (and close) an open menu
    this.barKey = key;
    const shown = this.period[0];
    const sizes = sizesFor(st.market);
    const option = ([k, name]) => `<option value="${k}"${st.market === k ? ' selected' : ''}>${esc(name)}</option>`;
    $('#hm-tools').innerHTML = `
      <select class="select" data-f="market" aria-label="${esc(t('hm.market'))}" title="${esc(t('hm.market'))}">
        <optgroup label="${esc(t('hm.stocks'))}">${MARKETS.filter(([k]) => k !== 'crypto').map(option).join('')}</optgroup>
        <optgroup label="${esc(t('hm.mkt.crypto'))}">${option(['crypto', t('hm.cryptoTop')])}</optgroup>
      </select>
      <div class="nw-seg" role="tablist" aria-label="${esc(t('hm.periodLabel'))}">${PERIODS.map(([k, label, title]) => {
        const off = !ok.has(k);
        const tip = off ? t('hm.periodOff') : this.isCrypto ? CRYPTO_TITLES[k] : title;
        return `<button data-hm-period="${k}" class="${shown === k ? 'on' : ''}" title="${esc(tip)}"${off ? ' disabled' : ''}>${esc(label)}</button>`;
      }).join('')}</div>
      <select class="select" data-f="top" aria-label="${esc(t('hm.howMany'))}">${sizes.map(([v, l]) => `<option value="${v}"${this.top === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <span class="hm-crumb">${st.sector ? `<button data-hm-sector="" title="${esc(words.back)}">${esc(words.all)}</button> › <b>${esc(groupName(st.sector))}</b>` : `<span class="muted">${esc(words.hint)}</span>`}</span>`;
  }

  onChange(e) {
    const f = e.target.dataset.f;
    if (f === 'market') this.setMarket(e.target.value);
    if (f === 'top') { this.state.top = Number(e.target.value); this.save(); this.renderBar(); this.draw(); }
  }

  onClick(e) {
    if (e.target.closest('[data-hm-retry]')) { this.showLoading(); this.load(); return; }
    const p = e.target.closest('[data-hm-period]');
    if (p) {
      if (p.disabled) return;
      this.state.period = p.dataset.hmPeriod; this.save(); this.renderBar(); this.draw();
      if (this.state.period !== 'c') this.load();
      return;
    }
    const s = e.target.closest('[data-hm-sector]');
    if (s) { this.state.sector = s.dataset.hmSector; this.save(); this.renderBar(); this.draw(); return; }
    const t = e.target.closest('[data-sym]');
    const full = t && this.rowBy.get(t.dataset.sym) && chartOf(this.rowBy.get(t.dataset.sym));
    if (full) this.onPick(full);
  }

  /** How wide a tile label is, in ems of the tiles' bold font (measured once per label). */
  textEm(text) {
    this.emCache ||= new Map();
    let em = this.emCache.get(text);
    if (em === undefined) {
      if (this.measure === undefined) {
        this.measure = document.createElement('canvas').getContext('2d');
        if (this.measure) this.measure.font = `700 100px ${getComputedStyle(this.body).fontFamily}`;
      }
      // + the 0.01em letter spacing of .hm-tile b
      em = (this.measure ? this.measure.measureText(text).width / 100 : text.length * 0.62) + 0.01 * text.length;
      this.emCache.set(text, em);
    }
    return em;
  }

  draw() {
    if (!this.data) return;
    const st = this.state;
    const [key, , title, max] = this.period;
    const top = this.top;
    const box = this.body.getBoundingClientRect();
    const legendH = 26;
    const w = Math.floor(box.width), h = Math.floor(box.height) - legendH;
    if (w < 50 || h < 50) return;
    if (this.rowData !== this.data) { this.rowData = this.data; this.rowBy = new Map(this.data.rows.map((r) => [r.s, r])); }
    // The same server copy at the same size and settings draws the same map: keep the tiles.
    const drawKey = () => [st.market, this.data.updated, this.data.tech?.done, this.data.rows.length, w, h, key, max, top, st.sector, this.error].join('|');
    if (drawKey() === this.drawnKey && this.body.querySelector('.hm-map')) return;
    let groups = groupBySector(this.data.rows, { top, sector: st.sector });
    if (!groups.length && st.sector) { st.sector = ''; this.renderBar(); groups = groupBySector(this.data.rows, { top }); }
    this.drawnKey = drawKey();
    const { tiles, labels } = layoutMap(groups, w, h);
    this.tiles = tiles;
    const words = this.groupText;
    const html = [];
    const cutNames = st.market === 'us';
    for (const t of tiles) {
      if (t.w < 1 || t.h < 1) continue;
      const v = t.r[key];
      const code = tileCode(t.r.s, st.market);
      const em = this.textEm(code);
      let text = '';
      if (t.w > 56 && t.h > 34) {
        // The code as big as the tile allows, shrunk until it fits; the company's name under it on large tiles.
        const fs = Math.max(9, Math.min(30, t.w / 4.2, t.h / 2.6, (t.w - 8) / em));
        const small = Math.max(9, fs * 0.6);
        const name = tileName(t.r.n, { cut: cutNames });
        const nameFs = Math.max(9, Math.min(13, fs * 0.45));
        const showName = name && name.toUpperCase() !== code.toUpperCase() && t.w >= 70 && t.h >= (fs + small) * 1.05 + nameFs * 1.2 + 10;
        text = `<b style="font-size:${fs.toFixed(0)}px">${esc(code)}</b>${showName ? `<span class="hm-name" style="font-size:${nameFs.toFixed(0)}px">${esc(name)}</span>` : ''}<small style="font-size:${small.toFixed(0)}px">${pct(v)}</small>`;
      } else if (t.w > 26 && t.h > 13) {
        const fs = Math.min(12, t.h / 1.6, t.w / 4, (t.w - 4) / em);
        if (fs >= 7.5) text = `<b style="font-size:${fs.toFixed(0)}px">${esc(code)}</b>`;
      }
      const full = chartOf(t.r);
      html.push(`<div class="hm-tile${full ? '' : ' no-chart'}" data-sym="${esc(t.r.s)}"${full ? ` data-full="${esc(full)}"` : ''} style="left:${t.x.toFixed(1)}px;top:${t.y.toFixed(1)}px;width:${t.w.toFixed(1)}px;height:${t.h.toFixed(1)}px;background:${heatColor(v, max)}">${text}</div>`);
    }
    for (const l of labels) {
      const name = groupName(l.name);
      html.push(`<button class="hm-sector" data-hm-sector="${esc(st.sector ? '' : l.sector)}" style="left:${l.x.toFixed(1)}px;top:${l.y.toFixed(1)}px;width:${l.w.toFixed(1)}px" title="${esc(st.sector ? words.back : t('hm.zoomIn', { name }))}">${esc(name)}</button>`);
    }
    const busy = this.data.tech && this.data.tech.done < this.data.tech.total;
    const missing = tiles.filter((t) => t.r[key] == null).length;
    const note = this.error ? ` · ${esc(t('hm.updateFailed', { error: this.error }))}`
      : missing ? ` · ${esc(busy && key !== 'c' ? t('hm.calculating', { n: missing }) : t('hm.noData', { n: missing }))}` : '';
    const stops = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];
    const cur = this.data.capCur && this.data.capCur !== 'USD' ? this.data.capCur : '';
    const time = new Date(this.data.updated).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    const legend = `<div class="hm-legend">
      <span class="muted">${esc(title)}${note}</span>
      <span class="spacer"></span>
      ${stops.map((s) => `<i style="background:${heatColor(s * max, max)}">${s === 0 ? '0%' : `${s > 0 ? '+' : '−'}${Math.round(Math.abs(s) * max)}%`}</i>`).join('')}
      <span class="muted hm-updated">${esc(cur ? t('hm.legendCur', { cur, time }) : t('hm.legend', { time }))}</span>
    </div>`;
    this.body.innerHTML = `<div class="hm-map" style="height:${h}px">${html.join('')}</div>${legend}`;
  }

  onHover(e) {
    const tile = e.target.closest('.hm-tile');
    if (!tile) { this.tip.hidden = true; return; }
    const r = this.rowBy.get(tile.dataset.sym);
    if (!r) return;
    const d = this.data;
    const cur = d.cur || 'USD', capCur = d.capCur || 'USD';
    const labels = this.isCrypto ? TIP_CRYPTO : TIP_STOCKS;
    const line = (label, v) => `<span>${esc(label)}</span><b class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${pct(v)}</b>`;
    const about = [r.sec && groupName(r.sec), r.ind, r.rank ? t('hm.rank', { rank: r.rank }) : '', chartOf(r) ? '' : t('hm.noChart')].filter(Boolean).join(' · ');
    this.tip.innerHTML = `<div class="hm-tip-head"><b>${esc(r.s)}</b> <span>${esc(r.n || '')}</span></div>
      <div class="muted">${esc(about)}</div>
      <div class="hm-tip-grid"><span>${esc(t('common.price'))}</span><b>${money(r.p, cur)}</b>${PERIODS.map(([k], i) => line(labels[i], r[k])).join('')}<span>${esc(t('hm.marketCap'))}</span><b>${money(r.m, capCur, true)}</b></div>`;
    this.tip.hidden = false;
    const pad = 14;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    const x = e.clientX + pad + tw > window.innerWidth ? e.clientX - tw - pad : e.clientX + pad;
    const y = e.clientY + pad + th > window.innerHeight ? e.clientY - th - pad : e.clientY + pad;
    this.tip.style.left = `${Math.max(4, x)}px`;
    this.tip.style.top = `${Math.max(4, y)}px`;
  }
}
