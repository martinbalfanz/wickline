// A live-updating list of symbols with last price and change (used by the watchlist and Markets).

import { QuoteStream, displayTicker, sourceName } from './datafeed.js';
import { esc, formatNumber, smartDecimals, fixed } from './util.js';
import { t } from './i18n.js';

const ICON_STAR = '<svg viewBox="0 0 24 24" width="15" height="15"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor"/></svg>';

export class QuoteList {
  /**
   * opts: onSelect(full), onRemove(full) → shows ×, onStar(full) + isStarred(full) → shows ☆,
   *       empty: text when the list is empty
   */
  constructor(el, opts) {
    this.el = el;
    this.opts = opts;
    this.items = [];
    this.active = null;
    this.quotes = new Map();
    this.stream = new QuoteStream((full, q) => this.onQuote(full, q), { useCredits: !!opts.useCredits });
    el.addEventListener('click', (e) => {
      const row = e.target.closest('.wl-row');
      if (!row) return;
      if (e.target.closest('.wl-del')) { this.opts.onRemove?.(row.dataset.sym); return; }
      if (e.target.closest('.wl-star')) { this.opts.onStar?.(row.dataset.sym); this.refreshStars(); return; }
      this.opts.onSelect(row.dataset.sym);
    });
  }

  /** items: [{ full, name?, price?, change?, precision? }] */
  setItems(items) {
    this.items = items;
    for (const it of items) {
      if (Number.isFinite(it.price) && !this.quotes.has(it.full)) {
        this.quotes.set(it.full, { price: it.price, change: it.change, precision: it.precision });
      }
    }
    this.render();
    this.stream.setSymbols(items.map((i) => i.full));
  }

  stop() { this.stream.stop(); }

  setActive(full) {
    this.active = full;
    this.el.querySelectorAll('.wl-row').forEach((r) => r.classList.toggle('active', r.dataset.sym === full));
  }

  render() {
    const { onRemove, onStar } = this.opts;
    this.el.innerHTML = this.items.map((it) => `
      <div class="wl-row${it.full === this.active ? ' active' : ''}" data-sym="${esc(it.full)}" title="${esc(it.name || '')}">
        <span class="wl-sym"><b>${esc(displayTicker(it.full))}</b><small>${esc(it.name || sourceName(it.full))}</small></span>
        <span class="wl-price">—</span>
        <span class="wl-chg">—</span>
        ${onRemove ? `<button class="wl-del" title="${t('common.remove')}" aria-label="${t('common.remove')}">×</button>` : ''}
        ${onStar ? `<button class="wl-star" title="${t('mk.watchToggleTitle')}" aria-label="${t('mk.watchToggleAria')}">${ICON_STAR}</button>` : ''}
      </div>`).join('') || `<div class="wl-empty">${esc(this.opts.empty || t('mk.nothingHere'))}</div>`;
    for (const [full, q] of this.quotes) this.paint(full, q, false);
    this.refreshStars();
  }

  refreshStars() {
    if (!this.opts.isStarred) return;
    this.el.querySelectorAll('.wl-row').forEach((r) => r.querySelector('.wl-star')?.classList.toggle('on', this.opts.isStarred(r.dataset.sym)));
  }

  onQuote(full, q) {
    const prev = this.quotes.get(full);
    const next = { ...prev, ...q, precision: q.precision ?? prev?.precision };
    this.quotes.set(full, next);
    this.paint(full, next, prev && prev.price !== q.price ? (q.price > prev.price ? 'up' : 'down') : false);
  }

  paint(full, q, flash) {
    const row = this.el.querySelector(`.wl-row[data-sym="${CSS.escape(full)}"]`);
    if (!row) return;
    const price = row.querySelector('.wl-price');
    const chg = row.querySelector('.wl-chg');
    price.textContent = formatNumber(q.price, q.precision ?? smartDecimals(q.price));
    if (q.change == null || !Number.isFinite(q.change)) {
      chg.textContent = '—';
      chg.className = 'wl-chg';
    } else {
      chg.textContent = `${q.change >= 0 ? '+' : ''}${fixed(q.change, 2)}%`;
      chg.className = `wl-chg ${q.change >= 0 ? 'up' : 'down'}`;
    }
    if (flash) {
      price.classList.remove('flash-up', 'flash-down');
      void price.offsetWidth; // restart the animation
      price.classList.add(flash === 'up' ? 'flash-up' : 'flash-down');
    }
  }

  lastPrice(full) { return this.quotes.get(full)?.price; }
}
