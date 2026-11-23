// EMA Cross Signals
// Wickline community script by Wickline, shared under the MIT license.

// Two EMAs with a shaded gap and buy/sell markers where they cross.
indicator('EMA Cross Signals', { overlay: true });

const fastLength = input('Fast EMA', 9, { min: 1 });
const slowLength = input('Slow EMA', 21, { min: 1 });

const fast = ta.ema(close, fastLength);
const slow = ta.ema(close, slowLength);

const a = plot(fast, { title: 'Fast', color: '#00BCD4' });
const b = plot(slow, { title: 'Slow', color: '#FF9800' });
fill(a, b, { color: 'rgba(0, 188, 212, 0.08)' });

marker(ta.crossover(fast, slow), { position: 'below', shape: 'up', color: '#34B886', text: 'Buy' });
marker(ta.crossunder(fast, slow), { position: 'above', shape: 'down', color: '#EC5246', text: 'Sell' });
