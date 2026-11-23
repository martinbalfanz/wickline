// Optional custom-indicator API, isolated from Wickline's core script worker.
// Keep its user-controlled metadata bounded and sanitized before rendering.
const MAX_BENCHMARKS = 4;
const SYMBOL = /^[A-Z0-9^._:/=-]{1,64}$/;
const TONES = ['positive', 'warning', 'negative', 'neutral'];
const tone = v => TONES.includes(v) ? v : 'neutral';
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) :
  typeof v === 'number' || typeof v === 'boolean' ? String(v).slice(0, max) : '');

export function indicatorApi(out, ctx, n) {
  return {
    compareClose(fullSymbol) {
      const sym = text(fullSymbol, 64).toUpperCase();
      if (!SYMBOL.test(sym)) throw new Error('compareClose(): invalid symbol');
      if (!out.benchmarks.includes(sym)) {
        if (out.benchmarks.length >= MAX_BENCHMARKS) throw new Error('compareClose(): limit of four benchmark symbols');
        out.benchmarks.push(sym);
      }
      const values = ctx.compareCloses?.[sym];
      return Array.isArray(values) && values.length === n ? values : new Array(n).fill(NaN);
    },
    dashboard(opts = {}) {
      const metrics = Array.isArray(opts.metrics) ? opts.metrics.slice(0, 4) : [];
      out.meta.dashboard = {
        status: text(opts.status, 32),
        tone: tone(opts.tone),
        metrics: metrics.map(m => ({
          label: text(m?.label, 18), value: text(m?.value, 22), tone: tone(m?.tone),
        })),
      };
    },
  };
}

/** Whitelist script extensions at the same trust boundary as sanitizeResult(). */
export function sanitizeIndicatorExtras(result, budget) {
  const raw = Array.isArray(result?.benchmarks) ? result.benchmarks.slice(0, MAX_BENCHMARKS) : [];
  const benchmarks = [];
  for (const candidate of raw) {
    const s = text(candidate, 64).toUpperCase();
    if (SYMBOL.test(s) && !benchmarks.includes(s)) benchmarks.push(s);
  }
  budget.spend(benchmarks.length);

  const d = result?.meta?.dashboard;
  let dashboard = null;
  if (d && typeof d === 'object' && !Array.isArray(d)) {
    const metrics = Array.isArray(d.metrics) ? d.metrics.slice(0, 4) : [];
    budget.spend(metrics.length + 1);
    dashboard = {
      status: text(d.status, 32),
      tone: tone(d.tone),
      metrics: metrics.map(m => ({
        label: text(m?.label, 18),
        value: text(m?.value, 22),
        tone: tone(m?.tone),
      })),
    };
  }
  return { benchmarks, dashboard };
}
