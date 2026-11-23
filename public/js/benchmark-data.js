// Hidden, shared benchmark price feeds for custom indicators.
// Prices align only on matching candle timestamps (no stale forward-fill).
export function alignBenchmarkCloses(chartBars, benchmarkBars, chartTz = 0, benchmarkTz = 0) {
  const values = new Array(chartBars.length).fill(NaN);
  const offset = chartTz - benchmarkTz;
  let j = 0;
  for (let i = 0; i < chartBars.length; i++) {
    const t = chartBars[i].time - offset;
    while (j < benchmarkBars.length && benchmarkBars[j].time < t) j++;
    if (j < benchmarkBars.length && benchmarkBars[j].time === t &&
        Number.isFinite(benchmarkBars[j].close)) values[i] = benchmarkBars[j].close;
  }
  return values;
}

export class BenchmarkFeedCache {
  constructor(createFeed, onChange) {
    this.createFeed = createFeed;
    this.onChange = onChange;
    this.entries = new Map();
  }

  ensure(symbol, timeframe, tfId) {
    const old = this.entries.get(symbol);
    if (old?.tfId === tfId) return old;
    old?.feed.close();

    const feed = this.createFeed(symbol, timeframe);
    const entry = { feed, tfId, bars: [], tz: 0, error: null };
    this.entries.set(symbol, entry);

    feed.loadInitial().then((res) => {
      if (this.entries.get(symbol) !== entry) return;
      entry.bars = res.bars || [];
      entry.tz = res.meta?.tzOffset || 0;
      this.onChange(symbol);
      feed.subscribe({
        bars: (incoming) => {
          if (this.entries.get(symbol) !== entry || !incoming?.length) return;
          for (const b of incoming) {
            const a = entry.bars;
            const last = a[a.length - 1];
            if (!last || b.time > last.time) a.push(b);
            else if (b.time === last.time) a[a.length - 1] = b;
            else {
              const i = a.findIndex((bar) => bar.time >= b.time);
              if (i >= 0 && a[i].time === b.time) a[i] = b;
              else if (i >= 0) a.splice(i, 0, b);
            }
          }
          this.onChange(symbol);
        },
        tick: () => {},
        status: () => {},
      });
    }).catch((err) => {
      if (this.entries.get(symbol) !== entry) return;
      entry.error = err.message || String(err);
      this.onChange(symbol);
    });
    return entry;
  }

  get(symbol, tfId) {
    const entry = this.entries.get(symbol);
    return entry?.tfId === tfId ? entry : null;
  }

  prune(required) {
    for (const [symbol, entry] of this.entries) {
      if (required.has(symbol)) continue;
      entry.feed.close();
      this.entries.delete(symbol);
    }
  }

  clear() {
    for (const entry of this.entries.values()) entry.feed.close();
    this.entries.clear();
  }
}


/** Per-chart adapter: independent feeds shared across its script indicators. */
export class ScriptBenchmarks {
  constructor(view, createFeed) {
    this.view = view;
    this.tfId = view.state.tf;
    this.cache = new BenchmarkFeedCache(createFeed, symbol => {
      if (this.view.destroyed) return;
      for (const entry of this.view.live.values()) {
        if (entry.script && entry.benchmarkSymbols?.includes(symbol)) this.view.runScript(entry);
      }
    });
  }

  resetTimeframe() {
    if (this.tfId === this.view.state.tf) return;
    this.cache.clear();
    this.tfId = this.view.state.tf;
  }

  closes() {
    const view = this.view;
    const result = {};
    const tz = view.meta.tzOffset || 0;
    for (const [symbol, entry] of view.compareEntries) {
      result[symbol] = alignBenchmarkCloses(view.bars, entry.bars || [], tz, entry.tz || 0);
    }
    for (const [symbol] of this.cache.entries) {
      const entry = this.cache.get(symbol, view.state.tf);
      if (entry) result[symbol] = alignBenchmarkCloses(view.bars, entry.bars, tz, entry.tz);
    }
    // Comparing the active symbol against itself needs no second fetch.
    result[view.state.symbol] = view.bars.map(bar => bar.close);
    return result;
  }

  update(entry, requested) {
    entry.benchmarkSymbols = Array.isArray(requested) ? requested : [];
    for (const symbol of entry.benchmarkSymbols) {
      if (symbol !== this.view.state.symbol) this.cache.ensure(symbol, this.view.tf, this.view.state.tf);
    }
    this.prune();
  }

  prune() {
    const required = new Set();
    for (const entry of this.view.live.values()) {
      if (entry.script) for (const symbol of entry.benchmarkSymbols || []) required.add(symbol);
    }
    this.cache.prune(required);
  }

  close() { this.cache.clear(); }
}
