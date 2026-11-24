// Stock screener panel: ready-made ideas (gainers, unusual volume, breakouts, oversold...),
// filters, a sortable table with signal tags, and market insights, for the US or another stock
// market. Data comes from the server's /api/screener?market= (lib/screener.mjs); clicking a row
// opens it on the active chart.

import { apiUrl, dataMode } from './env.js';
import { $, esc, store, formatVolume, fixed } from './util.js';
import { t, locale } from './i18n.js';
import { groupName as sectorName, MARKETS as HEATMAP_MARKETS, tileCode } from './heatmap.js';

/** Markets: the heatmap's stock markets ('us' is every US-listed stock; the others, a market's largest companies). */
export const MARKETS = HEATMAP_MARKETS.filter(([k]) => k !== 'crypto');
const marketName = (id) => MARKETS.find(([k]) => k === id)?.[1] || id;
// The US list holds every listed stock, so it starts at sizeable, traded ones; the other lists are already the largest.
const marketDefaults = (id) => (id === 'us' ? { cap: 2e9, vol: 5e5 } : { cap: 0, vol: 0 });

const has = (r, ...tags) => tags.some((g) => r.sig.includes(g));
const between = (v, lo, hi) => v != null && v >= lo && v <= hi;

/** Ready-made screens. sort: [column, direction] (-1 = largest first). */
export const IDEAS = [
  { id: 'gainers', label: t('sc.idea.gainers'), hint: t('sc.idea.gainersHint'), filter: (r) => r.c > 0, sort: ['c', -1] },
  { id: 'losers', label: t('sc.idea.losers'), hint: t('sc.idea.losersHint'), filter: (r) => r.c < 0, sort: ['c', 1] },
  { id: 'unusual', label: t('sc.idea.unusual'), hint: t('sc.idea.unusualHint'), filter: (r) => r.rv >= 2, sort: ['rv', -1] },
  { id: 'highs', label: t('sc.idea.highs'), hint: t('sc.idea.highsHint'), filter: (r) => has(r, 'new-high', 'breakout'), sort: ['c', -1] },
  { id: 'lows', label: t('sc.idea.lows'), hint: t('sc.idea.lowsHint'), filter: (r) => has(r, 'new-low', 'breakdown'), sort: ['c', 1] },
  { id: 'uptrend', label: t('sc.idea.uptrend'), hint: t('sc.idea.uptrendHint'), filter: (r) => has(r, 'uptrend') && between(r.rsi, 50, 70), sort: ['r1m', -1] },
  { id: 'downtrend', label: t('sc.idea.downtrend'), hint: t('sc.idea.downtrendHint'), filter: (r) => has(r, 'downtrend'), sort: ['r1m', 1] },
  { id: 'oversold', label: t('sc.idea.oversold'), hint: t('sc.idea.oversoldHint'), filter: (r) => has(r, 'oversold'), sort: ['rsi', 1] },
  { id: 'overbought', label: t('sc.idea.overbought'), hint: t('sc.idea.overboughtHint'), filter: (r) => has(r, 'overbought'), sort: ['rsi', -1] },
  { id: 'gaps', label: t('sc.idea.gaps'), hint: t('sc.idea.gapsHint'), filter: (r) => has(r, 'gap-up', 'gap-down'), sort: ['gapAbs', -1] },
  { id: 'crosses', label: t('sc.idea.crosses'), hint: t('sc.idea.crossesHint'), filter: (r) => has(r, 'golden-cross', 'death-cross'), sort: ['d50', -1] },
  { id: 'earnings', label: t('sc.idea.earnings'), hint: t('sc.idea.earningsHint'), filter: (r) => has(r, 'earnings'), sort: ['er', 1] },
  { id: 'all', label: t('sc.idea.all'), hint: t('sc.idea.allHint'), filter: () => true, sort: ['m', -1] },
];

const CAPS = [[0, t('sc.anySize')], [3e8, '≥ $300M'], [2e9, '≥ $2B'], [1e10, '≥ $10B'], [2e11, '≥ $200B']];
const VOLS = [[0, t('sc.anyVolume')], [1e5, t('sc.volPerDay', { v: '100K' })], [5e5, t('sc.volPerDay', { v: '500K' })],
  [1e6, t('sc.volPerDay', { v: '1M' })], [5e6, t('sc.volPerDay', { v: '5M' })]];

