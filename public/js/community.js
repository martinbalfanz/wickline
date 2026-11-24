// Community scripts: indicators and strategies other Wickline users published (the community/
// folder in the GitHub repo). Lists them in Indicators → Community, installs one into "My scripts"
// with a click, and opens GitHub to publish your own (see community/README.md).
//
// Installed scripts run like your own: in the sandboxed script worker, with every result checked
// (script-sanitize.js) before the page uses it. That worker is cut off from the internet only when
// Wickline's own server serves it (the desktop app, or `npm start`), so a static copy of the site
// lists community scripts but doesn't install them (canRunCommunity).

import { apiUrl, dataMode, isServerMode } from './env.js';
import { scriptStore } from './scripts.js';
import { $, esc, store } from './util.js';
import { t, lang, locale } from './i18n.js';

export const REPO_URL = 'https://github.com/keptaduona/wickline';
const RAW_BASE = 'https://raw.githubusercontent.com/keptaduona/wickline/main/community/';
const MAX_CODE = 100_000;
const MAX_URL = 7500; // GitHub refuses much longer "new issue" links

const state = { status: 'idle', list: [], error: '', source: '', sort: store.get('communitySort', 'popular'), kind: 'all' };
let loading = null;
let loadedAt = 0;

async function base() {
  await dataMode();
  return isServerMode() ? apiUrl('api/community/') : RAW_BASE;
}

/**
 * True where community scripts can be installed: the page and its script worker come from
 * Wickline's own server, which serves the worker with a policy that blocks all network access.
 * A static copy of the site (or one pointed at a server elsewhere) has no such policy.
 */
