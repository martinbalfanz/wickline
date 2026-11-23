// The community script library: issue-form parsing, checks, the sandboxed test run and its
// (untrusted) result, the index, how the server serves it, and the app's Community tab.
// Run: npm test
import {
  parseIssueBody, validateSubmission, kindOf, slugify, scriptId, fileHeader, emptyIndex, upsertEntry, removeEntry,
  cleanIndex, isCommunityPath, communityFile, clearCommunityCache, cleanRunResult, readRunResult, checkVerdict,
  commentText, contentHash,
} from '../lib/community.mjs';
import { sandboxRun, codeUpdated } from '../scripts/community.mjs';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
};

const form = ({ name = 'EMA Ribbon', description = 'Three EMAs that show the trend at a glance.', tags = 'Trend, EMA,, moving averages', code, license = '- [X] I wrote this script' } = {}) => `### Script name

${name}

### Description

${description}

### Tags

${tags}

### Code

\`\`\`javascript
${code}
\`\`\`

### License

${license}
`;
const CODE = `indicator('EMA Ribbon', { overlay: true });
const note = \`
### License
not a heading
\`;
plot(ta.ema(close, 8));`;

console.log('issue form');
{
  const f = parseIssueBody(form({ code: CODE }).replace(/\n/g, '\r\n'));
  check('reads every field (Windows line endings too)', f.name === 'EMA Ribbon' && f.description.startsWith('Three EMAs') && f.tags.startsWith('Trend'));
  check('code keeps a heading-like line and loses the fence', f.code === `${CODE}\n`, JSON.stringify(f.code));
  check('license box', /\[X\]/.test(f.license));
  check('"_No response_" means empty', parseIssueBody(form({ code: CODE, tags: '_No response_' })).tags === '');
  check('a body without the form gives nothing', Object.keys(parseIssueBody('just some text')).length === 0);
}

console.log('checks');
{
  const ok = validateSubmission(parseIssueBody(form({ code: CODE })));
  check('a good submission passes', ok.ok, ok.errors.join(' '));
  check('tags are cleaned up', ok.value.tags.join() === 'trend,ema,moving-averages', ok.value.tags.join());
  check('kind comes from the code', ok.value.kind === 'indicator' && kindOf("strategy('X');") === 'strategy' && kindOf('my.strategy(1)') === 'indicator');
  const bad = validateSubmission({ name: 'x'.repeat(61), description: 'short', code: 'console.log(1)', license: '[ ]', tags: 'a,b,c,d,e,f' });
  check('every problem is reported', bad.errors.length === 5, bad.errors.join(' | '));
  check('empty code is explained', validateSubmission({ name: 'A', description: 'A long enough description.', code: '', license: '[x]' }).errors.some((e) => /Code box is empty/.test(e)));
}