const COLUMNS = [
  ['s', t('common.symbol')], ['p', t('common.price')], ['c', t('common.changePct')], ['rv', t('sc.col.relVol')], ['v', t('common.volume')],
  ['m', t('sc.col.mktCap')], ['d50', t('sc.col.vs50')], ['d200', t('sc.col.vs200')], ['h52', t('sc.col.from52h')], ['rsi', 'RSI'],
  ['r1m', t('sc.col.r1m')], ['sig', t('sc.col.signals')],
];

// Signal ids (from lib/screener.mjs) → [label in the UI language, tone].
const TAGS = {
  'new-high': [t('sc.tag.newHigh'), 'up'], breakout: [t('sc.tag.breakout'), 'up'], 'new-low': [t('sc.tag.newLow'), 'down'],
  breakdown: [t('sc.tag.breakdown'), 'down'], uptrend: [t('sc.tag.uptrend'), 'up'], downtrend: [t('sc.tag.downtrend'), 'down'],
  'golden-cross': [t('sc.tag.goldenCross'), 'up'], 'death-cross': [t('sc.tag.deathCross'), 'down'],
  oversold: [t('sc.idea.oversold'), 'info'], overbought: [t('sc.idea.overbought'), 'info'], 'unusual-volume': [t('common.volume'), 'info'],
  'gap-up': [t('sc.tag.gapUp'), 'up'], 'gap-down': [t('sc.tag.gapDown'), 'down'], earnings: [t('sc.tag.earnings'), 'info'],
};

const pct = (v, d = 2) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fixed(Math.abs(v), d)}%`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
export function fmtCap(m, cur = 'USD') {
  if (!m) return '—';
  if (cur !== 'USD') return new Intl.NumberFormat(locale, { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 }).format(m);
  if (m >= 1e12) return `$${fixed(m / 1e12, 2)}T`;
  if (m >= 1e9) return `$${fixed(m / 1e9, m >= 1e11 ? 0 : 1)}B`;
  return `$${(m / 1e6).toFixed(0)}M`;
}
const day = (ts) => new Date(ts * 1000).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });

function tag(r, id) {
  const [label, tone] = Object.hasOwn(TAGS, id) ? TAGS[id] : [id, 'info'];
  let text = label, title = '';
  if (id === 'unusual-volume') text = t('sc.tag.vol', { x: fixed(r.rv, 1) });
  if (id === 'gap-up' || id === 'gap-down') text = t('sc.tag.gap', { pct: pct(r.gap, 1) });
  if (id === 'earnings' && r.er) { text = t('sc.tag.earningsOn', { date: day(r.er) }); title = t('sc.tag.earningsTitle'); }
  if (id === 'golden-cross' || id === 'death-cross') title = r.cross?.daysAgo === 0 ? t('sc.tag.today') : t('sc.tag.sessionsAgo', { n: r.cross?.daysAgo });
  return `<span class="sc-tag ${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

/**
 * Rows that pass an idea and the filters, sorted. Exported for tests. fx: dollars per unit of the
 * market caps' currency (the size filter is in dollars); null when unknown, which skips that filter.
 */