export function canRunCommunity() {
  if (!isServerMode()) return false;
  try {
    return new URL(apiUrl('api/health'), location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/** The same checks the server makes, for the static site that reads GitHub directly. */
function cleanList(raw) {
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  return (Array.isArray(raw?.scripts) ? raw.scripts : [])
    .filter((s) => s && /^[a-z0-9-]{1,80}$/.test(s.id) && /^scripts\/[a-z0-9-]{1,80}\.js$/.test(s.file))
    .map((s) => ({
      id: s.id, file: s.file,
      issue: Number.isInteger(s.issue) && s.issue > 0 ? s.issue : null,
      name: str(s.name, 60) || s.id,
      description: str(s.description, 400),
      kind: s.kind === 'strategy' ? 'strategy' : 'indicator',
      tags: Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === 'string').slice(0, 5).map((t) => t.slice(0, 24)) : [],
      author: typeof s.author === 'string' && /^[A-Za-z0-9-]{1,39}$/.test(s.author) ? s.author : 'unknown',
      created: str(s.created, 30), updated: str(s.updated, 30),
      likes: Number.isFinite(s.likes) ? Math.max(0, Math.round(s.likes)) : 0,
      sha256: typeof s.sha256 === 'string' && /^[a-f0-9]{64}$/.test(s.sha256) ? s.sha256 : '',
    }));
}

/** Loads the library (again after 10 minutes, or when `refresh`). Calls onDone when it settles. */
export function loadCommunity({ refresh = false, onDone } = {}) {
  if (loading) { loading.then(onDone, onDone); return loading; }
  if (state.status === 'ready' && !refresh && Date.now() - loadedAt < 10 * 60_000) { onDone?.(); return Promise.resolve(); }
  state.status = 'loading';
  loading = (async () => {
    try {
      const r = await fetch(`${await base()}index.json`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      state.list = cleanList(j);
      state.source = typeof j.source === 'string' ? j.source : 'github';
      state.status = 'ready';
      state.error = '';
      loadedAt = Date.now();
    } catch (e) {
      state.status = 'error';
      state.error = e?.message || String(e);
    } finally {
      loading = null;
    }
  })();
  loading.then(onDone, onDone);
  return loading;
}

export const communityCount = () => (state.status === 'ready' ? state.list.length : null);
export const communityEntry = (id) => state.list.find((s) => s.id === id) || null;

/**
 * Official examples ship with Wickline: the library's seed adds them without a GitHub issue.
 * Everything else was published by a GitHub user through an issue, whatever their name is.
 */
export const isOfficial = (entry) => !entry?.issue;
/** Who wrote it: "Wickline" for the official examples, "@login" for community scripts. */
export const authorLabel = (entry) => (isOfficial(entry) ? 'Wickline' : `@${entry?.author || 'unknown'}`);

// Installed copies are matched by issue (a script's id changes when it's renamed), official
// examples by id. Works for index entries and for the `community` record kept with a copy.
const copyKey = (c) => (c?.issue ? `issue:${c.issue}` : `id:${c?.id}`);
function installedCopies() {
  const map = new Map();
  for (const s of scriptStore.list()) if (s.community) map.set(copyKey(s.community), s);
  return map;
}
/** Your copy of a community script (an entry or its id), or null. */
export function installedCopy(entryOrId) {
  const entry = typeof entryOrId === 'string' ? communityEntry(entryOrId) || { id: entryOrId } : entryOrId;
  return installedCopies().get(copyKey(entry)) || null;
}
// Only a newer version counts: an older index (the copy bundled with the app, when GitHub can't be
// reached) must not offer to replace your copy with older code.
const hasUpdate = (entry, copy) => !!copy && !!entry.updated && entry.updated > String(copy.community.updated || '');

export function setCommunityView({ sort, kind } = {}) {
  if (sort) { state.sort = sort === 'new' ? 'new' : 'popular'; store.set('communitySort', state.sort); }
  if (kind) state.kind = ['indicator', 'strategy'].includes(kind) ? kind : 'all';
}

let dateFormat = null;
function shortDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  dateFormat ||= new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' });
  return dateFormat.format(d);
}

/** The script's file on GitHub (the website shows the code there instead of in the editor). */
const codeUrl = (entry) => `${REPO_URL}/blob/main/community/${entry.file}`;

/** HTML for the Community list in the Indicators dialog. `filter` is the search box text. */
export function communityHtml(filter = '') {
  const seg = (attr, value, label, on) => `<button type="button" data-${attr}="${value}" class="${on ? 'on' : ''}">${label}</button>`;
  const bar = `<div class="cm-bar">
      <span class="cm-seg">${seg('cm-sort', 'popular', t('comm.mostLiked'), state.sort === 'popular')}${seg('cm-sort', 'new', t('comm.newest'), state.sort === 'new')}</span>
      <span class="cm-seg">${seg('cm-kind', 'all', t('common.all'), state.kind === 'all')}${seg('cm-kind', 'indicator', t('comm.indicators'), state.kind === 'indicator')}${seg('cm-kind', 'strategy', t('comm.strategies'), state.kind === 'strategy')}</span>
      <span class="spacer"></span>
      <button type="button" class="cm-link" data-cm-publish="1">${t('comm.publishYours')}</button>
    </div>`;

  if (state.status === 'loading' || state.status === 'idle') return `${bar}<div class="cm-state">${t('comm.loading')}</div>`;
  if (state.status === 'error') {
    return `${bar}<div class="cm-state">${t('comm.loadError', { error: esc(state.error) })}
      <button type="button" data-cm-retry="1">${t('comm.tryAgain')}</button></div>`;
  }

  const runs = canRunCommunity();
  const note = runs ? '' : `<div class="cm-note">${t('comm.webNote')}</div>`;
  const f = filter.trim().toLowerCase();
  const list = state.list
    .filter((s) => state.kind === 'all' || s.kind === state.kind)
    .filter((s) => !f || `${s.name} ${s.description} ${s.author} ${s.tags.join(' ')}`.toLowerCase().includes(f))
    .sort((a, b) => (state.sort === 'new'
      ? String(b.created).localeCompare(String(a.created))
      : b.likes - a.likes || String(b.created).localeCompare(String(a.created))));
  if (!list.length) return `${bar}${note}<div class="cm-state">${state.list.length ? t('comm.noMatch') : t('comm.empty')}</div>`;

  const copies = installedCopies();
  return bar + note + list.map((s) => {
    const copy = copies.get(copyKey(s)) || null;
    const update = runs && hasUpdate(s, copy);
    const date = s.created ? shortDate(s.created) : '';
    const who = isOfficial(s)
      ? `<span class="cm-official" title="${esc(t('comm.officialTitle'))}">${t('comm.official')}</span>`
      : `<span class="cm-badge" title="${esc(t('comm.badgeTitle'))}">${t('comm.badge')}</span><span>${t('comm.by', { author: esc(authorLabel(s)) })}</span>`;
    const row = runs ? `class="ind-item cm-item" data-comm="${esc(s.id)}" role="button" tabindex="0" title="${esc(t('comm.addTitle'))}"` : 'class="ind-item cm-item cm-browse"';
    const code = runs
      ? `<button type="button" data-cm-code="${esc(s.id)}" title="${esc(t('comm.codeTitle'))}">${t('comm.code')}</button>`
      : `<a href="${esc(codeUrl(s))}" target="_blank" rel="noopener" title="${esc(t('comm.codeGithubTitle'))}">${t('comm.code')}</a>`;
    return `<div ${row}>
      <span class="ind-name">${esc(s.name)} <span class="cm-kind ${s.kind}">${s.kind === 'strategy' ? t('comm.kindStrategy') : t('comm.kindIndicator')}</span>${copy ? `<span class="cm-installed">${t('comm.installed')}</span>` : ''}</span>
      <span class="ind-desc">${esc(s.description)}</span>
      <span class="cm-meta">${who}<span>♥ ${s.likes}</span>${date ? `<span>${esc(date)}</span>` : ''}${s.tags.map((tag) => `<span class="cm-tag">${esc(tag)}</span>`).join('')}</span>
      <span class="cm-actions">
        ${update ? `<button type="button" class="cm-update" data-cm-update="${esc(s.id)}" title="${esc(t('comm.updateTitle'))}">${t('comm.update')}</button>` : ''}
        ${code}
        ${s.issue ? `<button type="button" data-cm-like="${esc(s.id)}" title="${esc(t('comm.likeTitle'))}">${t('comm.like')}</button>` : ''}
      </span>
    </div>`;
  }).join('');
}

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) return null; // only on pages that aren't a secure context
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.replace(/\r\n?/g, '\n')));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The script's code (published files start with a comment saying who wrote it). It must match the
 * hash in the index, so a copy cached before the script changed isn't taken for the new version.
 */
