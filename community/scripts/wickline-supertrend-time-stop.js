// Supertrend + Time Stop
// Wickline community script by Wickline, shared under the MIT license.

// Enters when Supertrend turns up and exits when it turns down or after a maximum number of bars.
// It uses strategy.onBar, which runs once per bar, for logic that depends on the open position.
strategy('Supertrend + Time Stop', { commission: 0.1 });

const factor = input('Factor', 3, { min: 0.5, step: 0.5 });
const atrLength = input('ATR length', 10, { min: 1 });
const maxBars = input('Max bars in a trade', 30, { min: 1 });

const st = ta.supertrend(factor, atrLength);
plot(st.value, { title: 'Supertrend', color: st.direction.map((d) => (d === 1 ? '#34B886' : '#EC5246')) });

strategy.onBar((i, s) => {
  const turnedUp = st.direction[i] === 1 && st.direction[i - 1] === -1;
  const turnedDown = st.direction[i] === -1 && st.direction[i - 1] === 1;
  if (!s.position.side && turnedUp) s.long('Trend');
  if (s.position.side === 'long' && (turnedDown || s.position.barsInTrade >= maxBars)) s.close();
});
