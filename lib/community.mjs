// The community script library.
//
// Published indicators and strategies live in this repo's community/ folder: community/index.json
// lists them and community/scripts/*.js holds the code. People publish from the app's script editor,
// which opens a prefilled GitHub issue form (.github/ISSUE_TEMPLATE/publish-script.yml). The
// "Community scripts" workflow checks the script and commits it here (scripts/community.mjs).
// These helpers are shared by that workflow, the app's server and the tests.

import { createHash } from 'node:crypto';

export const REPO = 'keptaduona/wickline';
export const LIMITS = { name: 60, description: 400, minDescription: 10, tags: 5, tag: 24, code: 60000 };

// Issue form headings → fields (the form's labels; see publish-script.yml).
const FIELDS = { 'script name': 'name', description: 'description', tags: 'tags', code: 'code', license: 'license' };
const fieldOf = (heading) => FIELDS[String(heading).trim().toLowerCase()];

export function slugify(s) {
  return String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'script';
}

function unfence(s) {
  const t = s.trim();
  const m = /^(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n?\1[ \t]*$/.exec(t);
  return `${(m ? m[2] : t).replace(/\s+$/, '')}\n`;
}

/**
 * Reads a GitHub issue-form body ("### Heading" followed by the answer) into
 * { name, description, tags, code, license }. The code runs to the last "### License" heading,
 * so a line in the code that looks like a heading can't cut it short.
 */
export function parseIssueBody(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n');
  const heads = [...text.matchAll(/^###[ \t]+(.+?)[ \t]*$/gm)];
  const out = {};
  for (let k = 0; k < heads.length; k++) {
    const key = fieldOf(heads[k][1]);
    if (!key || key in out) continue;
    const start = heads[k].index + heads[k][0].length;
    let end;
    if (key === 'code') {
      const lic = heads.filter((h) => h.index > start && fieldOf(h[1]) === 'license').at(-1);
      end = lic ? lic.index : text.length;
      while (k + 1 < heads.length && heads[k + 1].index < end) k++;
    } else {
      end = k + 1 < heads.length ? heads[k + 1].index : text.length;
    }
    let v = text.slice(start, end).trim();
    if (v === '_No response_') v = '';
    out[key] = key === 'code' && v ? unfence(v) : v;
  }
  return out;
}

export const kindOf = (code) => (/(^|[^\w.$])strategy\s*\(/.test(String(code)) ? 'strategy' : 'indicator');

/** Checks a submission. Returns { ok, errors, value } with cleaned-up fields. */
export function validateSubmission(f = {}) {
  const errors = [];
  const name = String(f.name ?? '').replace(/\s+/g, ' ').trim();
  const description = String(f.description ?? '').replace(/\r/g, '').trim();
  const code = String(f.code ?? '').replace(/\r\n?/g, '\n');
  const tags = [...new Set(String(f.tags ?? '').split(/[,;\n]/).map((t) => slugify(t).slice(0, LIMITS.tag)).filter((t) => t && t !== 'script'))];

  if (!name) errors.push('The script needs a name.');
  else if (name.length > LIMITS.name) errors.push(`The name is too long (${name.length} characters, at most ${LIMITS.name}).`);
  if (description.length < LIMITS.minDescription) errors.push('Add a short description of what the script does (at least a sentence).');
  else if (description.length > LIMITS.description) errors.push(`The description is too long (${description.length} characters, at most ${LIMITS.description}).`);
  if (tags.length > LIMITS.tags) errors.push(`Use at most ${LIMITS.tags} tags.`);
  if (!code.trim()) errors.push('The Code box is empty. Paste your script into it (Wickline copied it to your clipboard).');
  else if (code.length > LIMITS.code) errors.push(`The script is too long (${code.length} characters, at most ${LIMITS.code}).`);
  else if (!/(^|[^\w.$])(indicator|strategy)\s*\(/.test(code)) errors.push("The code doesn't call indicator('Name') or strategy('Name'). Is it a Wickline script?");
  if (!/\[x\]/i.test(String(f.license ?? ''))) errors.push('Tick the license box to confirm the script can be shared under the MIT license.');

  return { ok: !errors.length, errors, value: { name, description, tags, code, kind: kindOf(code) } };
}

/** The comment block at the top of every published script file. */
export function fileHeader({ name, author, issue }) {
  const lines = [`// ${name}`, `// Wickline community script by ${author}, shared under the MIT license.`];
  if (issue) lines.push(`// Discussion, updates and likes: https://github.com/${REPO}/issues/${issue}`);
  return `${lines.join('\n')}\n\n`;
}

export const scriptId = (issue, name) => (issue ? `${issue}-${slugify(name)}` : `wickline-${slugify(name)}`);

// ---------------------------------------------------------------------------
// The check's verdict
// ---------------------------------------------------------------------------

export const KINDS = ['indicator', 'strategy'];

/**
 * Makes text safe for a comment the bot posts: one line, and no @mentions (they'd notify people),
 * #123 references, links, images, HTML or code spans.
 */
export function commentText(s, max = 600) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
    .replace(/`/g, "'")
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/[[\]\\]/g, '\\$&')
    .replace(/@/g, '@\u200b')
    .replace(/#(?=\d)/g, '#\u200b')
    .replace(/\b(gh)-(?=\d)/gi, '$1-\u200b')
    .replace(/:\/\//g, ':\u200b//')
    .replace(/\bwww\./gi, 'www\u200b.')
    .slice(0, max);
}

// `crashed`: the run itself went wrong (rather than the script throwing an error).
const FAILED_RUN = { ok: false, timeout: false, crashed: true, error: "The test run didn't finish properly.", line: null };

/**
 * The test run's result. It comes from the process that ran the submitted code, which could have
 * printed anything, so only the expected shape is accepted and anything else counts as a failed run.
 */
export function cleanRunResult(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...FAILED_RUN };
  const count = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= 1e6 ? v : null);
  if (raw.ok === true) {
    const plots = count(raw.plots);
    const markers = count(raw.markers);
    const trades = raw.trades == null ? null : count(raw.trades);
    if (plots === null || markers === null || (raw.trades != null && trades === null) || !KINDS.includes(raw.kind)) return { ...FAILED_RUN };
    return { ok: true, kind: raw.kind, plots, markers, trades };
  }
  if (raw.ok === false) {
    return {
      ok: false,
      timeout: raw.timeout === true,
      crashed: raw.crashed === true,
      error: typeof raw.error === 'string' && raw.error.trim() ? raw.error.slice(0, 500) : 'Unknown error',
      line: Number.isSafeInteger(raw.line) && raw.line > 0 ? raw.line : null,
    };
  }
  return { ...FAILED_RUN };
}

/** A run result printed as JSON (see cleanRunResult). */
export function readRunResult(text) {
  if (typeof text !== 'string' || text.length > 65536) return { ...FAILED_RUN };
  try { return cleanRunResult(JSON.parse(text)); } catch { return { ...FAILED_RUN }; }
}

/**
 * The check's verdict from the form checks (validateSubmission) and the cleaned test run:
 * { ok, kind, summary, error }, the workflow's outputs. The bot posts `summary` and `error` in
 * comments, so the summary is built only from numbers and every error line goes through commentText.
 */
export function checkVerdict(form, run) {
  let problems = form.errors;
  let kind = form.value.kind;
  let summary = '';
  if (form.ok) {
    if (!run.ok && run.timeout) problems = ['The script took too long to run on the test data (an endless loop?).'];
    else if (!run.ok && run.crashed) problems = [run.error];
    else if (!run.ok) problems = [`The script stopped with an error${run.line ? ` on line ${run.line}` : ''}: ${run.error}`];
    else if (!run.plots && !run.markers && run.kind !== 'strategy') problems = ["The script ran but didn't draw anything (no plot() or marker() output)."];
    else {
      kind = run.kind;
      summary = `${run.plots} plot${run.plots === 1 ? '' : 's'}${run.markers ? `, ${run.markers} markers` : ''}${run.trades != null ? `, ${run.trades} trades on the test data` : ''}`;
    }
  }
  return {
    ok: !problems.length,
    kind: KINDS.includes(kind) ? kind : 'indicator',
    summary,
    error: problems.map((p) => `- ${commentText(p)}`).join('\n'),
  };
}

export function emptyIndex() {
  return { version: 1, updated: null, scripts: [] };
}

/** Adds or replaces an entry (matched by issue number, or by id for built-in examples). */
export function upsertEntry(index, entry) {
  const scripts = index.scripts.filter((s) => (entry.issue ? s.issue !== entry.issue : s.id !== entry.id));
  const prev = index.scripts.find((s) => (entry.issue ? s.issue === entry.issue : s.id === entry.id));
  const merged = { ...entry, created: prev?.created || entry.created, likes: prev?.likes ?? entry.likes ?? 0 };
  const updated = String(entry.updated ?? '') > String(index.updated ?? '') ? entry.updated : index.updated;
  return { index: { ...index, updated, scripts: [...scripts, merged] }, previous: prev || null };
}

export function removeEntry(index, issue, updated) {
  const prev = index.scripts.find((s) => s.issue === issue) || null;
  return { index: { ...index, updated, scripts: index.scripts.filter((s) => s.issue !== issue) }, previous: prev };
}

// ---------------------------------------------------------------------------
// Serving the library to the app (server.mjs → /api/community/…)
// ---------------------------------------------------------------------------

export const REMOTE_BASE = `https://raw.githubusercontent.com/${REPO}/main/community/`;
const LOCAL_DIR = new URL('../community/', import.meta.url);
const SCRIPT_PATH = /^scripts\/[a-z0-9-]{1,80}\.js$/;
const cache = new Map(); // rel → { at, value, hash } or { at, missing: true }
const pending = new Map(); // rel + hash → the download in progress, shared by everyone asking meanwhile
const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

export const isCommunityPath = (rel) => rel === 'index.json' || SCRIPT_PATH.test(rel);

/**
 * The newest copy of a library file: from GitHub (cached for a few minutes), or the copy that
 * shipped with the app when GitHub can't be reached or doesn't have it yet. A script must match
 * the hash the index lists for it: a cached or CDN copy that doesn't is fetched again. Requests
 * for a file that's already downloading wait for that download, and a missing file is remembered
 * for a minute. Set WICKLINE_COMMUNITY=local to use only the bundled copy (tests).
 */
export async function communityFile(rel, opts = {}) {
  const { fetchImpl = globalThis.fetch, maxAgeMs = 5 * 60_000, missingMs = 60_000 } = opts;
  if (!isCommunityPath(rel)) throw notFound();
  const hash = rel === 'index.json' ? '' : await indexedHash(rel, opts);
  const hit = cache.get(rel);
  if (hit && Date.now() - hit.at < (hit.missing ? missingMs : maxAgeMs) && (hit.missing || hit.hash === hash)) {
    if (hit.missing) throw notFound();
    return hit.value;
  }
  const key = `${rel}#${hash}`;
  let p = pending.get(key);
  if (!p) {
    p = loadCommunityFile(rel, hash, fetchImpl).finally(() => { if (pending.get(key) === p) pending.delete(key); });
    pending.set(key, p);
  }
  return p;
}

/** The hash the current index lists for a script file ('' if none). */
async function indexedHash(rel, opts) {
  try {
    return (await communityFile('index.json', opts)).hashes?.get(rel) || '';
  } catch {
    return '';
  }
}

async function loadCommunityFile(rel, hash, fetchImpl) {
  const prepare = (text, source) => {
    if (rel !== 'index.json') return { body: text, source };
    const index = cleanIndex(JSON.parse(text));
    const hashes = new Map(index.scripts.filter((s) => s.sha256).map((s) => [s.file, s.sha256]));
    return { body: JSON.stringify({ ...index, source }), source, hashes };
  };
  const stale = (v) => !!hash && contentHash(v.body) !== hash;
  let value = null;
  if (process.env.WICKLINE_COMMUNITY !== 'local') {
    try {
      // ?v= gets past a CDN copy cached before the script changed.
      const r = await fetchImpl(REMOTE_BASE + rel + (hash ? `?v=${hash}` : ''), { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'wickline' } });
      if (r.ok) value = prepare(await r.text(), 'github');
    } catch { /* offline or not published yet: use the bundled copy */ }
  }
  if (!value || stale(value)) {
    const { readFile } = await import('node:fs/promises');
    try {
      const local = prepare(await readFile(new URL(rel, LOCAL_DIR), 'utf8'), 'bundled');
      if (!value || !stale(local)) value = local;
    } catch {
      if (!value) {
        cache.set(rel, { at: Date.now(), missing: true });
        throw notFound();
      }
    }
  }
  // A copy that doesn't match is still served (the app checks the hash and says to try later), but not cached.
  if (!stale(value)) cache.set(rel, { at: Date.now(), value, hash });
  return value;
}

export function clearCommunityCache() { cache.clear(); pending.clear(); }

/** SHA-256 of a library file, ignoring line endings (a Windows checkout may have CRLF). The app checks the same. */
export const contentHash = (text) => createHash('sha256').update(String(text).replace(/\r\n?/g, '\n')).digest('hex');

// Authors are GitHub logins (the official examples' author is "Wickline", which also fits).
const GITHUB_LOGIN = /^[A-Za-z0-9-]{1,39}$/;

/**
 * Keeps only well-formed entries; used by the app's server before passing the index on.
 * Entries without an issue (`issue: null`) are the official examples added by `seed`; everything
 * published through the workflow has its issue number, so the app tells them apart by that.
 */
export function cleanIndex(raw) {
  const list = Array.isArray(raw?.scripts) ? raw.scripts : [];
  const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
  const scripts = list.filter((s) => s && typeof s.id === 'string' && /^[a-z0-9-]{1,80}$/.test(s.id)
    && typeof s.file === 'string' && /^scripts\/[a-z0-9-]{1,80}\.js$/.test(s.file))
    .slice(0, 5000)
    .map((s) => ({
      id: s.id, file: s.file,
      issue: Number.isInteger(s.issue) && s.issue > 0 ? s.issue : null,
      name: str(s.name, LIMITS.name) || s.id,
      description: str(s.description, LIMITS.description),
      kind: s.kind === 'strategy' ? 'strategy' : 'indicator',
      tags: Array.isArray(s.tags) ? s.tags.filter((t) => typeof t === 'string').slice(0, LIMITS.tags).map((t) => t.slice(0, LIMITS.tag)) : [],
      author: typeof s.author === 'string' && GITHUB_LOGIN.test(s.author) ? s.author : 'unknown',
      created: str(s.created, 30), updated: str(s.updated, 30),
      likes: Number.isFinite(s.likes) ? Math.max(0, Math.round(s.likes)) : 0,
      size: Number.isFinite(s.size) ? s.size : 0,
      sha256: typeof s.sha256 === 'string' && /^[a-f0-9]{64}$/.test(s.sha256) ? s.sha256 : '',
    }));
  return { version: 1, updated: str(raw?.updated, 30) || null, scripts };
}