console.log('library index');
{
  check('ids and slugs', slugify('RSI(2) Pullback — v2!') === 'rsi-2-pullback-v2' && scriptId(12, 'My Script') === '12-my-script' && scriptId(null, 'X') === 'wickline-x');
  check('file header credits the author and links the issue', /by octo,/.test(fileHeader({ name: 'A', author: 'octo', issue: 3 })) && /issues\/3/.test(fileHeader({ name: 'A', author: 'octo', issue: 3 })));
  let { index, previous } = upsertEntry(emptyIndex(), { id: '5-a', issue: 5, name: 'A', created: 't1', updated: 't1', likes: 2, file: 'scripts/5-a.js' });
  check('adds an entry', index.scripts.length === 1 && previous === null);
  ({ index, previous } = upsertEntry(index, { id: '5-b', issue: 5, name: 'B', created: 't9', updated: 't2', likes: 0, file: 'scripts/5-b.js' }));
  check('an edit replaces it, keeping created and likes', index.scripts.length === 1 && index.scripts[0].name === 'B'
    && index.scripts[0].created === 't1' && index.scripts[0].likes === 2 && previous.file === 'scripts/5-a.js');
  ({ index, previous } = removeEntry(index, 5, 't3'));
  check('removes by issue', index.scripts.length === 0 && previous.name === 'B');
  const clean = cleanIndex({ scripts: [
    { id: 'ok-1', file: 'scripts/ok-1.js', name: 'Fine', likes: 3.4, kind: 'strategy', tags: ['a', 5] },
    { id: '../evil', file: 'scripts/x.js' }, { id: 'x', file: '../../etc/passwd' }, { id: 'y', file: 'scripts/y.html' }, null,
  ] });
  check('the served index drops malformed entries and paths', clean.scripts.length === 1 && clean.scripts[0].likes === 3 && clean.scripts[0].tags.join() === 'a');
  check('only library paths are served', isCommunityPath('index.json') && isCommunityPath('scripts/a-1.js')
    && !isCommunityPath('../package.json') && !isCommunityPath('scripts/../x.js') && !isCommunityPath('README.md'));
  const authors = cleanIndex({ scripts: [
    { id: 'a', file: 'scripts/a.js', author: 'Wickline (official)', sha256: 'nothex' },
    { id: 'b', file: 'scripts/b.js', author: 'octo-cat', sha256: contentHash('x') },
    { id: 'c', file: 'scripts/c.js' },
  ] }).scripts;
  check('authors must be GitHub logins; hashes must be SHA-256', authors[0].author === 'unknown' && authors[0].sha256 === ''
    && authors[1].author === 'octo-cat' && authors[1].sha256 === contentHash('x') && authors[2].author === 'unknown');
  check('a republish with the same code keeps its "updated" time (no pointless Update button)',
    codeUpdated({ updated: 't1', sha256: contentHash('a') }, contentHash('a'), 't2') === 't1'
    && codeUpdated({ updated: 't1', sha256: contentHash('a') }, contentHash('b'), 't2') === 't2' && codeUpdated(null, 'x', 't2') === 't2');
  check('line endings don\'t change the hash', contentHash('a\r\nb\n') === contentHash('a\nb\n'));
  const kept = upsertEntry({ ...emptyIndex(), updated: 't5' }, { id: 'w', issue: null, updated: 't3', file: 'scripts/w.js' }).index;
  check('the index\'s own time only moves forward', kept.updated === 't5');
}

