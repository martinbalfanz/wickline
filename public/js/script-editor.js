// The script editor panel: write, save and add your own JavaScript indicators.

import { scriptStore, TEMPLATES, engine } from './scripts.js';
import { openPublish } from './community.js';
import { $, esc, store } from './util.js';
import { t, locale } from './i18n.js';

const KEYWORDS = new Set(['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'of', 'in', 'new',
  'true', 'false', 'null', 'undefined', 'NaN', 'break', 'continue', 'typeof', 'switch', 'case', 'default', 'do',
  'try', 'catch', 'finally', 'throw', 'Infinity']);
const API = new Set(['strategy', 'indicator', 'input', 'plot', 'hline', 'fill', 'marker', 'log', 'ta', 'open', 'high', 'low', 'close',
  'volume', 'time', 'hl2', 'hlc3', 'ohlc4', 'bar_index', 'n', 'na', 'nz', 'add', 'sub', 'mul', 'div', 'max', 'min',
  'iff', 'rgba', 'timeframe', 'symbol', 'compareClose', 'dashboard', 'Math']);

function highlight(code) {
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [tok, comment, str, num, ident] = m;
    if (comment) out += `<span class="t-com">${esc(tok)}</span>`;
    else if (str) out += `<span class="t-str">${esc(tok)}</span>`;
    else if (num) out += `<span class="t-num">${tok}</span>`;
    else if (KEYWORDS.has(ident)) out += `<span class="t-kw">${tok}</span>`;
    else if (API.has(ident)) out += `<span class="t-api">${tok}</span>`;
    else out += esc(tok);
    last = re.lastIndex;
  }
  return out + esc(code.slice(last)) + '\n';
}

/** A random walk, so scripts can be checked even before a chart has data. */
function sampleBars(n = 300) {
  const bars = [];
  let p = 100, t = Math.floor(Date.now() / 1000) - n * 3600;
  for (let i = 0; i < n; i++, t += 3600) {
    const o = p, c = Math.max(1, o * (1 + (Math.random() - 0.5) * 0.02));
    bars.push({ time: t, open: o, high: Math.max(o, c) * 1.004, low: Math.min(o, c) * 0.996, close: c, volume: 1000 + Math.random() * 1000 });
    p = c;
  }
  return bars;
}

// The API reference panel. Headings and prose are translated (one key per paragraph); the names of
// functions, the code samples and their comments stay as they are.
const codeHtml = (s) => `<code>${s}</code>`;
export const API_DOCS = `
<h4>${t('ed.doc.structure')}</h4>
<pre>indicator('Name', { overlay: true })   // overlay: on the price chart; false: own pane
const len = input('Length', 14, { min: 1, max: 200 })
plot(ta.rsi(close, len), { title: 'RSI', color: '#7E57C2' })</pre>
<h4>${t('ed.doc.data')}</h4>
<p>${t('ed.doc.dataText', { series: codeHtml('open high low close volume time hl2 hlc3 ohlc4 bar_index') })}</p>
<h4>${t('ed.doc.inputs')}</h4>
<p>${t('ed.doc.inputsText')}</p>
<h4>${t('ed.doc.output')}</h4>
<p>${t('ed.doc.plot')}</p>
<p>${t('ed.doc.levels')}</p>
<h4>${t('ed.doc.ta')}</h4>
<p>${t('ed.doc.taSeries', { list: codeHtml(`sma ema wma rma hma dema tema alma kama zlema t3 mcginley vidya trima vwma(src, vol, len) linreg linregSlope
stdev sum cum highest lowest change mom roc shift(src, k) rsi cci ppo kst stc zscore percentrank streak
laguerreRsi connorsRsi rvi er vhf pfe ulcer stderrBands`) })}</p>
<p>${t('ed.doc.taMulti')}</p>
<p>${t('ed.doc.taBars', {
  list: codeHtml(`atr(14) tr() mfi(14) obv() wpr(14) vwap() atrp eom nvi pvi qstick imi
massIndex chaikinVolatility`),
  multi: codeHtml(`alligator chandelier chandeKroll ssl rwi
