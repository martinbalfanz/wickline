// Supertrend + ADX
// Wickline community script by Wickline, shared under the MIT license.

// Follows Supertrend flips both ways, but only opens a trade when ADX says the market is
// actually trending (above the threshold). A flip the other way closes the trade.
strategy('Supertrend + ADX', { commission: 0.1 });

const factor = input('Factor', 3, { min: 0.5, step: 0.5 });
const atrLength = input('ATR length', 10, { min: 1 });
const adxLength = input('ADX length', 14, { min: 2 });
const minAdx = input('Trade when ADX above', 20, { min: 0 });

const st = ta.supertrend(factor, atrLength);
const { adx } = ta.dmi(adxLength, adxLength);
plot(st.value, { title: 'Supertrend', color: st.direction.map((d) => (d === 1 ? '#34B886' : '#EC5246')) });

const turnedUp = st.direction.map((d, i) => d === 1 && st.direction[i - 1] === -1);
const turnedDown = st.direction.map((d, i) => d === -1 && st.direction[i - 1] === 1);
const trending = adx.map((v) => v > minAdx);

strategy.entry('Long', 'long', turnedUp.map((x, i) => x && trending[i]));
strategy.entry('Short', 'short', turnedDown.map((x, i) => x && trending[i]));
strategy.close('Long', turnedDown);
strategy.close('Short', turnedUp);
