// Script results are cleaned before the page uses them (community scripts can't inject HTML). Run: npm test
import { sanitizeResult, safeColor, coerceParam, coerceParams, MAX_RESULT_VALUES } from '../public/js/script-sanitize.js';
import { csvCell, tradesCsv } from '../public/js/csv.js';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
};
const throws = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };

const EVIL = '"><img src=x onerror=alert(1)>';
const N = 4; // bars in the fixture below

console.log('script results');
{
  check('normal colours pass', ['#4FA3F7', '#fff', 'rgba(0, 188, 212, 0.08)', 'hsl(120deg 50% 50%)', 'red'].every((c) => safeColor(c) === c));
  check('HTML and CSS tricks in colours are replaced', [EVIL, 'red;background:url(x)', 'red" onclick="x', "url('x')", 'a'.repeat(60), 42, null]
    .every((c) => safeColor(c) === '#4FA3F7'));

  const r = sanitizeResult({
    meta: { name: EVIL.repeat(5), short: 5, overlay: 1, precision: '3', strategy: true },
    inputs: [
      { key: 'x"', title: EVIL, def: EVIL, type: 'number', min: EVIL, max: '50', step: 1 },
      { key: 'in1', title: 'Mode', def: 'EMA', type: 'select', options: ['EMA', EVIL] },
      { title: 'On', def: 'yes', type: 'bool' },
      { title: 'Weird', def: 1, type: '<b>' },
    ],
    plots: [
      { key: 'p0', title: 'A', color: EVIL, colors: ['#fff', EVIL, null, null], type: 'nope', width: 99, values: [1, '2', 'x', 4] },
      { key: '"><x', title: '', color: '#00BCD4', values: new Float64Array([1, 2, 3, 4]) },
    ],
    hlines: [{ price: '70', color: EVIL }],
    fills: [{ from: 'p0', to: 'p1', color: EVIL }, { from: EVIL, to: 'p1' }, { from: '_c0', to: 'p0' }, { from: 'p0', to: 'p7' }, { from: '_c9', to: 'p0' }],
    consts: { _c0: '30', evil: 1, __proto__: { polluted: 1 } },
    markers: [{ i: 3, shape: EVIL, position: 'belowBar', color: EVIL, text: EVIL }, { i: -1 }, { i: 'x' }, { i: 4 }, { i: 1 }],
    logs: [EVIL],
    strategy: {
      props: { initialCapital: EVIL, sizeType: EVIL, sizeValue: '50', commission: 0.1, slippage: null, pyramiding: '2', fillOn: EVIL },
      trades: [{ id: EVIL, side: EVIL, entryIndex: EVIL, pnl: 5, reason: 'Stop loss', extra: { deep: [1, 2, 3] }, __proto__: { x: 1 } }],
      openTrades: [],
      markers: [{ i: 1, kind: 'entry', side: 'long', id: 'Long', price: '10' }, { i: 9, kind: 'exit' }],
      equity: [1, 2, 3, 4], drawdown: new Float64Array(N), buyHold: new Float64Array(N),
      summary: { netProfit: 1, profitFactor: Infinity, long: { trades: '3' }, name: EVIL },
    },
  }, { bars: N });

  check('names are plain text and truncated', r.meta.name.length === 60 && r.meta.short === '5' && r.meta.precision === 3 && r.meta.strategy === true);
  check('input keys are rebuilt, numbers are numbers', r.inputs[0].key === 'in0' && r.inputs[0].def === 0 && r.inputs[0].min === undefined && r.inputs[0].max === 50);
  check('select options are text, bools are bools, unknown types become numbers',
    r.inputs[1].options[1] === EVIL && r.inputs[2].def === true && r.inputs[3].type === 'number');
  check('plot colours are checked, per-bar colours too', r.plots[0].color === '#4FA3F7' && r.plots[0].colors.join() === '#fff,,,' && r.plots[1].color === '#00BCD4');
  check('plot keys, styles and widths are rebuilt', r.plots[1].key === 'p1' && r.plots[0].type === 'line' && r.plots[0].width === 4);
  check('plot values become a Float64Array', r.plots[0].values instanceof Float64Array && r.plots[0].values[1] === 2 && Number.isNaN(r.plots[0].values[2]));
  check('fills only reference plots or constants that exist', r.fills.length === 2 && r.fills[0].color === 'rgba(79, 163, 247, 0.12)'
    && r.fills[1].from === '_c0', JSON.stringify(r.fills));
  check('constants are numbers, nothing else gets in', r.consts._c0 === 30 && !('evil' in r.consts) && !({}).polluted);
  check('levels are numbers with safe colours', r.hlines[0].price === 70 && r.hlines[0].color === '#8E8A82');
  check('markers are checked, kept inside the bars and sorted by bar', r.markers.length === 2 && r.markers.map((m) => m.i).join() === '1,3'
    && r.markers[1].shape === 'circle' && r.markers[1].color === '#4FA3F7' && r.markers[1].text.length === 20, JSON.stringify(r.markers));

  const s = r.strategy;
  check('strategy settings are numbers and known options', s.props.initialCapital === 10000 && s.props.sizeType === 'percent'
    && s.props.sizeValue === 50 && s.props.pyramiding === 2 && s.props.fillOn === 'open' && s.props.slippage === 0);
  check('trade text stays text, numbers become numbers', s.trades[0].id === EVIL.slice(0, 60) && s.trades[0].side === null
    && Number.isNaN(s.trades[0].entryIndex) && s.trades[0].reason === 'Stop loss');
  check('trades are flat copies with a fixed set of fields', !('extra' in s.trades[0]) && !('x' in s.trades[0])
    && typeof s.trades[0].comment === 'string' && Number.isNaN(s.trades[0].exitPrice) && Object.getPrototypeOf(s.trades[0]) === Object.prototype);
  check('report markers outside the bars are dropped', s.markers.length === 1 && s.markers[0].price === 10 && s.markers[0].reason === '');
  check('report series are Float64Arrays', s.equity instanceof Float64Array && s.equity[1] === 2 && s.buyHold.length === N);
  check('summary keeps Infinity and nested numbers, drops unknown fields', s.summary.profitFactor === Infinity && s.summary.long.trades === 3
    && !('name' in s.summary));
  check('a summary without long/short still has both (the tester reads them)', Number.isNaN(s.summary.short.netProfit) && s.summary.short.winRate === null);
  check('a missing or junk result still gives a usable shape', (() => {
    const e = sanitizeResult(null, { bars: 10 });
    return e.meta.name === 'Untitled script' && Array.isArray(e.plots) && !e.strategy;
  })());
  check('the bar count is required', throws(() => sanitizeResult({}), /bar count/));
}

