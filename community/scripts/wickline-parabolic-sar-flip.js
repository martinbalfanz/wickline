// Parabolic SAR Flip
// Wickline community script by Wickline, shared under the MIT license.

// Always in the market: long while price is above the Parabolic SAR, short while it is below.
strategy('Parabolic SAR Flip', { commission: 0.1 });

const start = input('Start', 0.02, { min: 0.001, step: 0.01 });
const increment = input('Increment', 0.02, { min: 0.001, step: 0.01 });
const maximum = input('Maximum', 0.2, { min: 0.01, step: 0.05 });

// dir is 1 while the SAR is below price (uptrend) and -1 while it is above.
const { sar, dir } = ta.psar(start, increment, maximum);
plot(sar, { title: 'SAR', style: 'dots', color: dir.map((d) => (d === 1 ? '#34B886' : '#EC5246')) });

strategy.entry('Long', 'long', dir.map((d, i) => d === 1 && dir[i - 1] === -1));
strategy.entry('Short', 'short', dir.map((d, i) => d === -1 && dir[i - 1] === 1));
