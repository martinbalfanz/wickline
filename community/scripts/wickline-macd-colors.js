// MACD Colors
// Wickline community script by Wickline, shared under the MIT license.

// MACD with a histogram colored by direction and whether it is growing or fading.
indicator('MACD Colors', { overlay: false });

const { macd, signal, hist } = ta.macd(close, input('Fast', 12), input('Slow', 26), input('Signal', 9));

plot(hist, {
  title: 'Histogram',
  style: 'histogram',
  color: hist.map((h, i) => (h >= 0
    ? (h >= hist[i - 1] ? '#26A69A' : '#B2DFDB')
    : (h <= hist[i - 1] ? '#FF5252' : '#FFCDD2'))),
});
plot(macd, { title: 'MACD', color: '#4FA3F7' });
plot(signal, { title: 'Signal', color: '#FF6D00' });
hline(0);
