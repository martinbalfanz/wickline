// News panel: live headlines ranked by how much they're moving markets, for the US or another
// region (or the latest news on the active chart's symbol), plus the economic calendar and
// earnings for the countries the reader picks. Data comes from the server's /api/news and
// /api/calendar (lib/news.mjs, lib/calendar.mjs, lib/markets.mjs).

import { apiUrl, dataMode } from './env.js';
import { $, esc, store, fixed } from './util.js';
import { fmtCap } from './screener.js';
import { t, locale } from './i18n.js';

const NEWS_EVERY = 30000;
const CALENDAR_EVERY = 60000;

export const TOPICS = [['all', t('common.all')], ['stocks', t('news.topic.stocks')], ['earnings', t('news.topic.earnings')],
  ['economy', t('news.topic.economy')], ['crypto', t('news.topic.crypto')]];
const CAPS = [[1e9, '$1B+'], [2e9, '$2B+'], [1e10, '$10B+'], [1e11, '$100B+']];
export const REGIONS = [['world', t('news.region.world')], ['us', t('news.region.us')], ['gb', t('news.region.gb')], ['eu', t('news.region.eu')],
  ['asia', t('news.region.asia')], ['in', t('news.region.in')], ['ca', t('news.region.ca')], ['au', t('news.region.au')]];

// Calendar countries: these first in the picker; DEFAULT_COUNTRIES until the reader picks.
const MAJOR = ['US', 'EU', 'GB', 'DE', 'FR', 'IT', 'ES', 'NL', 'CH', 'SE', 'JP', 'CN', 'HK', 'KR', 'TW', 'IN', 'CA', 'AU', 'NZ', 'BR', 'MX'];
export const DEFAULT_COUNTRIES = ['US', 'EU', 'GB', 'DE', 'FR', 'IT', 'JP', 'CN', 'CA'];
const regionNames = (() => { try { return new Intl.DisplayNames([locale, 'en'], { type: 'region' }); } catch { return null; } })();
/** "GB" → "United Kingdom", "EU" → "Euro area" (in the UI language). */
export const countryName = (c) => (c === 'EU' ? t('news.euroArea') : (() => { try { return regionNames?.of(c) || c; } catch { return c; } })());
/** The short label shown in the calendar: ISO codes, except "UK". */
export const countryLabel = (c) => (c === 'GB' ? 'UK' : c);
/** Whether a country is picked (['*'] picks every one). */
export const inCountries = (c, list) => list.includes('*') || list.includes(c);
/** "All countries", "Japan", "US, EU, UK +6". */
export function countriesSummary(list) {
  if (list.includes('*')) return t('news.allCountries');
  if (!list.length) return t('news.noCountries');
  if (list.length === 1) return countryName(list[0]);
  return list.slice(0, 3).map(countryLabel).join(', ') + (list.length > 3 ? ` +${list.length - 3}` : '');
}

/** The symbol to ask for news about: "YAHOO:NVDA" → "NVDA", "BINANCE:BTCUSDT" → "BTC". */
export function newsSymbol(full) {
  if (!full) return '';
  const [src, raw = ''] = full.includes(':') ? full.split(':') : ['YAHOO', full];
  if (src === 'YAHOO') return raw.toUpperCase();
  return raw.toUpperCase().replace(/[-/]?(USDT|USDC|BUSD|FDUSD|USD|EUR|BTC)$/, '') || raw.toUpperCase();
}

