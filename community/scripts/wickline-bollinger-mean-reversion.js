// Bollinger Mean Reversion
// Wickline community script by Wickline, shared under the MIT license.

// Buys when price closes back above the lower Bollinger Band (a stretched move snapping back)
// and sells when it reaches the middle band.
strategy('Bollinger Mean Reversion', { commission: 0.1 });

const length = input('Length', 20, { min: 2 });
const mult = input('StdDev', 2, { min: 0.5, step: 0.1 });
const stopLoss = input('Stop loss %', 5, { min: 0, step: 0.5 });

const { upper, basis, lower } = ta.bb(close, length, mult);
const a = plot(upper, { title: 'Upper', color: '#4FA3F7' });
plot(basis, { title: 'Basis', color: '#FF6D00' });
const b = plot(lower, { title: 'Lower', color: '#4FA3F7' });
fill(a, b, { color: 'rgba(79, 163, 247, 0.06)' });

strategy.entry('Long', 'long', ta.crossover(close, lower));
strategy.close('Long', close.map((c, i) => c >= basis[i]));
strategy.exit({ stopLoss });
