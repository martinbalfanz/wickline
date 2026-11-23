// RSI Mean Reversion
// Wickline community script by Wickline, shared under the MIT license.

// Buys when RSI climbs back above the oversold level and sells when it reaches the exit level.
strategy('RSI Mean Reversion', { overlay: false, commission: 0.1 });

const length = input('RSI length', 14, { min: 2 });
const oversold = input('Buy when RSI crosses above', 30);
const exitLevel = input('Sell when RSI reaches', 60);
const stopLoss = input('Stop loss %', 8, { min: 0, step: 0.5 });

const r = ta.rsi(close, length);
plot(r, { title: 'RSI', color: '#7E57C2' });
hline(oversold);
hline(exitLevel);

strategy.entry('Buy', 'long', ta.crossover(r, oversold));
strategy.close('Buy', r.map((v) => v >= exitLevel));
strategy.exit({ stopLoss });
