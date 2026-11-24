// The Markets panel list: handles thousands of instruments by only drawing the rows on screen,
// and only streams live prices for the rows you can see.

import { QuoteStream, displayTicker, sourceName } from './datafeed.js';
import { esc, formatNumber, smartDecimals, fixed } from './util.js';
import { t, locale } from './i18n.js';

const ROW_H = 42;
const OVERSCAN = 8;
const LIVE_MAX = 60;
const ICON_STAR = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor"/></svg>';

const SORTS = {
  rank: (a, b) => (b.rank || 0) - (a.rank || 0) || a.ticker.localeCompare(b.ticker),
  gainers: (a, b) => (b.change ?? -Infinity) - (a.change ?? -Infinity),
  losers: (a, b) => (a.change ?? Infinity) - (b.change ?? Infinity),
  name: (a, b) => a.ticker.localeCompare(b.ticker),
};

export class MarketBrowser {
  /** opts: onSelect(full), onStar(full), isStarred(full) */
  constructor(scroller, countEl, opts) {
    this.scroller = scroller;
    this.countEl = countEl;
    this.opts = opts;
    this.inner = document.createElement('div');
    this.inner.className = 'mk-inner';
    scroller.append(this.inner);
    this.all = [];
    this.view = [];
    this.filter = '';
    this.sector = '';
    this.sort = 'rank';
    this.active = null;
    this.message = '';
    this.quotes = new Map();
    this.stream = new QuoteStream((full, q) => this.onQuote(full, q));
    this.liveTimer = null;
    this.raf = null;

    scroller.addEventListener('scroll', () => { this.renderSoon(); this.scheduleLive(); }, { passive: true });
    new ResizeObserver(() => this.renderSoon()).observe(scroller);
    this.inner.addEventListener('click', (e) => {
      const row = e.target.closest('.wl-row');
      if (!row) return;
      if (e.target.closest('.wl-star')) {
        this.opts.onStar?.(row.dataset.sym);
        row.querySelector('.wl-star').classList.toggle('on', this.opts.isStarred?.(row.dataset.sym));
        return;
      }
      this.opts.onSelect(row.dataset.sym);
    });
  }

  /** rows: [{ full, ticker, name, price?, change?, rank?, sector? }] */
  setRows(rows) {
    this.all = rows;
    this.message = '';
    this.quotes.clear();
    this.scroller.scrollTop = 0;
    this.apply();
  }

  setMessage(msg) {
    this.all = [];
    this.message = msg;
    this.stream.stop();
    this.apply();
  }

  setFilter(text) { this.filter = text; this.scroller.scrollTop = 0; this.apply(); }
  setSector(sector) { this.sector = sector; this.scroller.scrollTop = 0; this.apply(); }
  setSort(sort) { this.sort = SORTS[sort] ? sort : 'rank'; this.scroller.scrollTop = 0; this.apply(); }

