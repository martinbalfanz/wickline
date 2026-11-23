// Runs strategy scripts through the real script worker (in Node). Run: npm test
let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
};

// Minimal stand-in for the worker global, then load the worker module.
let reply = null;
globalThis.self = { postMessage: (m) => { reply = m; } };
await import('../public/js/script-worker.js');
const run = (code, n = 400, ctx = {}) => {
  const data = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p, c = o * (1 + Math.sin(i / 9) * 0.01 + (i % 7 === 0 ? -0.004 : 0.002));
    data.time.push(1700000000 + i * 3600); data.open.push(o); data.close.push(c);
    data.high.push(Math.max(o, c) * 1.003); data.low.push(Math.min(o, c) * 0.997);
    data.volume.push(i % 23 === 0 ? 6000 : 1000); // occasional volume spikes
    p = c;
  }
  const packed = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Float64Array.from(v)]));
  self.onmessage({ data: { id: 1, code, data: packed, inputs: {}, ctx: { tfSec: 3600, ...ctx } } });
  return reply;
};

console.log('strategy script');
{
  const r = run(`
    strategy('EMA Cross', { capital: 5000, commission: 0.1 });
    const fast = ta.ema(close, 9), slow = ta.ema(close, 21);
    plot(fast); plot(slow);
    strategy.entry('Long', 'long', ta.crossover(fast, slow));
    strategy.entry('Short', 'short', ta.crossunder(fast, slow));
    strategy.exit({ stopLoss: 3, takeProfit: 6 });
  `);
  check('runs without error', r.ok, r.error);
  const s = r.result?.strategy;
  check('marked as a strategy', r.result?.meta.strategy === true);
  check('has trades', s?.trades.length > 3, `${s?.trades.length}`);
  check('uses the script capital', s?.props.initialCapital === 5000);
  check('uses the script commission', s?.props.commission === 0.1);
  check('equity curve for every bar', s?.equity.length === 400);
  check('net profit equals the sum of trades', Math.abs(s.summary.netProfit - s.trades.reduce((a, t) => a + t.pnl, 0)) < 1e-6);
  check('trades alternate long/short or exit', s.trades.every((t) => ['long', 'short'].includes(t.side)));
}

console.log('property overrides from the tester');
{
  const r = run(`strategy('X'); strategy.entry('L', 'long', ta.crossover(close, ta.sma(close, 20))); strategy.close(null, ta.crossunder(close, ta.sma(close, 20)));`,
    400, { strategy: { initialCapital: 1000, fillOn: 'close' } });
  check('override applied', r.ok && r.result.strategy.props.initialCapital === 1000 && r.result.strategy.props.fillOn === 'close', r.error);
}

console.log('onBar');
{
  const r = run(`
    strategy('Time stop');
    const up = ta.crossover(close, ta.sma(close, 10));
    strategy.onBar((i, s) => {
      if (!s.position.side && up[i]) s.long('L');
      if (s.position.side && s.position.barsInTrade >= 5) s.close();
    });
  `);
  check('runs', r.ok, r.error);
  check('every trade lasts 5–6 bars', r.result.strategy.trades.length > 0 && r.result.strategy.trades.every((t) => t.bars >= 5 && t.bars <= 6),
    JSON.stringify(r.result?.strategy.trades.map((t) => t.bars)));
}

