// Volume Spikes
// Wickline community script by Wickline, shared under the MIT license.

// Marks bars whose volume is far above its recent average.
indicator('Volume Spikes', { overlay: true });

const length = input('Average length', 20, { min: 1 });
const multiple = input('Spike multiple', 2.5, { min: 1, step: 0.1 });

const average = ta.sma(volume, length);
const spike = volume.map((v, i) => v > average[i] * multiple);

marker(spike.map((s, i) => s && close[i] >= open[i]), { position: 'below', shape: 'circle', color: '#34B886' });
marker(spike.map((s, i) => s && close[i] < open[i]), { position: 'above', shape: 'circle', color: '#EC5246' });
