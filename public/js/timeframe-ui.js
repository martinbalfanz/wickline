// Timeframe controls:
//  - TimeframeBar: the header's favourite timeframes (plus the chart's own when it isn't one of
//    them) and a ▾ menu listing the common ones by group, each with a star that adds it to the
//    header or removes it, and a box for any other (7, 90, 5h).
//  - IntervalBox: "Change interval". Typing a number on the chart opens it; it shows what the
//    text means (45 → 45 minutes) and Enter applies it. Text that isn't a timeframe (7203.T,
//    0700.HK) goes to symbol search instead (Tab or a click, or Enter when it can't be one).

import { TF_GROUPS, parseTf, tfById } from './timeframes.js';
import { esc, store } from './util.js';
import { t } from './i18n.js';

const DEFAULT_FAVORITES = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
const STAR = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.8l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" fill="currentColor"/></svg>';
const CHEVRON = '<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="M1 1l4 4 4-4" stroke="currentColor" fill="none" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const HINT = t('tf.hint');

const bySec = (a, b) => tfById(a).sec - tfById(b).sec;

/** The header's timeframes (saved), shortest first. */
export function favoriteTfs() {
  const saved = store.get('tfFavorites', null);
  const ids = (Array.isArray(saved) ? saved : DEFAULT_FAVORITES).map((x) => parseTf(x)?.id).filter(Boolean);
  return [...new Set(ids)].sort(bySec);
}

function setFavorites(ids) {
  store.set('tfFavorites', [...new Set(ids)].sort(bySec));
}