console.log('errors');
{
  const a = run(`strategy.entry('L', 'long', true);`);
  check('strategy.entry before strategy() explains', !a.ok && /call strategy\(/.test(a.error), a.error);
  const b = run(`strategy('X'); strategy.entry('L', 'up', true);`);
  check('bad direction explains', !b.ok && /'long' or 'short'/.test(b.error), b.error);
  const c = run(`strategy('X');\nstrategy.onBar((i, s) => {\n  if (i === 50) s.nope();\n});`);
  check('error inside onBar reports its line', !c.ok && c.line === 3, `${c.error} line=${c.line}`);
}

console.log('every starter template runs');
{
  // scripts.js expects a browser; give it the two things it touches.
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const { TEMPLATES } = await import('../public/js/scripts.js');
  for (const t of TEMPLATES) {
    const r = run(t.code, 600);
    const s = r.result?.strategy;
    const output = r.ok && (r.result.plots.length > 0 || r.result.markers.length > 0);
    check(`${t.name}`, output && (!s || s.trades.length + s.openTrades.length > 0),
      r.ok ? `plots=${r.result.plots.length} markers=${r.result.markers.length} trades=${s?.trades.length}` : r.error);
  }
}

console.log('every community script runs');
{
  const { readdirSync, readFileSync } = await import('node:fs');
  const dir = new URL('../community/scripts/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
    const r = run(readFileSync(new URL(f, dir), 'utf8'), 600);
    check(f, r.ok && (r.result.plots.length > 0 || r.result.markers.length > 0), r.error);
  }
}

console.log('limits are errors in the worker, not silent cuts later');
{
  const a = run(`indicator('Many'); for (let k = 0; k < 65; k++) plot(close);`);
  check('more than 64 plots', !a.ok && /at most 64 plots/.test(a.error), a.error);
  const b = run(`indicator('Long text'); input('Note', 'x'.repeat(1001));`);
  check('a text setting longer than 1000 characters', !b.ok && /at most 1000 characters/.test(b.error), b.error);
  const c = run(`indicator('Levels'); for (let k = 0; k < 51; k++) hline(k);`);
  check('more than 50 levels', !c.ok && /at most 50 levels/.test(c.error), c.error);
  const d = run(`indicator('Fill'); const a = plot(close); fill(a, 'p5');`);
  check('a fill to a plot that doesn\'t exist', !d.ok && /fill\(\)/.test(d.error), d.error);
  const e = run(`indicator('Colors'); plot(close, { color: ['red', 'blue'] });`, 50);
  check('a short per-bar colour list is padded to one per bar', e.ok && e.result.plots[0].colors.length === 50 && e.result.plots[0].colors[2] === null, e.error);
  const f = run(`indicator('Frozen'); let msg = ''; try { ta.ema = () => 0; } catch (err) { msg = err.name; } log(msg, Object.isFrozen(ta), Object.isFrozen(ta.sma)); plot(close);`);
  check('the ta library is frozen', f.ok && f.result.logs[0] === 'TypeError true true', f.result?.logs[0] ?? f.error);
}

console.log('each script runs in its own worker');
{
  // A Web Worker for Node: a worker thread with a browser-like `self` (postMessage, addEventListener…),
  // so the app's real engine (scripts.js) and worker (script-worker.js) run as they do in the app.
  const { Worker: ThreadWorker } = await import('node:worker_threads');
  const BOOT = `
    const { parentPort, workerData } = require('node:worker_threads');
    const target = new EventTarget();
    const dispatch = target.dispatchEvent.bind(target);
    Object.assign(globalThis, {
      self: globalThis,
      postMessage: (m, transfer) => parentPort.postMessage(m, transfer),
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      dispatchEvent: dispatch,
      close: () => process.exit(0),
    });
    let ready = false;
    const queued = [];
    const deliver = (data) => dispatch(new MessageEvent('message', { data }));
    parentPort.on('message', (data) => (ready ? deliver(data) : queued.push(data)));
    import(workerData.url).then(() => { ready = true; queued.splice(0).forEach(deliver); });`;
  let spawned = 0;
  globalThis.Worker = class {
    constructor(url) {
      spawned++;
      this.thread = new ThreadWorker(BOOT, { eval: true, workerData: { url: String(url) } });
      this.thread.on('message', (data) => this.onmessage?.({ data }));
      this.thread.on('error', (e) => this.onerror?.({ message: e.message, preventDefault() {} }));
    }
    postMessage(m, transfer) { this.thread.postMessage(m, transfer); }
    terminate() { this.thread.terminate(); }
  };
  const { engine } = await import('../public/js/scripts.js');
  const bars = Array.from({ length: 300 }, (_, i) => ({ time: 1700000000 + i * 3600, open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1000 }));
  const settle = (p) => p.then((r) => ({ ok: true, r }), (e) => ({ ok: false, e }));

  // A hostile script: looks for a way out, then breaks built-ins for everyone in its worker.
  const evil = await settle(engine().run(`indicator('Evil');
    const g = (() => {}).constructor('return this')();
    log(['postMessage', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'onmessage', 'close', 'fetch', 'importScripts']
      .map((k) => typeof g[k]).join(' '));
    try { g.onmessage = () => {}; } catch { /* read-only */ }
    plot(close);
    Array.prototype.push = function () { return 0; };
    Array.prototype.map = function () { return []; };
    Math.max = () => 42;`, bars, {}, { tfSec: 3600 }, 'evil'));
  check('a script can\'t reach messaging, events or the network', evil.ok
    && evil.r.logs[0] === 'undefined undefined undefined undefined undefined undefined undefined undefined', evil.ok ? evil.r.logs[0] : evil.e.message);

  const good = await settle(engine().run(`indicator('Good');
    const a = []; a.push(1);
    plot(ta.ema(close, 5)); plot(max(close, 0)); plot(close.map(() => a.length));`, bars, {}, { tfSec: 3600 }, 'good'));
  const v = good.ok && good.r.plots.map((p) => p.values[299]);
  check('another script\'s built-ins are untouched', good.ok && good.r.plots.length === 3 && v[1] === 399 && v[2] === 1 && Math.abs(v[0] - 397) < 1,
    good.ok ? JSON.stringify(v) : good.e.message);

  // Sanity check that the hostile change really happened (in its own worker only): with `push`
  // broken there, its next run can't even record a plot.
  const again = await settle(engine().run(`indicator('Evil 2'); plot(close);`, bars, {}, { tfSec: 3600 }, 'evil'));
  check('...while the hostile script\'s own worker keeps its change', again.ok && again.r.plots.length === 0,
    again.ok ? `${again.r.plots.length} plots` : again.e.message);

  // One script stuck in a loop doesn't hold up another one.
  const t0 = performance.now();
  const stuck = settle(engine().run(`indicator('Loop'); for (;;) {}`, bars, {}, {}, 'loop'));
  const quick = await settle(engine().run(`indicator('Quick'); plot(close);`, bars, {}, {}, 'quick'));
  const quickMs = performance.now() - t0;
  check('a script stuck in a loop doesn\'t hold up the others', quick.ok && quickMs < 2000, `${quickMs.toFixed(0)} ms`);
  const loop = await stuck;
  check('...and is stopped after 3 seconds', !loop.ok && /^Stopped/.test(loop.e.message), loop.ok ? 'ran' : loop.e.message);
  const after = await settle(engine().run(`indicator('Loop'); plot(close);`, bars, {}, {}, 'loop'));
  check('...after which its worker is restarted', after.ok);

  check('runs of the same script share one worker', spawned === 5, `${spawned} workers started`); // evil, good, loop, quick, loop again
  const bad = await settle(engine().run(`indicator('Bad'); plot(close);`, bars.slice(0, 10), {}, {}, 'bad'));
  check('results are checked against the bars that were sent', bad.ok && bad.r.plots[0].values.length === 10);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
