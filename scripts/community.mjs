// Maintains the community script library in community/ (see lib/community.mjs).
// Used by .github/workflows/community.yml; the commands also work locally.
//
//   node scripts/community.mjs check   <event.json>   validate + test-run a submitted script (sandboxed);
//                                                     prints the run's result as one JSON line
//   node scripts/community.mjs verdict <event.json> <result.json>
//                                                     the check's outcome from that (untrusted) result
//   node scripts/community.mjs publish <event.json>   add or update it in community/ (never runs it)
//   node scripts/community.mjs remove  <event.json>   take it down (the issue got the "removed" label)
//   node scripts/community.mjs likes                  refresh like counts from the issues' reactions
//   node scripts/community.mjs seed                   add the app's example scripts as the official
//                                                     examples (no issue number: the app marks them Official)
//
// <event.json> is the GitHub "issues" event payload ($GITHUB_EVENT_PATH in a workflow).

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, appendFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  parseIssueBody, validateSubmission, fileHeader, scriptId, emptyIndex, upsertEntry, removeEntry, slugify, kindOf,
  cleanRunResult, readRunResult, checkVerdict, commentText, contentHash,
} from '../lib/community.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIR = path.join(ROOT, 'community');
const INDEX = path.join(DIR, 'index.json');
const now = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z');

const readIndex = () => (existsSync(INDEX) ? JSON.parse(readFileSync(INDEX, 'utf8')) : emptyIndex());
const writeIndex = (index) => {
  mkdirSync(path.join(DIR, 'scripts'), { recursive: true });
  index.scripts.sort((a, b) => String(a.created).localeCompare(String(b.created)) || a.id.localeCompare(b.id));
  writeFileSync(INDEX, `${JSON.stringify(index, null, 2)}\n`);
};

/** Sets a step output in a workflow (a random delimiter, so the value can't end it early). */
function setOutput(name, value) {
  const f = process.env.GITHUB_OUTPUT;
  if (!f) { console.log(`${name}: ${value}`); return; }
  const delim = `EOF_${randomBytes(12).toString('hex')}`;
  appendFileSync(f, `${name}<<${delim}\n${String(value)}\n${delim}\n`);
}

function readEvent(file) {
  const ev = JSON.parse(readFileSync(file, 'utf8'));
  const issue = ev.issue;
  if (!issue?.number) throw new Error('Not an issue event');
  return { ev, issue, author: String(issue.user?.login || 'unknown'), number: issue.number };
}

const likesOf = (issue) => (Number(issue?.reactions?.['+1']) || 0) + (Number(issue?.reactions?.heart) || 0);

// ---------------------------------------------------------------------------
// Sandboxed test run
// ---------------------------------------------------------------------------

/**
 * Runs code through scripts/community-sandbox.mjs in a locked-down Node process. The child runs
 * the submitted code, so whatever it prints is untrusted: the result goes through cleanRunResult,
 * and anything odd (other output, a non-zero exit, a kill) counts as a failed run.
 */
export function sandboxRun(code, { timeoutMs = 15000 } = {}) {
  const runner = fileURLToPath(new URL('./community-sandbox.mjs', import.meta.url));
  const appJs = path.join(ROOT, 'public', 'js');
  const env = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot || 'C:\\Windows' } : {};
  const reads = [`--allow-fs-read=${runner}`, `--allow-fs-read=${appJs}${path.sep}*`, `--allow-fs-read=${appJs}`];
  for (const flag of ['--permission', '--experimental-permission']) {
    const r = spawnSync(process.execPath, [flag, ...reads, runner], {
      // SIGKILL: the code could catch SIGTERM and keep running.
      input: code, env, timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, windowsHide: true,
    });
    if (r.error?.code === 'ETIMEDOUT') return { ok: false, timeout: true, error: `The script took longer than ${timeoutMs / 1000} seconds to run (an endless loop?).`, line: null };
    if (r.status === 9 || /bad option|unknown or unexpected option/i.test(r.stderr || '')) continue; // flag not supported by this Node
    const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
    if (r.error || r.signal || r.status !== 0) {
      return { ok: false, timeout: false, crashed: true, error: `The test run failed (${r.signal || r.error?.code || `exit code ${r.status}`})${tail ? `: ${tail}` : ''}`, line: null };
    }
    try {
      // The summary is the last line. Scripts' console output goes to stderr, but they could still print.
      return cleanRunResult(JSON.parse(r.stdout.trim().split('\n').at(-1)));
    } catch {
      return { ok: false, timeout: false, crashed: true, error: `The test run failed: ${tail || 'it printed no result'}`, line: null };
    }
  }
  throw new Error('This Node.js has no permission model (need Node 20 or newer)');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const formOf = (eventFile) => validateSubmission(parseIssueBody(readEvent(eventFile).issue.body));