console.log('serving the library');
{
  clearCommunityCache();
  const remote = { scripts: [{ id: 'gh-1', file: 'scripts/gh-1.js', name: 'From GitHub' }] };
  const fakeFetch = async (url) => ({ ok: url.endsWith('index.json'), status: 404, text: async () => JSON.stringify(remote) });
  const idx = JSON.parse((await communityFile('index.json', { fetchImpl: fakeFetch })).body);
  check('uses GitHub when it answers', idx.source === 'github' && idx.scripts[0].id === 'gh-1');
  clearCommunityCache();
  const down = async () => { throw new Error('offline'); };
  const local = JSON.parse((await communityFile('index.json', { fetchImpl: down })).body);
  const bundled = JSON.parse(readFileSync(new URL('../community/index.json', import.meta.url), 'utf8'));
  check('falls back to the copy bundled with the app', local.source === 'bundled' && local.scripts.length === bundled.scripts.length && local.scripts.length > 10);
  const first = bundled.scripts[0];
  const code = (await communityFile(first.file, { fetchImpl: fakeFetch })).body;
  check('a script missing on GitHub comes from the bundle', code.includes('Wickline community script'));
  let threw = false;
  try { await communityFile('../package.json', { fetchImpl: down }); } catch (e) { threw = e.status === 404; }
  check('anything else is a 404', threw);

  // Several requests for one file share a download; a missing file is remembered for a while.
  clearCommunityCache();
  const calls = [];
  const slow = async (url) => {
    calls.push(url);
    await new Promise((r) => setTimeout(r, 30));
    return { ok: url.includes('index.json'), status: 404, text: async () => JSON.stringify(remote) };
  };
  const both = await Promise.all([1, 2, 3].map(() => communityFile('index.json', { fetchImpl: slow })));
  check('concurrent requests share one download', calls.filter((u) => u.includes('index.json')).length === 1 && both.every((v) => v === both[0]), String(calls.length));
  let missing = 0;
  for (let k = 0; k < 2; k++) { try { await communityFile('scripts/no-such-script.js', { fetchImpl: slow }); } catch (e) { if (e.status === 404) missing++; } }
  check('a missing file is a 404 and isn\'t fetched again right away', missing === 2 && calls.filter((u) => u.includes('no-such-script')).length === 1, JSON.stringify(calls));

  // A script must match the hash its index entry lists.
  clearCommunityCache();
  const fresh = '// v2\nindicator(\'X\');\n';
  let served = '// v1\nindicator(\'X\');\n';
  const urls = [];
  const hashed = async (url) => {
    urls.push(url);
    if (url.includes('index.json')) {
      return { ok: true, text: async () => JSON.stringify({ scripts: [{ id: 'x-1', file: 'scripts/x-1.js', name: 'X', sha256: contentHash(fresh) }] }) };
    }
    return { ok: true, text: async () => served };
  };
  const stale = await communityFile('scripts/x-1.js', { fetchImpl: hashed });
  check('the download asks past the CDN cache for the listed version', urls.some((u) => u.endsWith(`scripts/x-1.js?v=${contentHash(fresh)}`)), JSON.stringify(urls));
  check('a stale copy is passed on (the app rejects it) but not cached', stale.body === served
    && (await communityFile('scripts/x-1.js', { fetchImpl: hashed }), urls.filter((u) => u.includes('x-1.js')).length === 2));
  served = fresh.replace(/\n/g, '\r\n');
  const good = await communityFile('scripts/x-1.js', { fetchImpl: hashed });
  await communityFile('scripts/x-1.js', { fetchImpl: hashed });
  check('the matching copy is cached (line endings don\'t matter)', good.body === served && urls.filter((u) => u.includes('x-1.js')).length === 3);
  clearCommunityCache();
}

console.log('sandboxed test run');
{
  const good = sandboxRun(CODE);
  check('a working script runs', good.ok && good.plots === 1 && good.kind === 'indicator', JSON.stringify(good));
  const strat = sandboxRun("strategy('S'); strategy.entry('L', 'long', ta.crossover(close, ta.sma(close, 10))); strategy.close('L', ta.crossunder(close, ta.sma(close, 10)));");
  check('a strategy runs and trades', strat.ok && strat.kind === 'strategy' && strat.trades > 0, JSON.stringify(strat));
  const err = sandboxRun("indicator('E');\nplot(close.map((c) => c.x.y));");
  check('errors come back with the line', !err.ok && err.line === 2 && /TypeError/.test(err.error), JSON.stringify(err));
  const loop = sandboxRun("indicator('L'); for (;;) {}", { timeoutMs: 3000 });
  check('an endless loop is stopped', !loop.ok && loop.timeout, JSON.stringify(loop));
  const sneaky = sandboxRun(`indicator('S');
const g = (() => {}).constructor('return this')();
const out = [];
for (const [what, f] of [
  ['read', () => g.process.getBuiltinModule('fs').readFileSync(${JSON.stringify(new URL('../package.json', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'))}, 'utf8')],
  ['write', () => g.process.getBuiltinModule('fs').writeFileSync('sandbox-escape.txt', 'x')],
  ['spawn', () => g.process.getBuiltinModule('child_process').execSync('echo hi')],
]) { try { f(); out.push(what + ':ALLOWED'); } catch (e) { out.push(what + ':' + e.code); } }
out.push('token:' + typeof g.process.env.GITHUB_TOKEN);
throw new Error(out.join(' '));`);
  check('submitted code can\'t read files, write files, run programs or see secrets',
    /read:ERR_ACCESS_DENIED write:ERR_ACCESS_DENIED spawn:ERR_ACCESS_DENIED token:undefined/.test(sneaky.error), sneaky.error);
  const chatty = sandboxRun("indicator('C'); console.log('hello', { a: 1 }); console.info('x'); plot(close);");
  check('console.log() in a script doesn\'t break the check', chatty.ok && chatty.plots === 1, JSON.stringify(chatty));
  const G = "const g = (() => {}).constructor('return this')();";
  const forged = sandboxRun(`indicator('F'); ${G} g.process.stdout.write(JSON.stringify({ ok: true, kind: '<b>x</b>', plots: '@everyone', markers: 0 })); g.process.exit(0);`);
  check('a forged result with odd values counts as a failed run', !forged.ok && forged.crashed, JSON.stringify(forged));
  const forgedExit = sandboxRun(`indicator('F'); ${G} g.process.stdout.write('{"ok":true,"kind":"indicator","plots":1,"markers":0}'); g.process.exit(3);`);
  check('...and so does a result followed by a non-zero exit', !forgedExit.ok && /exit code 3/.test(forgedExit.error), JSON.stringify(forgedExit));
  const stubborn = sandboxRun(`indicator('S'); ${G} g.process.on('SIGTERM', () => {}); for (;;) {}`, { timeoutMs: 2000 });
  check('a script that ignores SIGTERM is still stopped', !stubborn.ok && stubborn.timeout, JSON.stringify(stubborn));
}