elderRay smi rvgi squeeze klinger vwmacd starc vwapBands`),
})}</p>
<h4>${t('ed.doc.strategies')}</h4>
<pre>strategy('My strategy', { capital: 10000, size: { percent: 100 }, commission: 0.1 })
strategy.entry('Long', 'long', ta.crossover(fast, slow))
strategy.entry('Short', 'short', ta.crossunder(fast, slow))
strategy.close('Long', ta.crossunder(close, slow))
strategy.exit({ stopLoss: 2, takeProfit: 4 })</pre>
<p>${t('ed.doc.strategyOptions')}</p>
<p>${t('ed.doc.strategyOrders')}</p>
<p>${t('ed.doc.onBar')}</p>
<p class="ed-note">${t('ed.doc.fills')}</p>
<h4>compareClose() / dashboard()</h4>
<pre>const ref = compareClose('YAHOO:QQQ')   // aligned, hidden benchmark closes
plot(close.map((x, i) => x / ref[i]), { legend: false })
dashboard({ status: 'READY', tone: 'positive', metrics: [{ label: '1M', value: '+3%' }] })</pre>
<h4>${t('ed.doc.helpers')}</h4>
<p>${t('ed.doc.helpersText')}</p>
<p class="ed-note">${t('ed.doc.sandbox')}</p>`;

