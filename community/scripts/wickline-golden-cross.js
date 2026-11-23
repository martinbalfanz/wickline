// Golden Cross
// Wickline community script by Wickline, shared under the MIT license.

// The classic long-term trend signal: be long while the 50-period SMA is above the 200,
// and step aside when it falls back below.
strategy('Golden Cross', { commission: 0.1 });

const fastLength = input('Fast SMA', 50, { min: 1 });
const slowLength = input('Slow SMA', 200, { min: 2 });

const fast = ta.sma(close, fastLength);
const slow = ta.sma(close, slowLength);
plot(fast, { title: 'Fast SMA', color: '#FFB300' });
plot(slow, { title: 'Slow SMA', color: '#7E57C2', width: 2 });

// Enter only on the bar the signal starts: a signal that stays true would stack entries when Pyramiding is raised.
const above = fast.map((f, i) => f > slow[i]);
strategy.entry('Long', 'long', above.map((x, i) => x && !above[i - 1]));
strategy.close('Long', fast.map((f, i) => f < slow[i]));