console.log('untrusted run results and the verdict');
{
  const good = { ok: true, kind: 'strategy', plots: 2, markers: 3, trades: 4 };
  check('a well-formed result is kept', JSON.stringify(cleanRunResult(good)) === JSON.stringify(good));
  const bad = [null, [], 'x', { ok: 'true' }, { ...good, kind: 'evil' }, { ...good, plots: '2' }, { ...good, plots: 1.5 },
    { ...good, markers: -1 }, { ...good, trades: 'many' }, { ...good, plots: 1e9 }];
  check('anything else counts as a failed run', bad.every((b) => { const r = cleanRunResult(b); return !r.ok && r.crashed; }));
  const err = cleanRunResult({ ok: false, error: 'x'.repeat(2000), line: 'two', extra: '@all' });
  check('an error is trimmed, with a bad line number dropped', !err.ok && err.error.length === 500 && err.line === null && !('extra' in err));
  check('readRunResult fails closed on junk, several values and huge output',
    !readRunResult('not json').ok && !readRunResult('{"ok":true}\n{"ok":true}').ok && !readRunResult(' '.repeat(70000)).ok
    && readRunResult(JSON.stringify(good)).ok);

  const t = commentText('Hi @octocat, see https://evil.example and www.evil.example, #12, GH-3, <img src=x> [x](y) `code`\n# heading');
  check('comment text can\'t mention, link, reference issues or add HTML',
    !/@[a-z]/i.test(t) && !t.includes('://') && !/www\./.test(t) && !/#\d/.test(t) && !/GH-\d/.test(t) && !t.includes('<')
    && !t.includes('`') && !/(^|[^\\])\[/.test(t) && !t.includes('\n'), t);

  const sub = validateSubmission(parseIssueBody(form({ code: CODE })));
  const pass = checkVerdict(sub, cleanRunResult({ ok: true, kind: 'strategy', plots: 1, markers: 2, trades: 5 }));
  check('a pass: kind from the run, a summary made only of numbers', pass.ok && pass.kind === 'strategy' && pass.summary === '1 plot, 2 markers, 5 trades on the test data' && pass.error === '', JSON.stringify(pass));
  const fail = checkVerdict(sub, cleanRunResult({ ok: false, error: 'Error: @admin please merge https://x.example', line: 3 }));
  check('a failure: the error goes into the comment made safe', !fail.ok && /^- The script stopped with an error on line 3: /.test(fail.error)
    && !/@a/.test(fail.error) && !fail.error.includes('://'), fail.error);
  const badForm = checkVerdict(validateSubmission({ name: '', code: '', license: '' }), cleanRunResult(good));
  check('form problems win over whatever the run reported', !badForm.ok && badForm.summary === '' && badForm.error.split('\n').length === 4, badForm.error);

  // The workflow's host-side step: reads the container's output, writes the step outputs.
  const dir = mkdtempSync(path.join(tmpdir(), 'wickline-verdict-'));
  try {
    const event = path.join(dir, 'event.json');
    writeFileSync(event, JSON.stringify({ issue: { number: 9, body: form({ code: CODE }), user: { login: 'octo' } } }));
    const verdict = (result, status = '0') => {
      const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
      const res = path.join(dir, 'result.json');
      writeFileSync(res, result);
      writeFileSync(out, '');
      const r = spawnSync(process.execPath, [new URL('../scripts/community.mjs', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'verdict', event, res], {
        env: { ...process.env, GITHUB_OUTPUT: out, RUN_STATUS: status }, encoding: 'utf8',
      });
      const outputs = {};
      for (const m of readFileSync(out, 'utf8').matchAll(/^(\w+)<<(EOF_\w+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
      return { status: r.status, ...outputs };
    };
    const ok = verdict(JSON.stringify({ ok: true, kind: 'indicator', plots: 1, markers: 0, trades: null }));
    check('verdict: a good result passes', ok.status === 0 && ok.ok === 'true' && ok.kind === 'indicator' && ok.summary === '1 plot', JSON.stringify(ok));
    const fake = verdict(JSON.stringify({ ok: true, kind: 'indicator', plots: 1, markers: 0, summary: '@everyone' }) + '\nextra');
    check('verdict: extra output fails closed', fake.ok === 'false' && !fake.summary, JSON.stringify(fake));
    const killed = verdict(JSON.stringify({ ok: true, kind: 'indicator', plots: 1, markers: 0 }), '137');
    check('verdict: a container that didn\'t exit cleanly fails, whatever it printed', killed.ok === 'false' && /exit code 137/.test(killed.error), JSON.stringify(killed));
    const slow = verdict('', 'timeout');
    check('verdict: a timeout fails', slow.ok === 'false' && /too long/.test(slow.error), JSON.stringify(slow));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('the app\'s Community tab');
{
  // public/js/community.js in Node: a fake browser, the app's server at the page's own origin.
  const saved = new Map();
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)), removeItem: (k) => saved.delete(k) };
  globalThis.location = new URL('http://127.0.0.1:5173/');
  const v1 = '// Ribbon\nindicator(\'Ribbon\');\nplot(close);\n';
  const v2 = '// Ribbon v2\nindicator(\'Ribbon\');\nplot(open);\n';
  let lib = { scripts: [
    { id: 'wickline-rsi-zones', issue: null, file: 'scripts/wickline-rsi-zones.js', name: 'RSI Zones', author: 'Wickline', kind: 'indicator', created: '2026-01-01T00:00:00Z', updated: '2026-01-01T00:00:00Z' },
    { id: '7-ribbon', issue: 7, file: 'scripts/7-ribbon.js', name: 'Ribbon', author: 'Wickline', kind: 'indicator', created: '2026-02-01T00:00:00Z', updated: '2026-02-01T00:00:00Z', sha256: contentHash(v1) },
  ] };
  let body = v1;
  const downloads = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (j) => ({ ok: true, status: 200, json: async () => j, text: async () => JSON.stringify(j) });
    if (u.endsWith('api/health')) return json({ app: 'wickline' });
    if (u.includes('index.json')) return json(lib);
    downloads.push(u);
    await new Promise((r) => setTimeout(r, 20));
    return { ok: true, status: 200, text: async () => body };
  };
  const cm = await import('../public/js/community.js');
  const { scriptStore } = await import('../public/js/scripts.js');
  await cm.loadCommunity();
  const rows = (html) => html.split('<div class="ind-item').slice(1);
  const pick = (html) => ({ official: rows(html).find((r) => r.includes('>RSI Zones ')), community: rows(html).find((r) => r.includes('>Ribbon')) });
  let { official, community } = pick(cm.communityHtml());
  check('official examples are marked by the index (no issue), not by the author name', /Official example/.test(official) && !/cm-badge/.test(official));
  check('a GitHub user called "Wickline" shows as a community script by @Wickline', /cm-badge[^>]*>Community</.test(community) && /by <b>@Wickline<\/b>/.test(community) && !/Official/.test(community), community);
  check('...in toasts and My scripts too', cm.authorLabel(cm.communityEntry('7-ribbon')) === '@Wickline' && cm.authorLabel(cm.communityEntry('wickline-rsi-zones')) === 'Wickline'
    && cm.isOfficial({ id: 'x', issue: null }) && !cm.isOfficial({ issue: 7, author: 'Wickline' }));
  check('the desktop app can install community scripts', cm.canRunCommunity() && /data-comm="7-ribbon"/.test(community) && /data-cm-code=/.test(community));

  const entry = cm.communityEntry('7-ribbon');
  const [a, b] = await Promise.all([cm.installCommunity(entry), cm.installCommunity(entry)]);
  check('a double click installs once', a === b && downloads.length === 1 && scriptStore.list().filter((s) => s.community).length === 1, JSON.stringify(downloads));
  check('the download asks for the listed version', downloads[0].endsWith(`scripts/7-ribbon.js?v=${contentHash(v1)}`), downloads[0]);

  // The author renames it (new id, same issue) and changes the code.
  lib = { scripts: [lib.scripts[0], { ...lib.scripts[1], id: '7-ribbon-pro', file: 'scripts/7-ribbon-pro.js', name: 'Ribbon Pro', updated: '2026-03-01T00:00:00Z', sha256: contentHash(v2) }] };
  await cm.loadCommunity({ refresh: true });
  const renamed = cm.communityEntry('7-ribbon-pro');
  ({ community } = pick(cm.communityHtml()));
  check('a renamed script still finds your copy', cm.installedCopy(renamed)?.id === a && /in My scripts/.test(community) && /data-cm-update="7-ribbon-pro"/.test(community));
  check('installing it again reuses that copy', (await cm.installCommunity(renamed)) === a && downloads.length === 1);
  let failedUpdate = '';
  try { await cm.installCommunity(renamed, { update: true }); } catch (e) { failedUpdate = e.message; }
  check('an update whose download doesn\'t match the listed hash is refused', /isn't available yet/.test(failedUpdate) && scriptStore.get(a).code === v1, failedUpdate);
  body = v2;
  const updatedId = await cm.installCommunity(renamed, { update: true });
  const copy = scriptStore.get(updatedId);
  check('Update replaces the code and moves the copy to the new id', updatedId === a && copy.code === v2 && copy.community.id === '7-ribbon-pro'
    && copy.community.updated === '2026-03-01T00:00:00Z' && scriptStore.list().filter((s) => s.community).length === 1);

  // An older index (the copy bundled with the app, when GitHub can't be reached) mustn't offer a downgrade.
  lib = { scripts: [lib.scripts[0], { ...lib.scripts[1], updated: '2026-02-15T00:00:00Z' }] };
  await cm.loadCommunity({ refresh: true });
  check('Update is offered only for a newer version', !/data-cm-update/.test(cm.communityHtml()));

  // A page that isn't served by Wickline's own server (here: pointed at a server elsewhere).
  localStorage.setItem('wickline.apiBase', JSON.stringify('http://192.0.2.1:5173'));
  const html = cm.communityHtml();
  ({ official, community } = pick(html));
  let refused = '';
  try { await cm.installCommunity(renamed); } catch (e) { refused = e.message; }
  check('elsewhere the tab only lists scripts: no install, code opens on GitHub', !cm.canRunCommunity() && /cm-note/.test(html) && !/data-comm=/.test(html)
    && !/data-cm-update/.test(html) && /href="https:\/\/github\.com\/keptaduona\/wickline\/blob\/main\/community\/scripts\/7-ribbon-pro\.js"/.test(community)
    && /desktop app/.test(refused), refused);
  localStorage.removeItem('wickline.apiBase');
}

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('all passed');
