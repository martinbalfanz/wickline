// Runs one submitted script through the app's real script worker on sample bars and prints a
// JSON summary. scripts/community.mjs starts this in a separate Node process with an empty
// environment, no file access beyond the app's code (Node's permission model) and a time limit,
// so the code being checked can't read secrets or change anything. In the workflow that process
// itself runs in a container with no network. The code could still print a fake summary, so the
// caller treats what this prints as untrusted (lib/community.mjs → cleanRunResult).
//
// Usage: node community-sandbox.mjs < script.js

// A console.log() in a script would otherwise land in the summary on stdout.
globalThis.console = new console.Console({ stdout: process.stderr, stderr: process.stderr });

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const code = Buffer.concat(chunks).toString('utf8');

// A deterministic, trending and swinging market so most scripts have something to react to.
function sampleData(n = 600) {
  const data = { time: [], open: [], high: [], low: [], close: [], volume: [] };
  let p = 100, seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = Math.max(1, o * (1 + Math.sin(i / 11) * 0.008 + (rnd() - 0.48) * 0.02));
    data.time.push(1700000000 + i * 3600);
    data.open.push(o); data.close.push(c);
    data.high.push(Math.max(o, c) * (1 + rnd() * 0.006));
    data.low.push(Math.min(o, c) * (1 - rnd() * 0.006));
    data.volume.push(1000 + rnd() * 4000);
    p = c;
  }
  return Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Float64Array.from(v)]));
}

let reply = null;
globalThis.self = { postMessage: (m) => { reply = m; } };
await import('../public/js/script-worker.js');
self.onmessage({ data: { id: 1, code, data: sampleData(), inputs: {}, ctx: { tfSec: 3600, symbol: 'SAMPLE' } } });

const r = reply || { ok: false, error: 'The script produced no result.' };
const out = r.ok
  ? {
    ok: true,
    name: String(r.result.meta?.name || ''),
    kind: r.result.meta?.strategy ? 'strategy' : 'indicator',
    plots: r.result.plots?.length || 0,
    markers: r.result.markers?.length || 0,
    trades: r.result.strategy ? (r.result.strategy.trades?.length || 0) + (r.result.strategy.openTrades?.length || 0) : null,
  }
  : { ok: false, error: String(r.error || 'Unknown error').slice(0, 500), line: r.line ?? null };
process.stdout.write(JSON.stringify(out));
process.exit(0);