  /** Distinct sectors (or quote currencies for crypto), largest groups first. */
  sectors() {
    const counts = new Map();
    for (const r of this.all) if (r.sector) counts.set(r.sector, (counts.get(r.sector) || 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }

  apply() {
    const f = this.filter.trim().toLowerCase();
    let v = this.all;
    if (this.sector) v = v.filter((r) => r.sector === this.sector);
    if (f) v = v.filter((r) => r.ticker.toLowerCase().includes(f) || (r.name || '').toLowerCase().includes(f));
    v = [...v].sort(SORTS[this.sort]);
    if (f) {
      // Put exact and prefix ticker matches on top while filtering.
      const F = f.toUpperCase();
      const score = (r) => (r.ticker.toUpperCase() === F ? 0 : r.ticker.toUpperCase().startsWith(F) ? 1 : 2);
      v.sort((a, b) => score(a) - score(b));
    }
    this.view = v;
    this.countEl.textContent = this.all.length
      ? (v.length === this.all.length ? t('mk.count', { n: v.length.toLocaleString(locale) })
        : t('mk.countOf', { a: v.length.toLocaleString(locale), b: this.all.length.toLocaleString(locale) }))
      : '';
    this.render();
    this.scheduleLive(0);
  }

  renderSoon() {
    if (this.raf) return;
    // Next frame, or a short timer when frames are paused (background tabs).
    const run = () => { if (!this.raf) return; cancelAnimationFrame(this.raf.frame); clearTimeout(this.raf.timer); this.raf = null; this.render(); };
    this.raf = { frame: requestAnimationFrame(run), timer: setTimeout(run, 60) };
  }

  visibleRange(overscan) {
    const top = this.scroller.scrollTop;
    const h = this.scroller.clientHeight || 600;
    const n = this.view.length;
    return [Math.max(0, Math.floor(top / ROW_H) - overscan), Math.min(n - 1, Math.ceil((top + h) / ROW_H) + overscan)];
  }

  render() {
    const n = this.view.length;
    if (!n) {
      this.inner.style.height = 'auto';
      this.inner.innerHTML = `<div class="wl-empty">${esc(this.message || t('mk.noMatches'))}</div>`;
      return;
    }
    this.inner.style.height = `${n * ROW_H}px`;
    const [first, last] = this.visibleRange(OVERSCAN);
    let html = '';
    for (let i = first; i <= last; i++) html += this.rowHtml(this.view[i], i);
    this.inner.innerHTML = html;
  }

  rowHtml(r, i) {
    const q = this.quotes.get(r.full);
    const price = q?.price ?? r.price;
    const change = q?.change ?? r.change;
    const prec = q?.precision ?? r.precision ?? smartDecimals(price);
    const chg = Number.isFinite(change) ? `${change >= 0 ? '+' : ''}${fixed(change, 2)}%` : '—';
    const starred = this.opts.isStarred?.(r.full);
    return `<div class="wl-row${r.full === this.active ? ' active' : ''}" data-sym="${esc(r.full)}" style="top:${i * ROW_H}px" title="${esc(r.name || '')}">
      <span class="wl-sym"><b>${esc(r.ticker || displayTicker(r.full))}</b><small>${esc(r.name || sourceName(r.full))}</small></span>
      <span class="wl-price">${Number.isFinite(price) ? formatNumber(price, prec) : '—'}</span>
      <span class="wl-chg${Number.isFinite(change) ? (change >= 0 ? ' up' : ' down') : ''}">${chg}</span>
      <button class="wl-star${starred ? ' on' : ''}" title="${t('mk.watchToggleTitle')}" aria-label="${t('mk.watchToggleAria')}">${ICON_STAR}</button>
    </div>`;
  }

  scheduleLive(delay = 400) {
    clearTimeout(this.liveTimer);
    this.liveTimer = setTimeout(() => {
      if (!this.view.length || this.scroller.offsetParent === null) { this.stream.stop(); return; }
      const [first, last] = this.visibleRange(0);
      this.stream.setSymbols(this.view.slice(first, last + 1).slice(0, LIVE_MAX).map((r) => r.full));
    }, delay);
  }

  onQuote(full, q) {
    const prev = this.quotes.get(full);
    const next = { ...prev, ...q, precision: q.precision ?? prev?.precision };
    if (next.change == null) next.change = prev?.change ?? this.all.find((r) => r.full === full)?.change ?? null;
    this.quotes.set(full, next);
    const row = this.inner.querySelector(`.wl-row[data-sym="${CSS.escape(full)}"]`);
    if (!row) return;
    const price = row.querySelector('.wl-price');
    const chg = row.querySelector('.wl-chg');
    const r = this.view.find((x) => x.full === full);
    price.textContent = formatNumber(next.price, next.precision ?? r?.precision ?? smartDecimals(next.price));
    if (Number.isFinite(next.change)) {
      chg.textContent = `${next.change >= 0 ? '+' : ''}${fixed(next.change, 2)}%`;
      chg.className = `wl-chg ${next.change >= 0 ? 'up' : 'down'}`;
    }
    const old = prev?.price ?? r?.price;
    if (Number.isFinite(old) && old !== next.price) {
      price.classList.remove('flash-up', 'flash-down');
      void price.offsetWidth;
      price.classList.add(next.price > old ? 'flash-up' : 'flash-down');
    }
  }

  setActive(full) {
    this.active = full;
    this.inner.querySelectorAll('.wl-row').forEach((row) => row.classList.toggle('active', row.dataset.sym === full));
  }

  refreshStars() {
    this.inner.querySelectorAll('.wl-row').forEach((row) => row.querySelector('.wl-star')?.classList.toggle('on', !!this.opts.isStarred?.(row.dataset.sym)));
  }

  stop() { clearTimeout(this.liveTimer); this.stream.stop(); }
  resume() { this.render(); this.scheduleLive(0); }
}
