// Turtle Breakout
// Wickline community script by Wickline, shared under the MIT license.

// The Turtle traders' rules: buy a 20-bar high, sell a 10-bar low,
// and get out if price closes 2 ATRs below the entry.
strategy('Turtle Breakout', { commission: 0.1 });

const entryLength = input('Entry: highest high of', 20, { min: 2 });
const exitLength = input('Exit: lowest low of', 10, { min: 2 });
const atrMult = input('Stop (x ATR)', 2, { min: 0.5, step: 0.5 });

// Channels of the previous bars (not including the current one).
const upper = ta.shift(ta.highest(high, entryLength), 1);
const lower = ta.shift(ta.lowest(low, exitLength), 1);
const atr = ta.atr(20);
plot(upper, { title: 'Entry channel', color: '#34B886', style: 'step' });
plot(lower, { title: 'Exit channel', color: '#EC5246', style: 'step' });

// Enter only on the bar the signal starts: a signal that stays true would stack entries when Pyramiding is raised.
const breakout = close.map((c, i) => c > upper[i]);
strategy.entry('Long', 'long', breakout.map((x, i) => x && !breakout[i - 1]));
strategy.close('Long', close.map((c, i) => c < lower[i]));
strategy.onBar((i, s) => {
  if (s.position.side === 'long' && close[i] < s.position.avgPrice - atrMult * atr[i]) s.close('Long', { comment: 'ATR stop' });
});
