// Bundled, editable starter for the Wickline script editor.
export const RS_LEADER_SCRIPT = String.raw`// MB RS Leader — stock relative strength against SPY, not RSI.
// SPY data loads automatically without adding it through Compare.
indicator('MB RS Leader', { overlay: false, shortName: 'RS / SPY', precision: 2 });

const baselineLength = input('RS baseline EMA', 50, { min: 5, max: 250 });
const signalLength = input('Signal EMA', 10, { min: 2, max: 100 });
const showEvents = input('Show RS-ahead-of-price events', true);
const minGap = input('Minimum price gap from annual high (%)', 2, { min: 0, max: 50 });
const maxGap = input('Maximum price gap from annual high (%)', 20, { min: 1, max: 80 });

const supported = !timeframe.intraday;
const monthly = timeframe.seconds >= 2400000;
const weekly = !monthly && timeframe.seconds >= 604800;
const p1 = monthly ? 1 : weekly ? 4 : 21;
const p3 = monthly ? 3 : weekly ? 13 : 63;
const p6 = monthly ? 6 : weekly ? 26 : 126;
const annual = monthly ? 12 : weekly ? 52 : 252;

// compareClose requests a background feed and returns time-aligned closes.
const spy = supported ? compareClose('YAHOO:SPY') : new Array(n).fill(NaN);
const ratio = close.map((price, i) =>
  Number.isFinite(price) && Number.isFinite(spy[i]) && spy[i] > 0
    ? price / spy[i] : NaN
);
const relReturn = (period) => ratio.map((r, i) =>
  i >= period && Number.isFinite(r) &&
  Number.isFinite(ratio[i - period]) && ratio[i - period] > 0
    ? 100 * (r / ratio[i - period] - 1) : NaN
);
const r1 = relReturn(p1);
const r3 = relReturn(p3);
const r6 = relReturn(p6);

const baseline = ta.ema(ratio, baselineLength);
const trend = ratio.map((r, i) =>
  Number.isFinite(r) && Number.isFinite(baseline[i]) && baseline[i] > 0
    ? 100 * (r / baseline[i] - 1) : NaN
);
const signal = ta.ema(trend, signalLength);
const colors = trend.map((v, i) => {
  if (!Number.isFinite(v)) return '#64748B';
  const rising = i > 0 && Number.isFinite(trend[i - 1]) && v > trend[i - 1];
  return v >= 0
    ? (rising ? '#20DDB3' : '#38BDF8')
    : (rising ? '#FBBF73' : '#FB7185');
});

// Colored trend and thin signal line, with restrained up/down shading.
plot(trend, { title: 'RS trend', color: colors, width: 3 });
plot(signal, { title: 'RS signal', color: '#F59E0B', width: 2 });
hline(0, { color: '#64748B' });
const pos = plot(trend.map(v => Number.isFinite(v) ? Math.max(0, v) : NaN), {
  title: 'Positive cloud', color: 'rgba(0,0,0,0)', width: 1, legend: false
});
const neg = plot(trend.map(v => Number.isFinite(v) ? Math.min(0, v) : NaN), {
  title: 'Negative cloud', color: 'rgba(0,0,0,0)', width: 1, legend: false
});
fill(pos, 0, { color: 'rgba(32,221,179,0.12)' });
fill(neg, 0, { color: 'rgba(251,113,133,0.10)' });

// RS AHEAD: ratio at a NEW prior-52-week high while the stock price
// remains 2–20% below its previous annual high. Historical event,
// not a buy signal. Prior windows exclude the current candle.
const ahead = new Array(n).fill(false);
if (supported && showEvents) {
  let previousEvent = -Infinity;
  for (let i = annual; i < n; i++) {
    if (!Number.isFinite(ratio[i])) continue;
    let priorRS = -Infinity, priorPrice = -Infinity, complete = true;
    for (let j = i - annual; j < i; j++) {
      if (!Number.isFinite(ratio[j]) || !Number.isFinite(high[j])) {
        complete = false;
        break;
      }
      priorRS = Math.max(priorRS, ratio[j]);
      priorPrice = Math.max(priorPrice, high[j]);
    }
    if (!complete || priorPrice <= 0) continue;
    const gap = 100 * (priorPrice - high[i]) / priorPrice;
    if (ratio[i] > priorRS && gap >= minGap && gap <= maxGap &&
        i - previousEvent >= 20) {
      ahead[i] = true;
      previousEvent = i;
    }
  }
  marker(ahead, {
    position: 'above', shape: 'circle', color: '#38BDF8', text: 'RS AHEAD'
  });
}

const k = n - 1, current = trend[k], three = r3[k];
const delta5 = k >= 5 && Number.isFinite(current) &&
  Number.isFinite(trend[k - 5]) ? current - trend[k - 5] : NaN;
// Ignore tiny movements in the trend oscillator (percentage-point threshold).
const rising5 = Number.isFinite(delta5) && delta5 > 0.03;
const falling5 = Number.isFinite(delta5) && delta5 < -0.03;
let status = supported ? 'LOADING SPY / HISTORY' : 'D / W / M ONLY';
let tone = 'neutral';
if (Number.isFinite(current) && Number.isFinite(three)) {
  if (symbol === 'YAHOO:SPY') {
    status = 'BENCHMARK';
  } else if (current > 0 && three > 0 && rising5) {
    status = 'LEADING'; tone = 'positive';
  } else if (current > 0 && three > 0 && falling5) {
    status = 'LEADER COOLING'; tone = 'warning';
  } else if (current > 0 && three > 0) {
    status = 'OUTPERFORMING'; tone = 'positive';
  } else if (current > 0) {
    status = 'EARLY RECOVERY'; tone = 'warning';
  } else if (three > 0) {
    status = 'RS PULLBACK'; tone = 'warning';
  } else if (rising5) {
    status = 'RECOVERING'; tone = 'warning';
  } else {
    status = 'LAGGING'; tone = 'negative';
  }
}
const fmt = v => Number.isFinite(v)
  ? (v >= 0 ? '+' : '') + v.toFixed(1) + '%' : '—';
const metric = (label, v) => ({
  label, value: fmt(v),
  tone: !Number.isFinite(v) ? 'neutral' : v > 0 ? 'positive' : v < 0 ? 'negative' : 'neutral'
});
dashboard({
  status, tone, metrics: [
    metric('1M vs SPY', r1[k]),
    metric('3M vs SPY', r3[k]),
    metric('6M vs SPY', r6[k])
  ]
});
if (!supported) log('RS Leader supports daily, weekly and monthly charts only.');
else if (!Number.isFinite(current)) log('Waiting for SPY history and RS EMA warmup.');
`;