export class TimeframeBar {
  /**
   * group: the header element for the buttons. getTf() → the active chart's timeframe id;
   * setTf(id) changes it; onResize() after the header's buttons change (to refit the header).
   */
  constructor(group, { getTf, setTf, onResize }) {
    this.group = group;
    this.getTf = getTf;
    this.setTf = setTf;
    this.onResize = onResize;
    this.shown = null; // which buttons the header has, so it's only rebuilt when they change
    this.menu = document.createElement('div');
    this.menu.id = 'tf-menu';
    this.menu.className = 'menu tf-menu';
    this.menu.hidden = true;
    document.body.append(this.menu);

    group.addEventListener('click', (e) => {
      if (e.target.closest('[data-tf-menu]')) { this.toggleMenu(); return; }
      const b = e.target.closest('[data-tf]');
      if (b) this.setTf(b.dataset.tf);
    });
    this.menu.addEventListener('click', (e) => {
      const star = e.target.closest('[data-star]');
      if (star) { this.toggleFavorite(star.dataset.star); return; }
      const row = e.target.closest('[data-pick]');
      if (row) { this.closeMenu(); this.setTf(row.dataset.pick); }
    });
    this.menu.addEventListener('input', (e) => { if (e.target.matches('[data-tf-custom]')) this.renderNote(); });
    this.menu.addEventListener('keydown', (e) => {
      if (!e.target.matches('[data-tf-custom]')) return;
      e.stopPropagation(); // the app's shortcuts don't apply while typing here
      if (e.key === 'Escape') { this.closeMenu(); return; }
      if (e.key !== 'Enter') return;
      const tf = parseTf(e.target.value);
      if (tf) { this.closeMenu(); this.setTf(tf.id); } else this.renderNote(true);
    });
    document.addEventListener('mousedown', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target) && !e.target.closest('[data-tf-menu]')) this.closeMenu();
    });
    window.addEventListener('resize', () => this.closeMenu());
    this.sync();
  }

  /** Shows the active chart's timeframe; rebuilds the buttons if they change. True if they did. */
  sync(active = this.getTf()) {
    const favs = favoriteTfs();
    const extra = active && !favs.includes(active) ? active : null;
    const key = `${favs.join(',')}|${extra || ''}`;
    const changed = key !== this.shown;
    if (changed) {
      this.shown = key;
      const btn = (id, isExtra) => {
        const tf = tfById(id);
        const title = isExtra ? t('tf.extraTitle', { tf: tf.long }) : tf.long;
        return `<button class="tf${isExtra ? ' tf-extra' : ''}" data-tf="${esc(id)}" title="${esc(title)}">${esc(tf.label)}</button>`;
      };
      this.group.innerHTML = favs.map((id) => btn(id, false)).join('') + (extra ? btn(extra, true) : '')
        + `<button class="tf tf-more${this.menu.hidden ? '' : ' open'}" data-tf-menu title="${t('tf.moreTitle')}"
            aria-label="${t('tf.moreAria')}" aria-haspopup="menu">${CHEVRON}</button>`;
    }
    this.group.querySelectorAll('[data-tf]').forEach((b) => b.classList.toggle('on', b.dataset.tf === active));
    if (!this.menu.hidden) this.renderMenu();
    return changed;
  }

  toggleFavorite(id) {
    const favs = favoriteTfs();
    setFavorites(favs.includes(id) ? favs.filter((x) => x !== id) : [...favs, id]);
    if (this.sync()) this.onResize?.();
  }

  get menuOpen() { return !this.menu.hidden; }

  toggleMenu() {
    if (!this.menu.hidden) { this.closeMenu(); return; }
    this.renderMenu();
    this.menu.hidden = false;
    const anchor = this.group.querySelector('[data-tf-menu]');
    anchor?.classList.add('open');
    const r = (anchor || this.group).getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - this.menu.offsetWidth - 8))}px`;
    this.menu.style.top = `${r.bottom + 4}px`;
  }

  /** Closes the menu; true if it was open. */
  closeMenu() {
    if (this.menu.hidden) return false;
    this.menu.hidden = true;
    this.group.querySelector('[data-tf-menu]')?.classList.remove('open');
    return true;
  }

  renderMenu() {
    const active = this.getTf();
    const favs = new Set(favoriteTfs());
    const common = new Set(TF_GROUPS.flatMap((g) => g.ids));
    // Favourites and the active timeframe that aren't in the lists get their own column.
    const custom = [...new Set([...favs, active].filter((id) => id && !common.has(id)))].sort(bySec);
    const groups = custom.length ? [...TF_GROUPS, { title: t('tf.group.custom'), ids: custom }] : TF_GROUPS;
    const row = (id) => {
      const tf = tfById(id), fav = favs.has(id);
      return `<div class="tf-row${id === active ? ' on' : ''}" data-pick="${id}" role="button" tabindex="-1"><span>${esc(tf.long)}</span>
        <button class="tf-star${fav ? ' on' : ''}" data-star="${id}" title="${t(fav ? 'tf.starRemoveTitle' : 'tf.starAddTitle')}" aria-label="${t(fav ? 'tf.starRemoveAria' : 'tf.starAddAria', { tf: esc(tf.long) })}">${STAR}</button></div>`;
    };
    const value = this.menu.querySelector('[data-tf-custom]')?.value || '';
    this.menu.innerHTML = `<div class="tf-cols">${groups.map((g) => `<div class="tf-col"><div class="menu-title">${esc(g.title)}</div>${g.ids.map(row).join('')}</div>`).join('')}</div>
      <div class="menu-sep"></div>
      <div class="tf-custom"><input data-tf-custom value="${esc(value)}" placeholder="${t('tf.customPlaceholder')}" aria-label="${t('tf.customAria')}" autocomplete="off" spellcheck="false">
        <span class="tf-note"></span></div>`;
    this.renderNote();
  }

  renderNote(tried = false) {
    const input = this.menu.querySelector('[data-tf-custom]');
    const note = this.menu.querySelector('.tf-note');
    if (!input || !note) return;
    const text = input.value.trim();
    const tf = parseTf(text);
    note.textContent = tf ? `${tf.long} · Enter` : text && tried ? HINT : t('tf.tip');
    note.classList.toggle('bad', !tf && !!text && tried);
  }
}

export class IntervalBox {
  /** apply(id): change the active chart's timeframe. search(text): open symbol search with text. */
  constructor({ apply, search }) {
    this.apply = apply;
    this.search = search;
    this.tf = null;
    this.el = document.createElement('div');
    this.el.className = 'ivl-box';
    this.el.hidden = true;
    this.el.setAttribute('role', 'dialog');
    this.el.setAttribute('aria-label', t('tf.changeInterval'));
    this.el.innerHTML = `<div class="ivl-title">${t('tf.changeInterval')}</div>
      <input class="ivl-input" autocomplete="off" spellcheck="false" aria-label="${t('tf.interval')}">
      <div class="ivl-meaning" aria-live="polite"></div>
      <button type="button" class="ivl-search"></button>`;
    document.body.append(this.el);
    this.input = this.el.querySelector('.ivl-input');
    this.meaning = this.el.querySelector('.ivl-meaning');
    this.searchBtn = this.el.querySelector('.ivl-search');
    this.input.addEventListener('input', () => this.render());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => this.close());
    // Clicks inside the box keep the input focused (it closes when focus leaves).
    this.el.addEventListener('mousedown', (e) => { if (e.target !== this.input) e.preventDefault(); });
    this.searchBtn.addEventListener('click', () => this.toSearch());
  }

  get isOpen() { return !this.el.hidden; }

  open(text = '') {
    this.el.hidden = false;
    this.input.value = text;
    this.input.focus();
    this.render();
  }

  close() {
    if (this.el.hidden) return;
    this.el.hidden = true;
    if (document.activeElement === this.input) this.input.blur();
  }

  render() {
    const text = this.input.value.trim();
    this.tf = parseTf(text);
    const tf = this.tf;
    this.meaning.innerHTML = tf ? `→ <b>${esc(tf.long)}</b><kbd>Enter</kbd>`
      : text ? esc(t('tf.notTf', { hint: HINT })) : esc(HINT);
    this.meaning.classList.toggle('bad', !tf && !!text);
    this.searchBtn.hidden = !text;
    this.searchBtn.classList.toggle('primary', !tf);
    this.searchBtn.innerHTML = `${t('tf.searchFor', { text: esc(text) })}<kbd>${tf ? 'Tab' : 'Enter'}</kbd>`;
  }

  onKey(e) {
    e.stopPropagation(); // the app's shortcuts don't apply while typing here
    const text = this.input.value.trim();
    if (e.key === 'Escape') { e.preventDefault(); this.close(); return; }
    if (e.key === 'Tab') { e.preventDefault(); if (text) this.toSearch(); return; }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (this.tf) { const id = this.tf.id; this.close(); this.apply(id); } else if (text) this.toSearch();
  }

  toSearch() {
    const text = this.input.value.trim();
    this.close();
    this.search(text);
  }
}
