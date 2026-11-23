// Heatmap panel: a market's largest stocks (or coins) as tiles grouped by sector, sized by market
// cap and coloured by how much they moved (today, this week, month, 3 months or year). US stocks
// come from the server's /api/screener (the same scan as the Screener); crypto and stock markets
// outside the US from /api/heatmap (lib/heatmap-markets.mjs). Clicking a tile opens its chart.
// The layout, colour and formatting functions are pure and unit-tested in test/heatmap.test.mjs
// and test/heatmap-markets.test.mjs.

import { apiUrl, dataMode } from './env.js';
import { $, esc, store } from './util.js';

/** Periods: the row field, and the change that gets the strongest colour. */
export const PERIODS = [
  ['c', '1D', 'Today', 3], ['r1w', '1W', 'This week', 6], ['r1m', '1M', 'This month', 10],
  ['r3m', '3M', '3 months', 20], ['y1', '1Y', '1 year', 40],
];
// Crypto moves more: the same colours stand for twice the change, and changes are rolling.
const CRYPTO_SCALE = 2;
const CRYPTO_TITLES = { c: 'Last 24 hours', r1w: 'Last 7 days', r1m: 'Last 30 days', r3m: 'Last 90 days', y1: 'Last 12 months' };

/** Markets: id (for /api/heatmap; 'us' is the Screener's scan) and name. */
export const MARKETS = [
  ['us', 'United States'], ['GB', 'United Kingdom'], ['DE', 'Germany'], ['FR', 'France'], ['NL', 'Netherlands'],
  ['IT', 'Italy'], ['ES', 'Spain'], ['CH', 'Switzerland'], ['SE', 'Sweden'], ['JP', 'Japan'], ['CN', 'China'],
  ['HK', 'Hong Kong'], ['KR', 'South Korea'], ['TW', 'Taiwan'], ['IN', 'India'], ['CA', 'Canada'], ['AU', 'Australia'],
  ['BR', 'Brazil'], ['crypto', 'Crypto'],
];
const marketName = (id) => MARKETS.find(([k]) => k === id)?.[1] || id;