console.log('one value per bar');
{
  check('plot values must match the bar count', throws(() => sanitizeResult({ plots: [{ values: [1, 2, 3] }] }, { bars: 4 }), /plot 1 has 3 values but the chart has 4 bars/));
  check('missing plot values are an error, not an empty plot', throws(() => sanitizeResult({ plots: [{}] }, { bars: 4 }), /0 values/));
  check('per-bar colours must match the bar count', throws(() => sanitizeResult({ plots: [{ values: [1, 2], colors: ['red'] }] }, { bars: 2 }), /1 colours/));
  check('equity curve must match the bar count', throws(() => sanitizeResult({
    strategy: { equity: [1], drawdown: [1, 2], buyHold: [1, 2] },
  }, { bars: 2 }), /equity curve has 1 values/));
}

console.log('result size');
{
  // The old attack: a few hundred trades that all point at the same huge nested object.
  const big = Array.from({ length: 2000 }, () => 1);
  const nested = Array.from({ length: 2000 }, () => big);
  const trades = Array.from({ length: 200 }, () => ({ id: 'x', side: 'long', pnl: nested, qty: nested, comment: nested, extra: nested }));
  const t0 = performance.now();
  const r = sanitizeResult({ strategy: { trades, equity: [1, 2], drawdown: [1, 2], buyHold: [1, 2] } }, { bars: 2 });
  const ms = performance.now() - t0;
  check('shared references are not walked (flat copies)', r.strategy.trades.length === 200 && Number.isNaN(r.strategy.trades[0].pnl)
    && r.strategy.trades[0].comment === '' && ms < 100, `${ms.toFixed(1)} ms`);

  const many = Array.from({ length: 1001 + 10 * 5 }, () => ({ id: 'L', side: 'long', pnl: 1 }));
  check('more trades than bars allow is refused with a clear error', throws(() => sanitizeResult({
    strategy: { trades: many, equity: new Float64Array(5), drawdown: new Float64Array(5), buyHold: new Float64Array(5) },
  }, { bars: 5 }), /1,051 trades for 5 bars \(at most 1,050\)/));

  const n = 300000;
  const flat = new Float64Array(n);
  const lots = Array.from({ length: 140000 }, (_, i) => ({ id: 'L', side: 'long', pnl: i, entryIndex: i, exitIndex: i + 1 }));
  check('everything else counts against a total budget', throws(() => sanitizeResult({
    strategy: { trades: lots, equity: flat, drawdown: flat, buyHold: flat },
  }, { bars: n }), new RegExp(`too large \\(more than ${MAX_RESULT_VALUES.toLocaleString('en-US')} values\\)`)));

  const keys = Object.fromEntries(Array.from({ length: MAX_RESULT_VALUES + 1 }, (_, i) => [`k${i}`, 1]));
  check('...constants too', throws(() => sanitizeResult({ consts: keys }, { bars: 0 }), /too large/));

  // The common case is quick: a long backtest with thousands of trades.
  const bars = 20000;
  const report = {
    trades: Array.from({ length: 3000 }, (_, i) => ({ id: 'Long', side: 'long', qty: 1, comment: '', entryIndex: i, entryPrice: 100, exitIndex: i + 1,
      exitPrice: 101, reason: 'Close', pnl: 1, pnlPct: 1, commission: 0.1, runup: 2, runupPct: 2, drawdown: 1, drawdownPct: 1, bars: 1 })),
    markers: Array.from({ length: 6000 }, (_, i) => ({ i: Math.floor(i / 2), kind: i % 2 ? 'exit' : 'entry', side: 'long', id: 'Long', price: 100 })),
    openTrades: [], equity: new Float64Array(bars), drawdown: new Float64Array(bars), buyHold: new Float64Array(bars), summary: {},
  };
  const t1 = performance.now();
  for (let k = 0; k < 10; k++) sanitizeResult({ strategy: report, plots: [{ values: new Float64Array(bars) }] }, { bars });
  const per = (performance.now() - t1) / 10;
  check('3,000 trades are cleaned quickly', per < 20, `${per.toFixed(2)} ms per result`);
}