export function applyScreen(rows, { idea = 'gainers', cap = 0, vol = 0, sector = '', priceMin = 0, fx = 1 } = {}, sort = null) {
  const def = IDEAS.find((x) => x.id === idea) || IDEAS[0];
  const [key, dir] = sort || def.sort;
  const val = (r) => (key === 'gapAbs' ? Math.abs(r.gap ?? 0) : key === 'sig' ? r.sig.length : r[key]);
  return rows
    .filter((r) => (!cap || fx == null || (r.m || 0) * fx >= cap) && ((r.av ?? r.v) || 0) >= vol && (!sector || r.sec === sector) && (r.p || 0) >= priceMin && def.filter(r))
    .sort((a, b) => {
      const x = val(a), y = val(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1; // missing values last, whatever the direction
      if (y == null) return -1;
      return typeof x === 'string' ? dir * x.localeCompare(y) : dir * (x - y);
    });
}

export class Screener {
  constructor({ onPick, getActiveSymbol }) {
    this.onPick = onPick;
    this.getActiveSymbol = getActiveSymbol;
    this.el = $('#screener');
    this.body = $('#sc-body');
    this.data = null;
    this.timer = null;
    this.selected = -1;
    this.shown = [];
    const saved = store.get('screener', {});
    this.state = { market: 'us', idea: 'gainers', cap: 2e9, vol: 5e5, sector: '', priceMin: 0, ...saved };
    if (!MARKETS.some(([k]) => k === this.state.market)) this.state.market = 'us';
    this.sort = null; // column clicked by the user (else the idea's own order)

    this.el.querySelector('#sc-close').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    const handle = this.el.querySelector('.ed-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => this.setHeight(window.innerHeight - ev.clientY - 28);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.dispatchEvent(new Event('resize')); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.setHeight(store.get('screenerHeight', 430), false);
    this.renderSub();
  }

  /** The title bar's note: which market, and how to use the table. */
  renderSub() {
    const sub = this.el.querySelector('.sc-sub');
    const m = this.state.market;
    if (sub) sub.textContent = m === 'us' ? t('app.sc.sub') : `${marketName(m)} · ${t('sc.subHint')}`;
  }

  showScanning() {
    const m = this.state.market;
    this.body.innerHTML = m === 'us'
      ? `<div class="st-empty"><b>${t('sc.scanning')}</b><span>${t('sc.scanningBody')}</span></div>`
      : `<div class="st-empty"><b>${esc(marketName(m))}</b><span>${esc(t('hm.loadingMarket', { market: marketName(m) }))}</span></div>`;
  }

  get isOpen() { return !this.el.hidden; }

  setHeight(h, save = true) {
    const height = Math.round(Math.max(220, Math.min(window.innerHeight * 0.85, h)));
    this.el.style.height = `${height}px`;
    if (save) store.set('screenerHeight', height);
  }

  async open() {
    this.el.hidden = false;
    document.body.classList.add('screener-open');
    window.dispatchEvent(new Event('resize'));
    if ((await dataMode()) !== 'server') {
      this.body.innerHTML = `<div class="st-empty"><b>${t('sc.desktopOnly')}</b>
        <span>${t('sc.desktopOnlyBody')}</span></div>`;
      return;
    }
    if (!this.data) this.showScanning();
    this.load();
  }

  close() {
    this.el.hidden = true;
    document.body.classList.remove('screener-open');
    clearTimeout(this.timer);
    window.dispatchEvent(new Event('resize'));
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  async load() {
    clearTimeout(this.timer);
    const market = this.state.market;
    try {
      const r = await fetch(apiUrl(`api/screener?market=${encodeURIComponent(market)}`));
      const j = await r.json();
      if (market !== this.state.market) return; // another market was picked meanwhile (its load is under way)
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      this.data = j;
      this.render();
    } catch (e) {
      if (market !== this.state.market) return;
      if (!this.data) this.body.innerHTML = `<div class="st-empty"><b>${t('sc.loadError')}</b><span>${esc(e.message)}</span></div>`;
    }
    if (!this.isOpen) return;
    // Faster while the trend metrics are still being calculated.
    const busy = this.data && this.data.tech.done < this.data.tech.total;
    this.timer = setTimeout(() => this.load(), busy ? 15000 : 60000);
  }

  save() { store.set('screener', this.state); }

  onChange(e) {
    const k = e.target.dataset?.f;
    if (!k) return;
    if (k === 'market') {
      const m = e.target.value;
      Object.assign(this.state, { market: m, sector: '', priceMin: 0 }, marketDefaults(m));
      this.save();
      this.sort = null;
      this.selected = -1;
      this.data = null;
      this.renderSub();
      this.showScanning();
      this.load();
      return;
    }
    this.state[k] = k === 'sector' ? e.target.value : Number(e.target.value) || 0;
    this.save();
    this.selected = -1;
    this.render();
  }

  onClick(e) {
    const idea = e.target.closest('[data-idea]');
    if (idea) { this.state.idea = idea.dataset.idea; this.sort = null; this.selected = -1; this.save(); this.render(); return; }
    const sector = e.target.closest('[data-sector]');
    if (sector) { this.state.sector = this.state.sector === sector.dataset.sector ? '' : sector.dataset.sector; this.save(); this.render(); return; }
    const th = e.target.closest('[data-sort]');
    if (th) {
      const key = th.dataset.sort;
      const cur = this.sort || IDEAS.find((x) => x.id === this.state.idea).sort;
      this.sort = [key, cur[0] === key ? -cur[1] : key === 's' || key === 'sec' ? 1 : -1];
      this.render();
      return;
    }
    const row = e.target.closest('[data-row]');
    if (row) this.pick(Number(row.dataset.row));
  }

  onKey(e) {
    if (!e.target.closest('.sc-table-wrap') || !this.shown.length) return;
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    e.stopPropagation();
    const next = Math.max(0, Math.min(this.shown.length - 1, this.selected + (e.key === 'ArrowDown' ? 1 : -1)));
    this.pick(next);
  }

  pick(i) {
    const r = this.shown[i];
    if (!r) return;
    this.selected = i;
    this.body.querySelectorAll('[data-row]').forEach((el) => el.classList.toggle('active', Number(el.dataset.row) === i));
    this.body.querySelector(`[data-row="${i}"]`)?.scrollIntoView({ block: 'nearest' });
    // Holding an arrow key flips through rows quickly; load the chart once it settles.
    clearTimeout(this.pickTimer);
    this.pickTimer = setTimeout(() => this.onPick(`YAHOO:${r.s}`), 120);
  }

  render() {
    const d = this.data;
    if (!d || !this.isOpen) return;
    const st = this.state;
    const all = applyScreen(d.rows, { ...st, fx: d.fx === undefined ? 1 : d.fx }, this.sort);
    const capCur = d.capCur || 'USD';
    this.shown = all.slice(0, 300);
    const sort = this.sort || IDEAS.find((x) => x.id === st.idea).sort;
    const sectors = [...new Set(d.rows.map((r) => r.sec).filter(Boolean))].sort();
    const active = this.getActiveSymbol?.();
    const i = d.insights;
    const breadth = i.up + i.down ? Math.round((i.up / (i.up + i.down)) * 100) : 50;
    const option = (list, cur) => list.map(([v, l]) => `<option value="${v}"${Number(cur) === v ? ' selected' : ''}>${l}</option>`).join('');
    const sectorChip = (s) => `<button class="sc-sector${st.sector === s.sec ? ' on' : ''}" data-sector="${esc(s.sec)}" title="${esc(t('sc.sectorTitle', { up: s.up, down: s.down }))}">
        ${esc(sectorName(s.sec))} <b class="${cls(s.change)}">${pct(s.change)}</b></button>`;
    const cell = (r, key) => {
      switch (key) {
        case 's': {
          const code = tileCode(r.s, st.market);
          return `<td class="sc-sym" title="${esc([code !== r.s && r.s, r.n, r.sec && sectorName(r.sec), r.ind].filter(Boolean).join(' · '))}"><b>${esc(code)}</b><span>${esc(r.n || '')}</span></td>`;
        }
        case 'p': return `<td>${r.p != null ? r.p.toLocaleString(locale, { maximumFractionDigits: r.p < 1 ? 4 : 2, minimumFractionDigits: 2 }) : '—'}</td>`;
        case 'c': case 'd50': case 'd200': case 'h52': case 'r1m': return `<td class="${cls(r[key])}">${pct(r[key])}</td>`;
        case 'rv': return `<td class="${r.rv >= 2 ? 'hot' : ''}">${r.rv != null ? `${fixed(r.rv, 2)}×` : '—'}</td>`;
        case 'v': return `<td>${r.v != null ? formatVolume(r.v) : '—'}</td>`;
        case 'm': return `<td>${fmtCap(r.m, capCur)}</td>`;
        case 'rsi': return `<td class="${r.rsi > 70 ? 'down' : r.rsi < 30 ? 'up' : ''}">${r.rsi != null ? r.rsi.toFixed(0) : '—'}</td>`;
        case 'sec': return `<td class="sc-sec">${esc(sectorName(r.sec))}</td>`;
        case 'sig': return `<td class="sc-tags">${r.sig.slice(0, 3).map((id) => tag(r, id)).join('')}</td>`;
        default: return '<td></td>';
      }
    };
    // Keep the table's scroll position and keyboard focus across refreshes.
    const oldWrap = this.body.querySelector('.sc-table-wrap');
    const scroll = oldWrap?.scrollTop || 0;
    const focused = !!oldWrap && document.activeElement === oldWrap;
    const updated = new Date(d.updated).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const techNote = d.tech.done < d.tech.total ? ` · ${t('sc.calcTrends', { done: d.tech.done.toLocaleString(locale), total: d.tech.total.toLocaleString(locale) })}` : '';
    const count = all.length > 300 ? t('sc.matchesCapped', { n: all.length.toLocaleString(locale), max: 300 }) : t('sc.matches', { n: all.length.toLocaleString(locale) });
    this.body.innerHTML = `
      <div class="sc-insights">
        <div class="sc-breadth" title="${esc(t('sc.breadthTitle'))}">
          <span class="up">${t('sc.up', { n: i.up.toLocaleString(locale) })}</span>
          <span class="sc-bar"><i style="width:${breadth}%"></i></span>
          <span class="down">${t('sc.down', { n: i.down.toLocaleString(locale) })}</span>
        </div>
        <span class="sc-stat" title="${esc(t('sc.above50Title'))}">${t('sc.above50')} <b>${i.above50 ?? '—'}%</b></span>
        <span class="sc-stat" title="${esc(t('sc.above200Title'))}">${t('sc.above200')} <b>${i.above200 ?? '—'}%</b></span>
        <button class="sc-stat link" data-idea="highs">${t('sc.highs')} <b class="up">${i.newHighs}</b></button>
        <button class="sc-stat link" data-idea="lows">${t('sc.lows')} <b class="down">${i.newLows}</b></button>
        <button class="sc-stat link" data-idea="unusual">${t('sc.idea.unusual')} <b>${i.unusualVolume}</b></button>
        <button class="sc-stat link" data-idea="earnings">${t('sc.idea.earnings')} <b>${i.earnings}</b></button>
      </div>
      <div class="sc-sectors">${i.sectors.slice(0, 4).map(sectorChip).join('')}<span class="sc-dots">…</span>${i.sectors.slice(-3).map(sectorChip).join('')}</div>
      <div class="sc-ideas" role="tablist">${IDEAS.map((x) => `<button data-idea="${x.id}" class="${x.id === st.idea ? 'on' : ''}" title="${esc(x.hint)}">${esc(x.label)}</button>`).join('')}</div>
      <div class="sc-filters">
        <select class="select" data-f="market" aria-label="${esc(t('hm.market'))}" title="${esc(t('hm.market'))}">${MARKETS.map(([k, name]) => `<option value="${k}"${k === st.market ? ' selected' : ''}>${esc(name)}</option>`).join('')}</select>
        <select class="select" data-f="cap" aria-label="${esc(t('sc.capLabel'))}">${option(CAPS, st.cap)}</select>
        <select class="select" data-f="vol" aria-label="${esc(t('sc.volLabel'))}">${option(VOLS, st.vol)}</select>
        <select class="select" data-f="sector" aria-label="${esc(t('sc.sectorLabel'))}"><option value="">${t('sc.allSectors')}</option>${sectors.map((s) => `<option value="${esc(s)}"${s === st.sector ? ' selected' : ''}>${esc(sectorName(s))}</option>`).join('')}</select>
        <label class="sc-price">${t('sc.priceMin')} <input type="number" min="0" step="1" data-f="priceMin" value="${st.priceMin || ''}" placeholder="0"></label>
        <span class="muted sc-count">${count}</span>
        <span class="spacer"></span>
        <span class="muted sc-updated">${d.limited ? `${t('sc.limited')} · ` : ''}${t('sc.updated', { time: updated })}${techNote}</span>
      </div>
      <div class="sc-table-wrap" tabindex="0" aria-label="${esc(t('sc.tableLabel'))}">
        ${this.shown.length ? `<table class="sc-table">
          <thead><tr>${COLUMNS.map(([k, label]) => `<th data-sort="${k}" class="${sort[0] === k ? `sorted ${sort[1] > 0 ? 'asc' : 'desc'}` : ''}">${label}</th>`).join('')}</tr></thead>
          <tbody>${this.shown.map((r, n) => `<tr data-row="${n}" class="${r.s === active ? 'current ' : ''}${n === this.selected ? 'active' : ''}">${COLUMNS.map(([k]) => cell(r, k)).join('')}</tr>`).join('')}</tbody>
        </table>` : `<div class="st-empty"><b>${t('sc.noMatch')}</b><span>${t('sc.noMatchHint')}</span></div>`}
      </div>`;
    const wrap = this.body.querySelector('.sc-table-wrap');
    wrap.scrollTop = scroll;
    if (focused) wrap.focus({ preventScroll: true });
  }
}