/** How many tiles each kind of market offers. */
export function sizesFor(market) {
  if (market === 'us') return [[100, 'Top 100'], [250, 'Top 250'], [500, 'Top 500'], [1000, 'Top 1000']];
  if (market === 'crypto') return [[50, 'Top 50'], [100, 'Top 100'], [250, 'Top 250']];
  return [[50, 'Top 50'], [100, 'Top 100'], [250, 'Top 250'], [500, 'Top 500']];
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
  if (cur === 'GBp' || cur === 'GBX') return compact ? money(v / 100, 'GBP', true) : `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}p`;
  const opts = compact ? { notation: 'compact', maximumSignificantDigits: 3 } : Math.abs(v) < 1 ? { maximumSignificantDigits: 4 } : {};
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', ...opts }).format(v);
  } catch {
    return `${v.toLocaleString('en-US', { maximumSignificantDigits: 6 })} ${cur}`;
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

const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`);
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
      this.body.innerHTML = `<div class="st-empty"><b>The heatmap runs in the desktop app</b>
        <span>It scans thousands of stocks in 18 markets, and the top coins, with data a website can't fetch directly. Download the desktop app, or run it with <code>npm start</code>.</span></div>`;
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
    const what = m === 'us' ? 'The first scan of US stocks takes a few seconds.'
      : m === 'crypto' ? 'Fetching the largest coins by market cap.' : `The first scan of ${esc(marketName(m))}'s stocks takes a few seconds.`;
    this.body.innerHTML = `<div class="st-empty"><b>Loading the market…</b><span>${what}</span></div>`;
  }

  showError(msg) {
    this.body.innerHTML = `<div class="st-empty"><b>Couldn't load the heatmap</b><span>${esc(msg)}</span>
      <button type="button" class="btn-ghost hm-retry" data-hm-retry="1">Try again</button></div>`;
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
      if (!Array.isArray(j.rows)) throw new Error('Unexpected answer from the server');
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

  /** What the groups are: sectors, or (crypto) categories or rank tiers. */
  get groupWord() {
    if (!this.isCrypto) return ['sector', 'sectors'];
    return this.data?.grouping === 'rank' ? ['group', 'groups'] : ['category', 'categories'];
  }

  renderBar() {
    const st = this.state;
    const ok = periodsAvailable(this.data);
    const [word, words] = this.groupWord;
    const sub = this.el.querySelector('.sc-sub');
    if (sub) {
      const d = this.data;
      sub.textContent = st.market === 'us' ? 'US stocks by sector · click a tile to open its chart'
        : this.isCrypto ? `Top coins by ${d?.grouping === 'rank' ? 'market-cap rank' : 'category'}, no stablecoins · click a tile to open its chart`
          : `Stocks by sector${d?.capCur ? ` · sizes in ${d.capCur}` : ''} · click a tile to open its chart`;
    }
    const key = [st.market, st.period, st.sector, this.top, word, [...ok].join()].join('|');
    if (key === this.barKey) return; // unchanged: don't rebuild (and close) an open menu
    this.barKey = key;
    const shown = this.period[0];
    const sizes = sizesFor(st.market);
    const option = ([k, name]) => `<option value="${k}"${st.market === k ? ' selected' : ''}>${esc(name)}</option>`;
    $('#hm-tools').innerHTML = `
      <select class="select" data-f="market" aria-label="Market" title="Market">
        <optgroup label="Stocks">${MARKETS.filter(([k]) => k !== 'crypto').map(option).join('')}</optgroup>
        <optgroup label="Crypto">${option(['crypto', 'Crypto (top coins)'])}</optgroup>
      </select>
      <div class="nw-seg" role="tablist" aria-label="Period">${PERIODS.map(([k, label, title]) => {
        const off = !ok.has(k);
        const tip = off ? 'Not available for this market' : this.isCrypto ? CRYPTO_TITLES[k] : title;
        return `<button data-hm-period="${k}" class="${shown === k ? 'on' : ''}" title="${tip}"${off ? ' disabled' : ''}>${label}</button>`;
      }).join('')}</div>
      <select class="select" data-f="top" aria-label="How many">${sizes.map(([v, l]) => `<option value="${v}"${this.top === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
      <span class="hm-crumb">${st.sector ? `<button data-hm-sector="" title="Back to every ${word}">All ${words}</button> › <b>${esc(st.sector)}</b>` : `<span class="muted">Click a ${word} name to zoom in</span>`}</span>`;
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
    const [word] = this.groupWord;
    const html = [];
    for (const t of tiles) {
      if (t.w < 1 || t.h < 1) continue;
      const v = t.r[key];
      const big = t.w > 56 && t.h > 34;
      const fs = Math.max(9, Math.min(30, Math.min(t.w / 4.2, t.h / 2.6)));
      const text = big
        ? `<b style="font-size:${fs.toFixed(0)}px">${esc(t.r.s)}</b><small style="font-size:${Math.max(9, fs * 0.6).toFixed(0)}px">${pct(v)}</small>`
        : t.w > 26 && t.h > 13 ? `<b style="font-size:${Math.max(8, Math.min(12, t.h / 1.6, t.w / 4)).toFixed(0)}px">${esc(t.r.s)}</b>` : '';
      const full = chartOf(t.r);
      html.push(`<div class="hm-tile${full ? '' : ' no-chart'}" data-sym="${esc(t.r.s)}"${full ? ` data-full="${esc(full)}"` : ''} style="left:${t.x.toFixed(1)}px;top:${t.y.toFixed(1)}px;width:${t.w.toFixed(1)}px;height:${t.h.toFixed(1)}px;background:${heatColor(v, max)}">${text}</div>`);
    }
    for (const l of labels) {
      html.push(`<button class="hm-sector" data-hm-sector="${esc(st.sector ? '' : l.sector)}" style="left:${l.x.toFixed(1)}px;top:${l.y.toFixed(1)}px;width:${l.w.toFixed(1)}px" title="${st.sector ? `Back to every ${word}` : `Zoom in on ${esc(l.name)}`}">${esc(l.name)}</button>`);
    }
    const busy = this.data.tech && this.data.tech.done < this.data.tech.total;
    const missing = tiles.filter((t) => t.r[key] == null).length;
    const note = this.error ? ` · couldn't update (${esc(this.error)}), retrying`
      : missing ? ` · ${missing} ${busy && key !== 'c' ? 'still being calculated' : 'without data'}` : '';
    const stops = [-1, -0.66, -0.33, 0, 0.33, 0.66, 1];
    const cap = this.data.capCur && this.data.capCur !== 'USD' ? ` in ${esc(this.data.capCur)}` : '';
    const legend = `<div class="hm-legend">
      <span class="muted">${esc(title)}${note}</span>
      <span class="spacer"></span>
      ${stops.map((s) => `<i style="background:${heatColor(s * max, max)}">${s === 0 ? '0%' : `${s > 0 ? '+' : '−'}${Math.round(Math.abs(s) * max)}%`}</i>`).join('')}
      <span class="muted hm-updated">Size: market cap${cap} · updated ${new Date(this.data.updated).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
    </div>`;
    this.body.innerHTML = `<div class="hm-map" style="height:${h}px">${html.join('')}</div>${legend}`;
  }

  onHover(e) {
    const t = e.target.closest('.hm-tile');
    if (!t) { this.tip.hidden = true; return; }
    const r = this.rowBy.get(t.dataset.sym);
    if (!r) return;
    const d = this.data;
    const cur = d.cur || 'USD', capCur = d.capCur || 'USD';
    const labels = this.isCrypto ? ['24 hours', '7 days', '30 days', '90 days', '1 year'] : ['Today', '1 week', '1 month', '3 months', '1 year'];
    const line = (label, v) => `<span>${label}</span><b class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${pct(v)}</b>`;
    const about = [r.sec, r.ind, r.rank ? `#${r.rank} by market cap` : '', chartOf(r) ? '' : 'no chart for this coin'].filter(Boolean).join(' · ');
    this.tip.innerHTML = `<div class="hm-tip-head"><b>${esc(r.s)}</b> <span>${esc(r.n || '')}</span></div>
      <div class="muted">${esc(about)}</div>
      <div class="hm-tip-grid"><span>Price</span><b>${money(r.p, cur)}</b>${PERIODS.map(([k], i) => line(labels[i], r[k])).join('')}<span>Market cap</span><b>${money(r.m, capCur, true)}</b></div>`;
    this.tip.hidden = false;
    const pad = 14;
    const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
    const x = e.clientX + pad + tw > window.innerWidth ? e.clientX - tw - pad : e.clientX + pad;
    const y = e.clientY + pad + th > window.innerHeight ? e.clientY - th - pad : e.clientY + pad;
    this.tip.style.left = `${Math.max(4, x)}px`;
    this.tip.style.top = `${Math.max(4, y)}px`;
  }
}
