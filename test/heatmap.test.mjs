// Tests for the stock heatmap's layout and colours (public/js/heatmap.js).
import assert from 'node:assert/strict';
import { squarify, heatColor, groupBySector, layoutMap, tileCode, tileName } from '../public/js/heatmap.js';

let failed = 0;
const test = (name, fn) => {
  try { fn(); console.log(`  ok   ${name}`); } catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message}`); }
};
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1e-6 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1e-6;

test('squarify: areas match the values and tiles fill the box without overlapping', () => {
  const values = [500, 300, 120, 80, 60, 40, 30, 20, 10, 5];
  const W = 800, H = 500;
  const r = squarify(values, 10, 20, W, H);
  const total = values.reduce((s, v) => s + v, 0);
  values.forEach((v, i) => near(r[i].w * r[i].h, (v / total) * W * H, 1e-6 * W * H));
  near(r.reduce((s, t) => s + t.w * t.h, 0), W * H, 1e-3);
  for (const t of r) {
    assert.ok(t.x >= 10 - 1e-6 && t.y >= 20 - 1e-6 && t.x + t.w <= 10 + W + 1e-6 && t.y + t.h <= 20 + H + 1e-6, 'inside the box');
  }
  for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) assert.ok(!overlap(r[i], r[j]), `tiles ${i} and ${j} overlap`);
});

test('squarify: tiles stay close to square', () => {
  const values = Array.from({ length: 50 }, (_, i) => 1000 / (i + 1));
  const r = squarify(values, 0, 0, 1000, 600);
  const ratios = r.map((t) => Math.max(t.w / t.h, t.h / t.w));
  const median = ratios.sort((a, b) => a - b)[25];
  assert.ok(median < 3, `median aspect ratio ${median}`);
});

test('squarify: empty, zero and tiny boxes', () => {
  assert.deepEqual(squarify([], 0, 0, 100, 100), []);
  assert.deepEqual(squarify([0, 0], 0, 0, 100, 100).map((t) => t.w), [0, 0]);
  assert.deepEqual(squarify([5], 0, 0, 0, 100)[0].w, 0);
  const one = squarify([7], 3, 4, 50, 30)[0];
  assert.deepEqual([one.x, one.y, one.w, one.h], [3, 4, 50, 30]);
});

test('heatColor: red for falls, grey for flat, green for rises, capped at the scale', () => {
  assert.equal(heatColor(0, 3), 'rgb(65, 69, 84)');
  assert.equal(heatColor(-3, 3), 'rgb(246, 53, 56)');
  assert.equal(heatColor(3, 3), 'rgb(48, 204, 90)');
  assert.equal(heatColor(-50, 3), heatColor(-3, 3));
  assert.equal(heatColor(null, 3), 'rgb(46, 48, 56)');
  const g = (s) => Number(/rgb\(\d+, (\d+)/.exec(s)[1]);
  assert.ok(g(heatColor(2, 3)) > g(heatColor(1, 3)), 'a bigger rise is greener');
});

test('groupBySector and layoutMap: largest stocks, grouped, labelled', () => {
  const rows = [
    { s: 'AAPL', sec: 'Technology', m: 3e12, c: 1 }, { s: 'MSFT', sec: 'Technology', m: 2.8e12, c: -1 },
    { s: 'JPM', sec: 'Finance', m: 6e11, c: 0.5 }, { s: 'XOM', sec: 'Energy', m: 4e11, c: -2 },
    { s: 'TINY', sec: 'Energy', m: 1e8, c: 9 }, { s: 'NOCAP', sec: 'Finance', m: null, c: 1 },
  ];
  const groups = groupBySector(rows, { top: 4 });
  assert.deepEqual(groups.map((g) => g.name), ['Technology', 'Finance', 'Energy']);
  assert.deepEqual(groups.flatMap((g) => g.rows.map((r) => r.s)), ['AAPL', 'MSFT', 'JPM', 'XOM']);
  assert.deepEqual(groupBySector(rows, { top: 10, sector: 'Energy' }).map((g) => g.rows.length), [2]);
  const { tiles, labels } = layoutMap(groups, 900, 500);
  assert.equal(tiles.length, 4);
  assert.ok(labels.some((l) => l.name === 'Technology'));
  // Stocks sit below their sector's name.
  const tech = labels.find((l) => l.name === 'Technology');
  const aapl = tiles.find((t) => t.r.s === 'AAPL');
  assert.ok(aapl.y >= tech.y + 16 - 1e-6);
});

test('tiles show the code local traders use', () => {
  assert.equal(tileCode('601398.SS', 'CN'), '601398');
  assert.equal(tileCode('300750.SZ', 'CN'), '300750');
  assert.equal(tileCode('7203.T', 'JP'), '7203');
  assert.equal(tileCode('0700.HK', 'HK'), '00700');
  assert.equal(tileCode('005930.KS', 'KR'), '005930');
  assert.equal(tileCode('6488.TWO', 'TW'), '6488');
  assert.equal(tileCode('RELIANCE.NS', 'IN'), 'RELIANCE');
  assert.equal(tileCode('INVE-B.ST', 'SE'), 'INVE B');
  assert.equal(tileCode('BBD-B.TO', 'CA'), 'BBD.B');
  assert.equal(tileCode('BT-A.L', 'GB'), 'BT.A');
  assert.equal(tileCode('PETR4.SA', 'BR'), 'PETR4');
  assert.equal(tileCode('BRK-B', 'us'), 'BRK-B');
  assert.equal(tileCode('BTC', 'crypto'), 'BTC');
});

test('tile names drop legal forms', () => {
  assert.equal(tileName('Toyota Motor Corporation'), 'Toyota Motor');
  assert.equal(tileName('HSBC Holdings plc'), 'HSBC');
  assert.equal(tileName('Kweichow Moutai Co., Ltd.'), 'Kweichow Moutai');
  assert.equal(tileName('Samsung Biologics Co.,Ltd.'), 'Samsung Biologics');
  assert.equal(tileName('Investor AB (publ)'), 'Investor');
  assert.equal(tileName('Aena S.M.E., S.A.'), 'Aena');
  assert.equal(tileName('Hermès International Société en commandite par actions'), 'Hermès International');
  assert.equal(tileName('The Toronto-Dominion Bank'), 'Toronto-Dominion Bank');
  assert.equal(tileName('Industrial and Commercial Bank of China Limited'), 'Industrial and Commercial Bank of China');
  assert.equal(tileName('Sanofi'), 'Sanofi');
  assert.equal(tileName('Mitsui & Co., Ltd.'), 'Mitsui');
  assert.equal(tileName('Group'), 'Group');
  assert.equal(tileName('Taiwan Semiconductor Manufactur', { cut: true }), 'Taiwan Semiconductor');
  assert.equal(tileName('Space Exploration Technologies ', { cut: true }), 'Space Exploration Technologies');
  assert.equal(tileName(undefined), '');
});

console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exitCode = failed ? 1 : 0;
