// MACD + Trend Filter
// Wickline community script by Wickline, shared under the MIT license.

// Trades MACD signal-line crosses, but only in the direction of the long-term trend:
// longs above the 200 EMA, shorts below it. Every trade has a stop loss and a take profit.
strategy('MACD + Trend Filter', { commission: 0.1 });

const trendLength = input('Trend EMA', 200, { min: 2 });
const fastLength = input('MACD fast', 12, { min: 1 });
const slowLength = input('MACD slow', 26, { min: 2 });
const signalLength = input('MACD signal', 9, { min: 1 });
const stopLoss = input('Stop loss %', 3, { min: 0, step: 0.5 });
const takeProfit = input('Take profit %', 6, { min: 0, step: 0.5 });

const trend = ta.ema(close, trendLength);
const { macd, signal } = ta.macd(close, fastLength, slowLength, signalLength);
plot(trend, { title: 'Trend EMA', color: '#FF9800', width: 2 });

const crossUp = ta.crossover(macd, signal);
const crossDown = ta.crossunder(macd, signal);
const aboveTrend = close.map((c, i) => c > trend[i]);
const belowTrend = close.map((c, i) => c < trend[i]);

strategy.entry('Long', 'long', crossUp.map((x, i) => x && aboveTrend[i]));
strategy.entry('Short', 'short', crossDown.map((x, i) => x && belowTrend[i]));
strategy.close('Long', crossDown);
strategy.close('Short', crossUp);
strategy.exit({ stopLoss, takeProfit });
