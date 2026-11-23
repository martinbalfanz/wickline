// EMA Cross Strategy
// Wickline community script by Wickline, shared under the MIT license.

// Goes long when the fast EMA crosses above the slow one and short when it crosses below,
// with a stop loss and a take profit on every trade. Results appear in the Strategy tester.
strategy('EMA Cross Strategy', { capital: 10000, size: { percent: 100 }, commission: 0.1 });

const fastLength = input('Fast EMA', 12, { min: 1 });
const slowLength = input('Slow EMA', 26, { min: 1 });
const stopLoss = input('Stop loss %', 3, { min: 0, step: 0.5 });
const takeProfit = input('Take profit %', 6, { min: 0, step: 0.5 });

const fast = ta.ema(close, fastLength);
const slow = ta.ema(close, slowLength);
plot(fast, { title: 'Fast', color: '#00BCD4' });
plot(slow, { title: 'Slow', color: '#FF9800' });

strategy.entry('Long', 'long', ta.crossover(fast, slow));
strategy.entry('Short', 'short', ta.crossunder(fast, slow));
strategy.exit({ stopLoss, takeProfit });