/** "3m", "2h", "Mon 14:05" for older ones. */
export function ago(ts, now = Date.now() / 1000) {
  const s = Math.max(0, now - ts);
  if (s < 60) return t('news.ago.now');
  if (s < 3600) return t('news.ago.m', { n: Math.floor(s / 60) });
  if (s < 86400) return t('news.ago.h', { n: Math.floor(s / 3600) });
  return new Date(ts * 1000).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** "in 2h 14m", "in 3d 4h", "now". */
export function countdown(ts, now = Date.now() / 1000) {
  const s = ts - now;
  if (s <= 60) return t('news.in.now');
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? t('news.in.dh', { d, h }) : h ? t('news.in.hm', { h, m }) : t('news.in.m', { m });
}

/** Stories for a topic chip, hottest first or newest first. */
export function filterStories(stories, { topic = 'all', view = 'top' } = {}) {
  const list = stories.filter((s) => topic === 'all' || s.topics.includes(topic));
  return view === 'latest' ? [...list].sort((a, b) => b.t - a.t) : list;
}

const PCT_NAME = /MoM|YoY|QoQ|\bRate\b|\bInf\b|Inflation|Change|Utilization/i;
/** An economic value as shown: 0.2 → "0.2%" for rates and changes, 1250 → "1,250". */
export function fmtEcon(v, name = '') {
  if (v == null) return '—';
  const n = typeof v === 'number' ? v.toLocaleString(locale, { maximumFractionDigits: 6 }) : String(v);
  return PCT_NAME.test(name) ? `${n}%` : n;
}

const pct = (v) => (v == null ? '' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fixed(Math.abs(v), Math.abs(v) >= 10 ? 1 : 2)}%`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const time = (ts) => new Date(ts * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
const dayKey = (ts) => new Date(ts * 1000).toDateString();

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const diff = Math.round((new Date(d.toDateString()) - new Date(today.toDateString())) / 86400000);
  const date = d.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
  return diff === 0 ? t('news.today', { date }) : diff === 1 ? t('news.tomorrow', { date }) : diff === -1 ? t('news.yesterday', { date }) : date;
}

export class NewsPanel {
  constructor({ onPick, getActiveSymbol }) {
    this.onPick = onPick;
    this.getActiveSymbol = getActiveSymbol;
    this.el = $('#news');
    this.body = $('#nw-body');
    this.news = null; // last /api/news (top stories)
    this.symbolNews = null; // last /api/news?symbol=
    this.cal = null;
    this.seen = null; // story ids already shown, to highlight new ones
    this.newsGen = 0; // so a slow response from an earlier request can't start a second refresh loop
    this.calGen = 0;
    this.state = { view: 'top', topic: 'all', cal: 'econ', keyOnly: true, minCap: 1e10, region: 'us', countries: DEFAULT_COUNTRIES, ...store.get('news', {}) };
    if (!REGIONS.some(([id]) => id === this.state.region)) this.state.region = 'us';
    if (!Array.isArray(this.state.countries)) this.state.countries = DEFAULT_COUNTRIES;
    this.pickOpen = false; // the calendar's country list

    // Close the country list on a click outside it, or Escape.
    document.addEventListener('pointerdown', (e) => {
      if (this.pickOpen && !e.target.closest('.nw-pop, .nw-pick')) this.setPick(false);
    });
    this.el.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.pickOpen) { e.stopPropagation(); this.setPick(false); } });

    this.el.querySelector('#nw-close').addEventListener('click', () => this.close());
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    const handle = this.el.querySelector('.ed-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => this.setHeight(window.innerHeight - ev.clientY - 28);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.dispatchEvent(new Event('resize')); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.setHeight(store.get('newsHeight', 400), false);
  }

  get isOpen() { return !this.el.hidden; }

  setHeight(h, save = true) {
    const height = Math.round(Math.max(220, Math.min(window.innerHeight * 0.85, h)));
    this.el.style.height = `${height}px`;
    if (save) store.set('newsHeight', height);
  }

  save() { store.set('news', this.state); }

  get symbol() { return newsSymbol(this.getActiveSymbol?.()); }

  async open() {
    this.el.hidden = false;
    document.body.classList.add('news-open');
    window.dispatchEvent(new Event('resize'));
    if ((await dataMode()) !== 'server') {
      this.body.innerHTML = `<div class="st-empty"><b>${t('news.desktopOnly')}</b>
        <span>${t('news.desktopOnlyBody')}</span></div>`;
      return;
    }
    if (!this.news) this.body.innerHTML = `<div class="st-empty"><b>${t('news.loadingAll')}</b><span>${t('news.loadingAllBody')}</span></div>`;
    this.loadNews();
    this.loadCalendar();
    // Keep "in 2h 14m" and "5m ago" current between refreshes.
    clearInterval(this.clock);
    this.clock = setInterval(() => this.renderClock(), 15000);
  }

  close() {
    this.el.hidden = true;
    document.body.classList.remove('news-open');
    clearTimeout(this.newsTimer);
    clearTimeout(this.calTimer);
    clearInterval(this.clock);
    this.newsGen++;
    this.calGen++;
    this.pickOpen = false;
    window.dispatchEvent(new Event('resize'));
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  /** Called when the active chart changes: the symbol tab follows it. */
  syncSymbol() {
    if (!this.isOpen || (!this.news && !this.symbolNews)) return;
    const sym = this.symbol;
    if (sym === this.renderedSymbol) return;
    if (this.state.view === 'symbol') { this.symbolNews = null; this.loadNews(); }
    this.render();
  }

  async loadNews() {
    clearTimeout(this.newsTimer);
    const gen = ++this.newsGen;
    const sym = this.state.view === 'symbol' ? this.symbol : '';
    const query = sym ? `symbol=${encodeURIComponent(sym)}` : `region=${encodeURIComponent(this.state.region)}`;
    try {
      const r = await fetch(apiUrl(`api/news?${query}`));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (gen !== this.newsGen) return;
      if (sym) this.symbolNews = j;
      else this.news = j;
      this.error = null;
    } catch (e) {
      if (gen !== this.newsGen) return;
      this.error = e.message;
    }
    if (!this.isOpen) return;
    this.render();
    this.newsTimer = setTimeout(() => this.loadNews(), NEWS_EVERY);
  }

  async loadCalendar() {
    clearTimeout(this.calTimer);
    const gen = ++this.calGen;
    try {
      const r = await fetch(apiUrl('api/calendar'));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      if (gen !== this.calGen) return;
      this.cal = j;
      this.calError = null;
    } catch (e) {
      if (gen !== this.calGen) return;
      this.calError = e.message;
    }
    if (!this.isOpen) return;
    this.renderCalendar();
    this.calTimer = setTimeout(() => this.loadCalendar(), CALENDAR_EVERY);
  }

  onChange(e) {
    const f = e.target.dataset.f;
    if (f === 'keyOnly') { this.state.keyOnly = e.target.checked; this.save(); this.renderCalendar(); }
    if (f === 'minCap') { this.state.minCap = Number(e.target.value); this.save(); this.renderCalendar(); }
    if (f === 'region') {
      this.state.region = e.target.value;
      this.save();
      this.news = null; // a different set of headlines
      this.seen = null;
      this.render();
      this.loadNews();
    }
    const cc = e.target.dataset.cc;
    if (cc) {
      const all = this.calCountries().map(([c]) => c);
      let list = this.state.countries.includes('*') ? all : [...this.state.countries];
      list = e.target.checked ? [...new Set([...list, cc])] : list.filter((c) => c !== cc);
      this.state.countries = list;
      this.save();
      this.renderCalendar();
    }
  }

  setPick(open) {
    this.pickOpen = open;
    this.renderCalendar();
  }

  /** Countries in the calendar data: [[code, count in the current tab]], major economies first. */
  calCountries() {
    const c = this.cal;
    if (!c) return [];
    const counts = new Map();
    for (const e of this.state.cal === 'econ' ? c.econ : c.earnings) counts.set(e.c, (counts.get(e.c) || 0) + 1);
    for (const e of [...c.econ, ...c.earnings]) if (!counts.has(e.c)) counts.set(e.c, 0);
    const rank = (x) => { const i = MAJOR.indexOf(x); return i < 0 ? 1000 : i; };
    return [...counts].sort((a, b) => rank(a[0]) - rank(b[0]) || countryName(a[0]).localeCompare(countryName(b[0])));
  }

  onClick(e) {
    const tk = e.target.closest('[data-full]');
    if (tk) { e.preventDefault(); this.onPick(tk.dataset.full); return; }
    const view = e.target.closest('[data-view]');
    if (view) {
      this.state.view = view.dataset.view;
      this.save();
      if (this.state.view === 'symbol') this.symbolNews = null;
      this.render();
      this.loadNews();
      return;
    }
    const topic = e.target.closest('[data-topic]');
    if (topic) { this.state.topic = topic.dataset.topic; this.save(); this.render(); return; }
    const cal = e.target.closest('[data-cal]');
    if (cal) { this.state.cal = cal.dataset.cal; this.save(); this.renderCalendar(); return; }
    if (e.target.closest('.nw-pick')) { this.setPick(!this.pickOpen); return; }
    const set = e.target.closest('[data-ccset]');
    if (set) {
      this.state.countries = { major: DEFAULT_COUNTRIES, all: ['*'], us: ['US'] }[set.dataset.ccset] || DEFAULT_COUNTRIES;
      this.save();
      this.renderCalendar();
    }
  }

  chip(s, quotes) {
    const q = quotes?.[s];
    const full = q?.full || `YAHOO:${s}`;
    const move = q?.c != null ? `<b class="${cls(q.c)}">${q.session === 'pre' ? t('news.chipPre', { pct: pct(q.c) }) : pct(q.c)}</b>` : '';
    return `<button class="nw-tk" data-full="${esc(full)}" title="${esc(t('news.openChart', { symbol: s }))}">${esc(s)}${move}</button>`;
  }

  render() {
    if (!this.isOpen) return;
    const built = !!this.body.querySelector('.nw-feed');
    if (!built && !this.news && !this.symbolNews && !this.error) return; // keep the first "Loading…" message
    if (!built) {
      this.body.innerHTML = '<div class="nw-feed"></div><div class="nw-cal"></div>';
      this.renderCalendar();
    }
    const st = this.state;
    const sym = this.symbol;
    this.renderedSymbol = sym;
    const symbolView = st.view === 'symbol';
    const data = symbolView ? this.symbolNews : this.news;
    const stories = data ? filterStories(data.stories, symbolView ? { view: 'latest' } : st) : [];
    const counts = Object.fromEntries(TOPICS.map(([id]) => [id, this.news ? filterStories(this.news.stories, { topic: id }).length : 0]));
    const feed = this.body.querySelector('.nw-feed');
    const oldList = feed.querySelector('.nw-list');
    const scroll = oldList?.scrollTop || 0;
    const fresh = new Set();
    if (!symbolView && this.news) {
      const ids = this.news.stories.map((s) => s.id);
      if (this.seen) for (const id of ids) if (!this.seen.has(id)) fresh.add(id);
      this.seen = new Set([...(this.seen || []), ...ids]);
    }
    const now = Date.now() / 1000;
    const row = (s) => {
      const also = s.sources.slice(1).map((x) => `${x.source}: ${x.title}`).join('\n');
      const flag = s.breaking ? `<span class="nw-flag breaking">${t('news.breaking')}</span>` : s.hot ? `<span class="nw-flag hot">${t('news.hot')}</span>` : '';
      return `<div class="nw-row${s.hot && !symbolView ? ' hot' : ''}${fresh.has(s.id) ? ' fresh' : ''}">
        <span class="nw-time" data-t="${s.t}" title="${esc(new Date(s.t * 1000).toLocaleString(locale))}">${ago(s.t, now)}</span>
        <div class="nw-main">
          <a class="nw-title" href="${/^https?:\/\//.test(s.link) ? esc(s.link) : '#'}" target="_blank" rel="noopener noreferrer" title="${esc(t('news.openArticle'))}">${symbolView ? '' : flag}${esc(s.title)}</a>
          <div class="nw-meta"><span class="nw-src">${esc(s.source)}</span>${s.sources.length > 1 ? `<span class="nw-more" title="${esc(also)}">${t('news.moreSources', { n: s.sources.length - 1 })}</span>` : ''}${s.tickers.map((tk) => this.chip(tk, data.quotes)).join('')}</div>
        </div>
      </div>`;
    };
    const trending = this.news?.trending?.length && !symbolView
      ? `<div class="nw-trending"><span class="muted">${t('news.trending')}</span>${this.news.trending.map((tk) => this.chip(tk, this.news.quotes)).join('')}</div>` : '';
    const updated = data ? new Date(data.updated).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' }) : '';
    const sourcesNote = data && !symbolView ? `${t('news.sourcesNote', { ok: data.feeds.ok, total: data.feeds.total })} ` : '';
    let list;
    if (!data) list = `<div class="st-empty"><b>${this.error ? t('news.loadError') : t('common.loading')}</b><span>${esc(this.error || '')}</span></div>`;
    else if (!stories.length) list = `<div class="st-empty"><b>${t('news.empty')}</b><span>${symbolView ? esc(t('news.emptySymbol', { symbol: sym })) : t('news.emptyTopic')}</span></div>`;
    else list = stories.slice(0, 150).map(row).join('');
    feed.innerHTML = `
      <div class="nw-tools">
        <div class="nw-seg" role="tablist">
          <button data-view="top" class="${st.view === 'top' ? 'on' : ''}" title="${esc(t('news.topTitle'))}">${t('news.top')}</button>
          <button data-view="latest" class="${st.view === 'latest' ? 'on' : ''}" title="${esc(t('news.latestTitle'))}">${t('news.latest')}</button>
          <button data-view="symbol" class="${symbolView ? 'on' : ''}" title="${esc(t('news.symbolTitle'))}"${sym ? '' : ' disabled'}>${esc(sym || t('common.symbol'))}</button>
        </div>
        ${symbolView ? '' : `<div class="nw-topics">${TOPICS.map(([id, label]) => `<button data-topic="${id}" class="${st.topic === id ? 'on' : ''}">${label}<span>${counts[id]}</span></button>`).join('')}</div>`}
        <span class="spacer"></span>
        ${symbolView ? '' : `<select class="select" data-f="region" aria-label="${esc(t('news.regionLabel'))}" title="${esc(t('news.regionTitle'))}">${REGIONS.map(([id, label]) => `<option value="${id}"${st.region === id ? ' selected' : ''}>${label}</option>`).join('')}</select>`}
        <span class="muted nw-updated" title="${esc(sourcesNote + t('news.refreshNote'))}">${this.error && data ? `${t('news.offline')} · ` : ''}${updated ? t('news.updated', { time: updated }) : ''}</span>
      </div>
      ${trending}
      <div class="nw-list" tabindex="-1">${list}</div>`;
    feed.querySelector('.nw-list').scrollTop = scroll;
  }

  renderCalendar() {
    const box = this.body.querySelector('.nw-cal');
    if (!box) return;
    const st = this.state;
    const c = this.cal;
    const now = Date.now() / 1000;
    const startOfYesterday = new Date(new Date().toDateString()).getTime() / 1000 - 86400;
    let content;
    let next = '';
    if (!c) {
      content = `<div class="st-empty"><b>${this.calError ? t('news.calError') : t('news.calLoading')}</b><span>${esc(this.calError || '')}</span></div>`;
    } else if (st.cal === 'econ') {
      const events = c.econ.filter((e) => e.t >= startOfYesterday && inCountries(e.c, st.countries) && (!st.keyOnly || e.tier >= 2));
      const hasForecast = events.some((e) => e.forecast != null);
      // The next release, and the next high-impact one if that's a different event.
      const ahead = events.filter((e) => e.t > now - 60 && e.actual == null && !e.tbc);
      const soon = ahead[0];
      const big = ahead.find((e) => e.tier === 3);
      const part = (e, label) => `<span class="nw-next-item" data-next="${e.t}" title="${esc(t('news.nextTitle', { country: countryName(e.c), event: e.name, time: new Date(e.t * 1000).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) }))}">${label} <span class="nw-count">${countdown(e.t, now)}</span> <b>${e.c === 'US' ? '' : `${esc(countryLabel(e.c))} `}${esc(e.name)}</b></span>`;
      if (soon) next = `<div class="nw-next">${part(soon, t('news.next'))}${big && big !== soon ? part(big, t('news.highImpact')) : ''}</div>`;
      const rowHtml = (e) => {
        const past = e.t < now;
        const justOut = e.actual != null && now - e.t < 3600;
        const name = e.fed ? `${esc(e.name)}${e.sep ? ` <span class="muted">${t('news.fedProjections')}</span>` : ''} <span class="muted">${t('news.fedPress')}</span>` : `${esc(e.name)} <span class="muted">${esc(e.period)}</span>`;
        return `<tr class="${past ? 'past' : ''}${justOut ? ' just' : ''}${e.tier === 3 ? ' key' : ''}">
          <td class="nw-ctime"${e.tbc ? ` title="${esc(t('news.tbcTitle'))}"` : ''}>${e.tbc ? t('news.tbc') : time(e.t)}</td>
          <td class="nw-cc" title="${esc(countryName(e.c))}">${esc(countryLabel(e.c))}</td>
          <td class="nw-imp t${e.tier}" title="${e.tier >= 1 && e.tier <= 3 ? esc(t(`news.impact${e.tier}`)) : ''}"><i></i><i></i><i></i></td>
          <td class="nw-ev">${name}</td>
          <td class="nw-num nw-act" title="${esc(t('news.actual'))}">${e.fed ? '' : fmtEcon(e.actual, e.name)}</td>
          ${hasForecast ? `<td class="nw-num muted" title="${esc(t('news.forecast'))}">${e.fed ? '' : fmtEcon(e.forecast, e.name)}</td>` : ''}
          <td class="nw-num muted" title="${esc(t('news.previous'))}">${e.fed ? '' : fmtEcon(e.prior, e.name)}</td>
        </tr>`;
      };
      content = this.groupByDay(events, rowHtml, `<tr><th></th><th></th><th></th><th class="l">${t('news.release')}</th><th>${t('news.actual')}</th>${hasForecast ? `<th>${t('news.forecast')}</th>` : ''}<th>${t('news.previous')}</th></tr>`)
        || `<div class="st-empty"><b>${t('news.noReleases')}</b><span>${esc(st.keyOnly ? t('news.noReleasesKeyOnly') : t('news.pickMore'))}</span></div>`;
    } else {
      const reports = c.earnings.filter((e) => e.t >= startOfYesterday && inCountries(e.c, st.countries) && (e.m || 0) >= st.minCap);
      const rowHtml = (e) => {
        const when = e.when === 'bmo' ? t('news.beforeOpen') : e.when === 'amc' ? t('news.afterClose') : '';
        return `<tr class="nw-er" data-full="YAHOO:${esc(e.s)}" title="${esc(t('news.openChart', { symbol: e.s }))}">
          <td class="nw-ctime">${when || '<span class="muted">—</span>'}</td>
          <td class="nw-cc" title="${esc(countryName(e.c))}">${esc(countryLabel(e.c))}</td>
          <td class="nw-ev"><b>${esc(e.s)}</b> <span class="muted">${esc(e.n)}</span></td>
          <td class="nw-num muted" title="${esc(t('news.epsForecast'))}">${e.est ?? '—'}</td>
          <td class="nw-num ${e.surprise != null ? cls(e.surprise) : ''}" title="${esc(t('news.epsReported'))}">${e.act ?? '—'}</td>
          <td class="nw-num ${cls(e.surprise)}" title="${esc(t('news.surprise'))}">${e.surprise != null ? pct(e.surprise) : ''}</td>
          <td class="nw-num muted">${fmtCap(e.m)}</td>
        </tr>`;
      };
      content = this.groupByDay(reports, rowHtml, `<tr><th></th><th></th><th>${t('news.company')}</th><th title="${esc(t('news.epsEstTitle'))}">${t('news.epsEst')}</th><th>EPS</th><th>${t('news.surprise')}</th><th>${t('news.mktCap')}</th></tr>`)
        || `<div class="st-empty"><b>${t('news.noReports')}</b><span>${t('news.noReportsHint')}</span></div>`;
    }
    const oldList = box.querySelector('.nw-cal-list');
    const scroll = oldList?.scrollTop;
    const popScroll = box.querySelector('.nw-pop-list')?.scrollTop || 0;
    const countries = this.calCountries();
    const row = ([cc, n]) => `<label class="nw-pop-row"><input type="checkbox" data-cc="${esc(cc)}"${inCountries(cc, st.countries) ? ' checked' : ''}>
      <span class="nw-cc">${esc(countryLabel(cc))}</span><span class="nw-pop-name">${esc(countryName(cc))}</span><span class="muted">${n || ''}</span></label>`;
    const majors = countries.filter(([cc]) => MAJOR.includes(cc));
    const others = countries.filter(([cc]) => !MAJOR.includes(cc));
    const pop = this.pickOpen ? `<div class="nw-pop" role="dialog" aria-label="${esc(t('news.countriesLabel'))}">
        <div class="nw-pop-sets"><button data-ccset="major">${t('news.setMajor')}</button><button data-ccset="us">${t('news.setUs')}</button><button data-ccset="all">${t('common.all')}</button></div>
        <div class="nw-pop-list">${countries.length ? `<div class="nw-pop-head">${t('news.majorEconomies')}</div>${majors.map(row).join('')}${others.length ? `<div class="nw-pop-head">${t('news.moreCountries')}</div>${others.map(row).join('')}` : ''}` : `<div class="nw-pop-head">${t('common.loading')}</div>`}</div>
      </div>` : '';
    box.innerHTML = `
      <div class="nw-tools">
        <div class="nw-seg" role="tablist">
          <button data-cal="econ" class="${st.cal === 'econ' ? 'on' : ''}">${t('news.econCal')}</button>
          <button data-cal="earnings" class="${st.cal === 'earnings' ? 'on' : ''}">${t('news.topic.earnings')}</button>
        </div>
        <span class="spacer"></span>
        <button class="nw-pick${this.pickOpen ? ' on' : ''}" aria-expanded="${this.pickOpen}" title="${esc(t('news.countriesTitle'))}">${esc(countriesSummary(st.countries))} <span aria-hidden="true">▾</span></button>
        ${st.cal === 'econ'
    ? `<label class="nw-check" title="${esc(t('news.keyOnlyTitle'))}"><input type="checkbox" data-f="keyOnly"${st.keyOnly ? ' checked' : ''}> ${t('news.keyOnly')}</label>`
    : `<select class="select" data-f="minCap" aria-label="${esc(t('news.marketCap'))}">${CAPS.map(([v, l]) => `<option value="${v}"${st.minCap === v ? ' selected' : ''}>${l}</option>`).join('')}</select>`}
      </div>
      ${next}
      <div class="nw-cal-list">${content}</div>
      ${pop}`;
    const popList = box.querySelector('.nw-pop-list');
    if (popList) popList.scrollTop = popScroll;
    // Start at today the first time a tab shows data; after that, keep the reader's place.
    const list = box.querySelector('.nw-cal-list');
    const view = `${st.cal}:${!!c}:${st.countries.join(',')}`;
    if (scroll != null && this.calView === view) list.scrollTop = scroll;
    else list.scrollTop = list.querySelector('.today')?.offsetTop || 0;
    this.calView = view;
  }

  groupByDay(items, rowHtml, head) {
    if (!items.length) return '';
    const days = [];
    for (const e of items) {
      const k = dayKey(e.t);
      if (days.at(-1)?.k !== k) days.push({ k, t: e.t, rows: [] });
      days.at(-1).rows.push(e);
    }
    const today = new Date().toDateString();
    return days.map((d) => `<div class="nw-day${d.k === today ? ' today' : ''}">${esc(dayLabel(d.t))}</div>
      <table class="nw-table"><thead>${head}</thead><tbody>${d.rows.map(rowHtml).join('')}</tbody></table>`).join('');
  }

  renderClock() {
    const now = Date.now() / 1000;
    this.body.querySelectorAll('.nw-time[data-t]').forEach((el) => { el.textContent = ago(Number(el.dataset.t), now); });
    this.body.querySelectorAll('.nw-next-item[data-next]').forEach((el) => { el.querySelector('.nw-count').textContent = countdown(Number(el.dataset.next), now); });
  }
}