export class ScriptEditor {
  constructor({ getView, toast }) {
    this.getView = getView;
    this.toast = toast;
    this.el = $('#editor');
    this.text = $('#ed-text');
    this.hl = this.el.querySelector('.ed-hl');
    this.gutter = this.el.querySelector('.ed-gutter');
    this.consoleEl = $('#ed-console');
    this.select = $('#ed-scripts');
    this.nameInput = $('#ed-name');
    this.current = null;
    this.dirty = false;
    $('#ed-docs-panel').innerHTML = API_DOCS;

    this.text.addEventListener('input', () => { this.dirty = true; this.refresh(); });
    this.text.addEventListener('scroll', () => this.syncScroll());
    this.text.addEventListener('keydown', (e) => this.onKey(e));
    this.nameInput.addEventListener('input', () => { this.dirty = true; });
    this.select.addEventListener('change', () => {
      if (this.select.value && this.confirmDiscard()) this.loadScript(this.select.value);
      else this.select.value = this.current || '';
    });
    $('#ed-save').addEventListener('click', () => this.save());
    $('#ed-add').addEventListener('click', () => this.addToChart());
    $('#ed-delete').addEventListener('click', () => this.remove());
    $('#ed-publish').addEventListener('click', () => this.publish());
    $('#ed-close').addEventListener('click', () => this.close());
    $('#ed-docs').addEventListener('click', () => {
      const p = $('#ed-docs-panel');
      p.hidden = !p.hidden;
      $('#ed-docs').classList.toggle('on', !p.hidden);
    });
    this.consoleEl.addEventListener('click', (e) => {
      const l = e.target.closest('[data-line]');
      if (l) this.gotoLine(Number(l.dataset.line));
    });

    // New script menu
    const menu = $('#ed-new-menu');
    // Two groups, so a signals indicator is never mistaken for a strategy that can be backtested.
    const isStrategy = (tpl) => /^\s*strategy\(/m.test(tpl.code);
    const item = (tpl) => `<button class="layout-opt" data-tpl="${TEMPLATES.indexOf(tpl)}">${esc(tpl.label)}</button>`;
    const group = (title, note, list) => `<div class="menu-title">${esc(title)}<small>${esc(note)}</small></div>${list.map(item).join('')}`;
    menu.innerHTML = group(t('ed.new.indicators'), t('ed.new.indicatorsNote'), TEMPLATES.filter((tpl) => !isStrategy(tpl)))
      + group(t('ed.new.strategies'), t('ed.new.strategiesNote'), TEMPLATES.filter(isStrategy));
    $('#ed-new').addEventListener('click', () => {
      menu.hidden = !menu.hidden;
      if (menu.hidden) return;
      // Open on the side with more room and scroll within it, never covering the New button.
      const r = $('#ed-new').getBoundingClientRect();
      const above = r.top - 12, below = window.innerHeight - r.bottom - 12;
      menu.style.left = `${r.left}px`;
      menu.style.maxHeight = `${Math.max(120, Math.max(above, below))}px`;
      menu.style.overflowY = 'auto';
      menu.style.top = above >= below ? `${Math.max(8, r.top - menu.offsetHeight - 4)}px` : `${r.bottom + 4}px`;
    });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-tpl]');
      if (!b) return;
      menu.hidden = true;
      if (this.confirmDiscard()) this.loadTemplate(TEMPLATES[Number(b.dataset.tpl)]);
    });
    document.addEventListener('mousedown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('#ed-new')) menu.hidden = true;
    });

    // Resize by dragging the top edge
    const handle = this.el.querySelector('.ed-resize');
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const move = (ev) => this.setHeight(window.innerHeight - ev.clientY - 28);
      const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
    this.setHeight(store.get('editorHeight', 300), false);

    scriptStore.onChange(() => this.renderList());
    this.renderList();
    const last = store.get('editorScript', null);
    if (last && scriptStore.get(last)) this.loadScript(last);
    else this.loadTemplate(TEMPLATES[1]);
  }

  get isOpen() { return !this.el.hidden; }

  open() {
    this.el.hidden = false;
    document.body.classList.add('editor-open');
    this.refresh();
    this.text.focus();
    window.dispatchEvent(new Event('resize'));
  }

  close() {
    this.el.hidden = true;
    document.body.classList.remove('editor-open');
    window.dispatchEvent(new Event('resize'));
  }

  toggle() { if (this.isOpen) this.close(); else this.open(); }

  setHeight(h, save = true) {
    const height = Math.round(Math.max(160, Math.min(window.innerHeight * 0.75, h)));
    this.el.style.height = `${height}px`;
    if (save) store.set('editorHeight', height);
  }

  confirmDiscard() {
    return !this.dirty || confirm(t('ed.confirmDiscard'));
  }

  renderList() {
    const list = scriptStore.list().sort((a, b) => a.name.localeCompare(b.name));
    this.select.innerHTML = `<option value="">${esc(list.length ? t('ed.myScripts') : t('ed.noScripts'))}</option>`
      + list.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    this.select.value = this.current && list.some((s) => s.id === this.current) ? this.current : '';
    $('#ed-delete').disabled = !this.current;
  }

  loadScript(id) {
    const s = scriptStore.get(id);
    if (!s) return;
    this.current = s.id;
    this.text.value = s.code;
    this.nameInput.value = s.name;
    this.dirty = false;
    store.set('editorScript', s.id);
    this.renderList();
    this.refresh();
    this.clearConsole();
  }

  /** Opens a script for editing (e.g. from the Indicators dialog). */
  edit(id) {
    if (id !== this.current && !this.confirmDiscard()) return;
    if (id !== this.current) this.loadScript(id);
    this.open();
  }

  loadTemplate(tpl) {
    this.current = null;
    this.text.value = tpl.code;
    this.nameInput.value = '';
    this.dirty = false;
    this.renderList();
    this.refresh();
    this.clearConsole();
    this.print('info', t('ed.newFrom', { name: tpl.name }));
  }

  refresh() {
    this.hl.innerHTML = highlight(this.text.value);
    const lines = this.text.value.split('\n').length;
    if (this.gutter.childElementCount !== lines) {
      this.gutter.innerHTML = Array.from({ length: lines }, (_, i) => `<div>${i + 1}</div>`).join('');
    }
    this.syncScroll();
  }

  syncScroll() {
    this.hl.style.transform = `translate(${-this.text.scrollLeft}px, ${-this.text.scrollTop}px)`;
    this.gutter.style.transform = `translateY(${-this.text.scrollTop}px)`;
  }

  onKey(e) {
    const t = this.text;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); this.save(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); this.addToChart(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand?.('insertText', false, '  ') || t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end');
      this.refresh();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      // keep the current line's indentation (and indent after an opening bracket)
      const before = t.value.slice(0, t.selectionStart);
      const line = before.slice(before.lastIndexOf('\n') + 1);
      let indent = /^\s*/.exec(line)[0];
      if (/[{([]\s*$/.test(line)) indent += '  ';
      e.preventDefault();
      document.execCommand?.('insertText', false, `\n${indent}`) || t.setRangeText(`\n${indent}`, t.selectionStart, t.selectionEnd, 'end');
      this.refresh();
    }
    e.stopPropagation(); // typing here must not trigger chart shortcuts
  }

  gotoLine(line) {
    const lines = this.text.value.split('\n');
    const start = lines.slice(0, line - 1).reduce((a, l) => a + l.length + 1, 0);
    this.text.focus();
    this.text.setSelectionRange(start, start + (lines[line - 1]?.length || 0));
    const lh = parseFloat(getComputedStyle(this.text).lineHeight) || 19;
    this.text.scrollTop = Math.max(0, (line - 4) * lh);
    this.syncScroll();
  }

  clearConsole() { this.consoleEl.innerHTML = ''; }

  print(kind, msg, line = null) {
    const row = document.createElement('div');
    row.className = `ed-msg ${kind}`;
    const ts = new Date().toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    row.innerHTML = `<span class="ed-ts">${ts}</span>${line ? `<a data-line="${line}">${esc(t('ed.line', { n: line }))}</a> ` : ''}${esc(msg)}`;
    this.consoleEl.append(row);
    while (this.consoleEl.childElementCount > 200) this.consoleEl.firstChild.remove();
    this.consoleEl.scrollTop = this.consoleEl.scrollHeight;
  }

  /** Runs the code once on the active chart's data. Returns the result, or null on error. */
  async compile() {
    const view = this.getView();
    const bars = view?.bars?.length ? view.bars : sampleBars();
    try {
      const res = await engine().run(this.text.value, bars, {}, { tfSec: view?.tf?.sec || 3600, symbol: view?.state?.symbol || '', compareCloses: view?.scriptBenchmarks?.closes() || {} }, this.current);
      for (const l of res.logs || []) this.print('log', l);
      const parts = [t('ed.plots', { n: res.plots.length })];
      if (res.markers.length) parts.push(t('ed.markers', { n: res.markers.length }));
      if (res.inputs.length) parts.push(t('ed.inputs', { n: res.inputs.length }));
      this.print('ok', t('ed.compiled', { name: res.meta.name, parts: parts.join(t('ed.listSep')), ms: res.ms, n: bars.length }));
      return res;
    } catch (err) {
      for (const l of err.logs || []) this.print('log', l);
      this.print('error', err.message, err.line);
      if (err.line) this.gotoLine(err.line);
      return null;
    }
  }

  async save() {
    const res = await this.compile();
    const name = this.nameInput.value.trim() || res?.meta.name || t('ed.defaultName');
    this.nameInput.value = name;
    this.current = scriptStore.save({ id: this.current, name, code: this.text.value });
    this.dirty = false;
    store.set('editorScript', this.current);
    this.renderList();
    this.print(res ? 'ok' : 'warn', t(res ? 'ed.saved' : 'ed.savedWithErrors', { name }));
    return res;
  }

  async addToChart() {
    const res = await this.save();
    if (!res) return;
    const view = this.getView();
    if (!view) return;
    if (view.hasScript(this.current)) {
      this.toast(t('ed.updatedOnChart', { name: this.nameInput.value }));
    } else {
      view.addScript(this.current);
      this.toast(t('ed.addedToChart', { name: this.nameInput.value }));
    }
  }

  /** Checks the script compiles, then opens the Publish dialog (it continues on GitHub). */
  async publish() {
    const res = await this.compile();
    if (!res) { this.print('error', t('ed.fixBeforePublish')); return; }
    const mine = this.current && scriptStore.get(this.current);
    if (mine?.community && mine.community.author !== undefined) {
      this.print('info', t('ed.communityCopy', { name: mine.name, author: mine.community.author }));
    }
    // The comment header a published script starts with isn't part of what the author wrote.
    const code = this.text.value.replace(/^\/\/ .*\n\/\/ Wickline community script by .*\n(\/\/ Discussion, updates and likes: .*\n)?\n/, '');
    openPublish({ name: this.nameInput.value.trim() || res.meta.name, code }, { toast: this.toast });
  }

  remove() {
    if (!this.current) return;
    const s = scriptStore.get(this.current);
    if (!s || !confirm(t('ed.confirmDelete', { name: s.name }))) return;
    scriptStore.remove(this.current);
    this.current = null;
    this.dirty = false;
    this.loadTemplate(TEMPLATES[0]);
    this.print('info', t('ed.deleted', { name: s.name }));
  }
}