export async function fetchCommunityCode(entry) {
  const v = entry.sha256 || entry.updated;
  const r = await fetch(`${await base()}${entry.file}${v ? `?v=${encodeURIComponent(v)}` : ''}`, { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(t('comm.downloadFailed', { name: entry.name, status: r.status }));
  const code = await r.text();
  if (code.length > MAX_CODE) throw new Error(t('comm.tooLarge', { name: entry.name }));
  if (entry.sha256) {
    const hash = await sha256Hex(code);
    if (hash && hash !== entry.sha256) throw new Error(t('comm.notYet', { name: entry.name }));
  }
  return code;
}

const installing = new Map(); // copyKey → the install in progress (a double click installs once)

/**
 * Makes sure a community script is in "My scripts" and returns its id. An existing copy is reused
 * (you may have edited it); `update` replaces it with the newest published version.
 */
export function installCommunity(entry, { update = false } = {}) {
  if (!canRunCommunity()) {
    return Promise.reject(new Error(t('comm.desktopOnly')));
  }
  const key = copyKey(entry);
  if (!installing.has(key)) {
    const job = (async () => {
      const copy = installedCopy(entry);
      if (copy && !update) return copy.id;
      const code = await fetchCommunityCode(entry);
      return scriptStore.save({
        id: copy?.id,
        name: copy?.name || entry.name,
        code,
        community: { id: entry.id, updated: entry.updated, author: entry.author, issue: entry.issue },
      });
    })().finally(() => installing.delete(key));
    installing.set(key, job);
  }
  return installing.get(key);
}

export const likeUrl = (entry) => (entry.issue ? `${REPO_URL}/issues/${entry.issue}` : `${REPO_URL}/tree/main/community`);

// ---------------------------------------------------------------------------
// Publishing
// ---------------------------------------------------------------------------

/** The prefilled "Publish a script" issue form on GitHub (without the code if the link would be too long). */
export function publishUrl({ name, description, tags, code }) {
  const q = (withCode) => {
    const p = new URLSearchParams({ template: 'publish-script.yml', title: `[Script] ${name}`, name, description, tags });
    if (withCode) p.set('code', code);
    return `${REPO_URL}/issues/new?${p}`;
  };
  const full = q(true);
  return full.length <= MAX_URL ? { url: full, includesCode: true } : { url: q(false), includesCode: false };
}

let pub = null;

/** Opens the Publish dialog for a script. `info` = { name, code, description? }. */
export function openPublish(info, { toast } = {}) {
  const modal = $('#publish-modal');
  const form = $('#publish-form');
  const err = $('#pub-error');
  if (!pub) {
    pub = { info: null, toast: null };
    const close = () => { modal.hidden = true; };
    modal.querySelectorAll('.close').forEach((b) => b.addEventListener('click', close));
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
    modal.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#pub-name').value.replace(/\s+/g, ' ').trim();
      const description = $('#pub-desc').value.trim();
      const tags = $('#pub-tags').value.trim();
      const problems = [];
      if (!name) problems.push(t('comm.pub.needName'));
      if (description.length < 10) problems.push(t('comm.pub.needDesc'));
      if (!$('#pub-license').checked) problems.push(t('comm.pub.needLicense'));
      if (pub.info.code.length > 60000) problems.push(t('comm.pub.tooLong', { max: (60000).toLocaleString(locale) }));
      err.hidden = !problems.length;
      err.textContent = problems.join(lang === 'en' ? ' ' : ''); // Chinese and Japanese sentences need no space between them
      if (problems.length) return;
      const { url, includesCode } = publishUrl({ name, description, tags, code: pub.info.code });
      let copied = false;
      try { await navigator.clipboard.writeText(pub.info.code); copied = true; } catch { /* not allowed here */ }
      window.open(url, '_blank', 'noopener');
      close();
      pub.toast?.(t(includesCode ? 'comm.pub.opened' : copied ? 'comm.pub.openedPasteCopied' : 'comm.pub.openedPaste'));
    });
  }
  pub.info = info;
  pub.toast = toast;
  $('#pub-name').value = info.name || '';
  $('#pub-desc').value = info.description || '';
  $('#pub-tags').value = '';
  $('#pub-license').checked = false;
  err.hidden = true;
  modal.hidden = false;
  ($('#pub-name').value ? $('#pub-desc') : $('#pub-name')).focus();
}
