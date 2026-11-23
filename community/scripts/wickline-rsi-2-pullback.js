// RSI(2) Pullback
// Wickline community script by Wickline, shared under the MIT license.

// A short-term pullback system: when price is above its 200 SMA (an uptrend), buy when the
// 2-period RSI is deeply oversold, and sell as soon as price closes above its 5 SMA.
strategy('RSI(2) Pullback', { commission: 0.05 });

const rsiLength = input('RSI length', 2, { min: 2 });
const buyBelow = input('Buy when RSI below', 10, { min: 1, max: 50 });
const trendLength = input('Trend SMA', 200, { min: 2 });
const exitLength = input('Exit SMA', 5, { min: 2 });

const r = ta.rsi(close, rsiLength);
const trend = ta.sma(close, trendLength);
const exitMa = ta.sma(close, exitLength);
plot(trend, { title: 'Trend SMA', color: '#7E57C2', width: 2 });
plot(exitMa, { title: 'Exit SMA', color: '#00BCD4' });

// Enter only on the bar the signal starts: a signal that stays true would stack entries when Pyramiding is raised.
const setup = close.map((c, i) => c > trend[i] && r[i] < buyBelow);
strategy.entry('Long', 'long', setup.map((x, i) => x && !setup[i - 1]));
strategy.close('Long', close.map((c, i) => c > exitMa[i]));