console.log('settings are coerced to their declared type');
{
  const num = { key: 'in0', def: 14, min: 1, max: 100 };
  check('numbers: finite and clamped, else the default', coerceParam(20, num) === 20 && coerceParam('30', num) === 30 && coerceParam(500, num) === 100
    && coerceParam(-5, num) === 1 && coerceParam(EVIL, num) === 14 && coerceParam(NaN, num) === 14 && coerceParam(undefined, num) === 14 && coerceParam([5], num) === 14);
  const bool = { key: 'b', def: true, type: 'bool' };
  check('bools: booleans only', coerceParam(false, bool) === false && coerceParam('false', bool) === true && coerceParam(0, bool) === true);
  const sel = { key: 's', def: 'EMA', type: 'select', options: ['EMA', 'SMA'] };
  check('selects: one of the options', coerceParam('SMA', sel) === 'SMA' && coerceParam(EVIL, sel) === 'EMA' && coerceParam(1, sel) === 'EMA');
  const text = { key: 't', def: 'hi', type: 'text' };
  check('text: strings with a length cap', coerceParam('x'.repeat(5000), text).length === 1000 && coerceParam(5, text) === 'hi');
  // The attack: an input saved as text on one run, declared as a number on the next.
  const p = coerceParams({ in0: EVIL, in9: 'left over', __proto__: { in1: 1 } }, [num, { ...bool, key: 'in1' }]);
  check('stored settings: each coerced, unknown ones dropped', p.in0 === 14 && p.in1 === true && !('in9' in p) && Object.keys(p).join() === 'in0,in1');
}

console.log('CSV export');
{
  check('fields are quoted, inner quotes doubled', csvCell('a"b') === '"a""b"' && csvCell('') === '""' && csvCell(null) === '""');
  check('formula-like text is kept as text', ['=1+1', '+1', '-2', '@SUM(A1)', '\tx', '\rx'].every((v) => csvCell(v) === `"'${v}"`));
  check('numbers stay numbers (negative ones too)', csvCell(-12.5) === '"-12.5"' && csvCell(3) === '"3"' && csvCell(NaN) === '""');
  const csv = tradesCsv([
    { id: '=HYPERLINK("http://evil.example","x")', side: 'long', entryIndex: 0, entryPrice: 10, reason: '@cmd', exitIndex: 1, exitPrice: 9,
      qty: 1, pnl: -1.123456, pnlPct: -10, runup: 0, drawdown: 1, bars: 1 },
    { id: '', side: null, entryIndex: NaN, entryPrice: NaN, reason: '', exitIndex: NaN, exitPrice: NaN, qty: NaN, pnl: NaN, pnlPct: NaN, runup: NaN, drawdown: NaN, bars: NaN },
  ], [1700000000, 1700003600]);
  const lines = csv.split('\n');
  check('trade list: header plus one line per trade', lines.length === 3 && lines[0].startsWith('"#","type","signal"'));
  check('trade list: script text can\'t become a formula', lines[1].includes('"\'=HYPERLINK(""http://evil.example"",""x"")"') && lines[1].includes('"\'@cmd"'), lines[1]);
  check('trade list: numbers and times as before', lines[1].includes('"-1.1235"') && lines[1].includes('"2023-11-14T22:13:20"'), lines[1]);
  check('trade list: a trade with missing fields doesn\'t break the export', lines[2].startsWith('"2","","",""'), lines[2]);
}

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('all passed');
