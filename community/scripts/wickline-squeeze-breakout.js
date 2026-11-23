// Squeeze Breakout
// Wickline community script by Wickline, shared under the MIT license.

// Volatility comes in waves: when the Bollinger Bands get as narrow as they have been in a
// while (a squeeze), trade the first close outside the bands, and ride it with a trailing stop.
strategy('Squeeze Breakout', { commission: 0.1 });

const length = input('Length', 20, { min: 2 });
const mult = input('StdDev', 2, { min: 0.5, step: 0.1 });
const lookback = input('Squeeze: narrowest in (bars)', 60, { min: 5 });
const window = input('Breakout within (bars)', 10, { min: 1 });
const trail = input('Trailing stop %', 3, { min: 0.5, step: 0.5 });

const { upper, basis, lower } = ta.bb(close, length, mult);
const width = upper.map((u, i) => (u - lower[i]) / basis[i]);
const narrowest = ta.lowest(width, lookback);
// 1 on bars where the bands were (within 5% of) their narrowest, then "was there one recently?"
const squeeze = width.map((w, i) => (w <= narrowest[i] * 1.05 ? 1 : 0));
const recentSqueeze = ta.highest(squeeze, window);

const a = plot(upper, { title: 'Upper', color: '#4FA3F7' });
plot(basis, { title: 'Basis', color: '#8E8A82' });
const b = plot(lower, { title: 'Lower', color: '#4FA3F7' });
fill(a, b, { color: 'rgba(79, 163, 247, 0.06)' });
marker(squeeze.map((s, i) => s && !squeeze[i - 1]), { position: 'below', shape: 'circle', color: '#FFB300' });

// Enter only on the bar the signal starts: a signal that stays true would stack entries when Pyramiding is raised.
const up = close.map((c, i) => c > upper[i] && recentSqueeze[i] === 1);
const down = close.map((c, i) => c < lower[i] && recentSqueeze[i] === 1);
strategy.entry('Long', 'long', up.map((x, i) => x && !up[i - 1]));
strategy.entry('Short', 'short', down.map((x, i) => x && !down[i - 1]));
strategy.exit({ trailing: trail });