const describe = (v) => (v.ok ? `OK (${v.kind}): ${v.summary}` : `Rejected:\n${v.error}`);

/**
 * Checks the form and test-runs the script. Prints only the run's result (one JSON line) on
 * stdout: in the workflow this runs in a throwaway container with no network, and `verdict`
 * reads that line on the runner.
 */
function check(eventFile) {
  const form = formOf(eventFile);
  const run = form.ok ? sandboxRun(form.value.code) : { ok: false, error: 'Not run: the form has problems.' };
  console.error(describe(checkVerdict(form, cleanRunResult(run))));
  process.stdout.write(`${JSON.stringify(run)}\n`);
}

/**
 * The check's outcome as workflow outputs (ok, kind, summary, error). Checks the form again
 * itself and reads the run's result from `check` as untrusted data, failing closed.
 * RUN_STATUS is how the container ended: "0", another exit code, or "timeout".
 */
function verdict(eventFile, resultFile) {
  const form = formOf(eventFile);
  const status = String(process.env.RUN_STATUS ?? '0');
  let run;
  if (status === 'timeout') run = { ok: false, timeout: true };
  else if (status !== '0') run = { ok: false, crashed: true, error: `The test run stopped unexpectedly (exit code ${commentText(status, 12)}).` };
  else {
    try {
      run = statSync(resultFile).size > 65536 ? cleanRunResult(null) : readRunResult(readFileSync(resultFile, 'utf8').trim());
    } catch {
      run = cleanRunResult(null);
    }
  }
  const v = checkVerdict(form, cleanRunResult(run));
  setOutput('ok', v.ok ? 'true' : 'false');
  setOutput('kind', v.kind);
  setOutput('summary', v.summary);
  setOutput('error', v.error);
  console.log(describe(v));
}

function publish(eventFile, kindArg) {
  const { issue, author, number } = readEvent(eventFile);
  const { ok, errors, value } = validateSubmission(parseIssueBody(issue.body));
  if (!ok) throw new Error(errors.join(' '));
  const kind = kindArg === 'strategy' || kindArg === 'indicator' ? kindArg : value.kind;
  const id = scriptId(number, value.name);
  const file = `scripts/${id}.js`;
  const body = fileHeader({ name: value.name, author, issue: number }) + value.code;
  const sha256 = contentHash(body);
  const stamp = now();
  const before = readIndex();
  const { index, previous } = upsertEntry(before, {
    id, issue: number, name: value.name, description: value.description, kind, tags: value.tags, author,
    created: issue.created_at || stamp, updated: codeUpdated(before.scripts.find((s) => s.issue === number), sha256, stamp),
    likes: likesOf(issue), file, size: Buffer.byteLength(body), sha256,
  });
  mkdirSync(path.join(DIR, 'scripts'), { recursive: true });
  if (previous && previous.file !== file) rmSync(path.join(DIR, previous.file), { force: true });
  writeFileSync(path.join(DIR, file), body);
  writeIndex(index);
  const canon = (o) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));
  const action = !previous ? 'added' : canon(previous) === canon(index.scripts.find((s) => s.issue === number)) ? 'unchanged' : 'updated';
  setOutput('id', id);
  setOutput('name', value.name);
  setOutput('action', action);
  console.log(`${action[0].toUpperCase()}${action.slice(1)}: ${file}`);
}

/**
 * When a script's code last changed: the previous entry's time if the file is the same (so the
 * app doesn't offer an Update that changes nothing), otherwise `stamp`.
 */
