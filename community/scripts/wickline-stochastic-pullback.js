// Stochastic Pullback
// Wickline community script by Wickline, shared under the MIT license.

// Buys when the Stochastic turns up from oversold while price is above its 200 EMA,
// and sells when the Stochastic reaches overbought (or on the stop loss).
strategy('Stochastic Pullback', { overlay: false, commission: 0.1 });

const kLength = input('%K length', 14, { min: 1 });
const smooth = input('%K smoothing', 3, { min: 1 });
const dLength = input('%D length', 3, { min: 1 });
const trendLength = input('Trend EMA', 200, { min: 2 });
const oversold = input('Oversold', 20);
const overbought = input('Overbought', 80);
const stopLoss = input('Stop loss %', 4, { min: 0, step: 0.5 });

const k = ta.sma(ta.stoch(close, high, low, kLength), smooth);
const d = ta.sma(k, dLength);
const trend = ta.ema(close, trendLength);
plot(k, { title: '%K', color: '#4FA3F7' });
plot(d, { title: '%D', color: '#FF9800' });
hline(overbought);
hline(oversold);
fill(overbought, oversold, { color: 'rgba(79, 163, 247, 0.06)' });

// %K crossing back above %D, with the Stochastic oversold in the last few bars.
const turnUp = ta.crossover(k, d);
const wasOversold = ta.lowest(k, 5).map((v) => v < oversold);
strategy.entry('Long', 'long', turnUp.map((x, i) => x && wasOversold[i] && close[i] > trend[i]));
strategy.close('Long', k.map((v) => v > overbought));
strategy.exit({ stopLoss });
