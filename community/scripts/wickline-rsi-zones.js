// RSI Zones
// Wickline community script by Wickline, shared under the MIT license.

// RSI in its own pane; the line turns red when overbought and green when oversold.
indicator('RSI Zones', { overlay: false, precision: 1 });

const length = input('Length', 14, { min: 2 });
const upper = input('Overbought', 70);
const lower = input('Oversold', 30);

const r = ta.rsi(close, length);
plot(r, {
  title: 'RSI',
  color: r.map((v) => (v > upper ? '#EC5246' : v < lower ? '#34B886' : '#7E57C2')),
});
hline(upper);
hline(lower);
fill(upper, lower, { color: 'rgba(126, 87, 194, 0.08)' });