export function codeUpdated(previous, sha256, stamp) {
  if (!previous?.updated) return stamp;
  let same = previous.sha256 === sha256;
  if (!previous.sha256) {
    try { same = contentHash(readFileSync(path.join(DIR, previous.file), 'utf8')) === sha256; } catch { /* no file */ }
  }
  return same ? previous.updated : stamp;
}

function remove(eventFile) {
  const { number } = readEvent(eventFile);
  const { index, previous } = removeEntry(readIndex(), number, now());
  if (!previous) { console.log(`Issue #${number} has no published script`); setOutput('removed', 'false'); return; }
  rmSync(path.join(DIR, previous.file), { force: true });
  writeIndex(index);
  setOutput('removed', 'true');
  console.log(`Removed ${previous.file}`);
}

async function likes() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  const index = readIndex();
  let changed = 0;
  for (const s of index.scripts) {
    if (!s.issue) continue;
    const r = await fetch(`https://api.github.com/repos/${repo}/issues/${s.issue}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'wickline-community', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
    if (!r.ok) { console.log(`#${s.issue}: HTTP ${r.status}`); continue; }
    const n = likesOf(await r.json());
    if (n !== s.likes) { s.likes = n; changed++; }
  }
  if (changed) { index.updated = now(); writeIndex(index); }
  console.log(`${changed} like count${changed === 1 ? '' : 's'} changed`);
}

const TAG_WORDS = ['ema', 'sma', 'rsi', 'macd', 'bollinger', 'stochastic', 'supertrend', 'adx', 'volume', 'breakout',
  'trend', 'mean-reversion', 'pullback', 'crossover', 'trailing-stop', 'parabolic-sar', 'donchian', 'squeeze'];

async function seed() {
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const { TEMPLATES } = await import('../public/js/scripts.js');
  let index = readIndex();
  const stamp = now();
  let k = 0;
  for (const t of TEMPLATES) {
    if (/^Blank/i.test(t.name)) continue;
    const name = /(?:indicator|strategy)\(\s*'([^']+)'/.exec(t.code)?.[1] || t.name.replace(/^Strategy:\s*/, '');
    const lines = t.code.split('\n');
    const lead = lines.slice(0, Math.max(1, lines.findIndex((l) => !l.startsWith('//'))));
    const description = lead.map((l) => l.replace(/^\/\/\s?/, '')).join(' ').replace(/\s+/g, ' ').trim().slice(0, 400);
    const hay = `-${`${name} ${t.name} ${description}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-`;
    const kind = kindOf(t.code);
    const tags = TAG_WORDS.filter((w) => hay.includes(`-${w}-`) || hay.includes(`-${w}s-`)).slice(0, 5);
    const id = scriptId(null, name);
    const file = `scripts/${id}.js`;
    const body = fileHeader({ name, author: 'Wickline' }) + t.code;
    // Seeds keep a stable order: one second apart, in the editor's template order.
    const created = new Date(Date.parse(stamp) - (TEMPLATES.length - k++) * 1000).toISOString().replace(/\.\d+Z$/, 'Z');
    const sha256 = contentHash(body);
    const updated = codeUpdated(index.scripts.find((s) => !s.issue && s.id === id), sha256, stamp);
    ({ index } = upsertEntry(index, { id, issue: null, name, description, kind, tags, author: 'Wickline', created, updated, likes: 0, file, size: Buffer.byteLength(body), sha256 }));
    mkdirSync(path.join(DIR, 'scripts'), { recursive: true });
    writeFileSync(path.join(DIR, file), body);
  }
  writeIndex(index);
  console.log(`Seeded ${k} example scripts`);
}

// ---------------------------------------------------------------------------

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, arg, extra] = process.argv.slice(2);
  try {
    if (cmd === 'check') check(arg);
    else if (cmd === 'verdict') verdict(arg, extra);
    else if (cmd === 'publish') publish(arg, extra);
    else if (cmd === 'remove') remove(arg);
    else if (cmd === 'likes') await likes();
    else if (cmd === 'seed') await seed();
    else { console.error('Usage: node scripts/community.mjs check|publish|remove <event.json> | verdict <event.json> <result.json> | likes | seed'); process.exit(2); }
  } catch (e) {
    console.error(e.message || e);
    process.exit(1);
  }
}

export { slugify };
