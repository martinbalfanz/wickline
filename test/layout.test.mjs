// Multi-chart layouts (public/js/layouts.js): panes fill the chart area, dividers drag within the
// minimum pane sizes, double-click resets to equal, saved sizes are checked. Run: node test/layout.test.mjs
import {
  LAYOUTS, MIN_PANE, layoutOf, shapeOf, equalSizes, validSizes, sizesEntry, paneRects, dividers, moveDivider, resetSplit,
} from '../public/js/layouts.js';

let failed = 0;
const check = (name, cond, detail = '') => {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
};

const EPS = 1e-9;
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;
const overlap = (a, b) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > EPS && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > EPS;
const inside = (r) => r.x >= -EPS && r.y >= -EPS && r.w > 0 && r.h > 0 && r.x + r.w <= 1 + EPS && r.y + r.h <= 1 + EPS;
/** Problems with a set of pane rects: outside the area, overlapping, or leaving gaps. */
function tilingErrors(rects) {
  const errs = [];
  rects.forEach((r, i) => { if (!inside(r)) errs.push(`pane ${i} outside ${JSON.stringify(r)}`); });
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) if (overlap(rects[i], rects[j])) errs.push(`panes ${i} and ${j} overlap`);
  const area = rects.reduce((s, r) => s + r.w * r.h, 0);
  if (!near(area, 1)) errs.push(`area ${area}`);
  return errs;
}
// A random (valid) set of sizes for a layout, the way dragging could leave them.
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const randomSizes = (l) => validSizes(l, { shape: shapeOf(l.tree), sizes: equalSizes(l).map((s) => s.map(() => 0.2 + rand())) });
const BOX = { w: 1400, h: 800 };
const px = (rects, box = BOX) => rects.map((r) => ({ w: r.w * box.w, h: r.h * box.h }));
let bad = [];

console.log('layouts');
{
  const ids = LAYOUTS.map((l) => l.id);
  check('layout ids are unique', new Set(ids).size === ids.length);
  check('every count from 1 to 8 charts has a layout', [1, 2, 3, 4, 5, 6, 7, 8].every((n) => LAYOUTS.some((l) => l.n === n)));
  check('no layout has more than 8 charts', LAYOUTS.every((l) => l.n >= 1 && l.n <= 8));
  check('several shapes for 2, 3, 4 and 8 charts', [2, 3, 4, 8].every((n) => LAYOUTS.filter((l) => l.n === n).length >= 2));
  check('the older layouts still exist (saved choices stay valid)', ['1', '2v', '2h', '3', '4', '6'].every((id) => layoutOf(id).id === id));
  check('...with the same number of charts', [['1', 1], ['2v', 2], ['2h', 2], ['3', 3], ['4', 4], ['6', 6]].every(([id, n]) => layoutOf(id).n === n));
  check('an unknown layout falls back to 1 chart', layoutOf('9x').id === '1' && layoutOf(undefined).id === '1' && layoutOf(null).id === '1');
  check('every layout has a title naming its chart count', LAYOUTS.every((l) => l.title.startsWith(`${l.n} chart`)));

  for (const l of LAYOUTS) {
    const rects = paneRects(l, equalSizes(l));
    const errs = tilingErrors(rects);
    check(`${l.id}: ${l.n} pane${l.n > 1 ? 's' : ''} fill${l.n > 1 ? '' : 's'} the area without overlapping`, rects.length === l.n && !errs.length, errs.slice(0, 3).join('; '));
  }
  bad = [];
  for (const l of LAYOUTS) for (let t = 0; t < 20; t++) {
    const rects = paneRects(l, randomSizes(l));
    const errs = tilingErrors(rects);
    if (rects.length !== l.n || errs.length) bad.push(`${l.id}: ${errs[0]}`);
  }
  check('...and still do with any sizes', !bad.length, bad.slice(0, 3).join('; '));

  // The older layouts keep their pane order: row by row, the big pane of '3' first.
  const r3 = paneRects(layoutOf('3'), equalSizes(layoutOf('3')));
  check("'3' is one tall pane on the left, two on the right", near(r3[0].h, 1) && near(r3[0].w, 0.5) && near(r3[1].x, 0.5) && near(r3[2].y, 0.5));
  const r6 = paneRects(layoutOf('6'), equalSizes(layoutOf('6')));
  check("'6' is 3 × 2, row by row", r6.every((r, i) => near(r.x, (i % 3) / 3) && near(r.y, Math.floor(i / 3) / 2)));
  const r8 = paneRects(layoutOf('8'), equalSizes(layoutOf('8')));
  check("'8' is 4 × 2 equal panes", r8.every((r, i) => near(r.x, (i % 4) / 4) && near(r.y, Math.floor(i / 4) / 2) && near(r.w, 0.25) && near(r.h, 0.5)));
}

console.log('dividers');
{
  bad = [];
  for (const l of LAYOUTS) {
    const sizes = randomSizes(l);
    const rects = paneRects(l, sizes);
    const list = dividers(l, sizes);
    // A layout of n panes has n - 1 dividers, each on an edge between panes.
    if (list.length !== l.n - 1) bad.push(`${l.id}: ${list.length} dividers`);
    for (const d of list) {
      const mid = d.axis === 'x' ? { x: d.x, y: d.y + d.h / 2 } : { x: d.x + d.w / 2, y: d.y };
      const before = rects.some((r) => (d.axis === 'x' ? near(r.x + r.w, mid.x) && r.y <= mid.y && r.y + r.h >= mid.y : near(r.y + r.h, mid.y) && r.x <= mid.x && r.x + r.w >= mid.x));
      const after = rects.some((r) => (d.axis === 'x' ? near(r.x, mid.x) && r.y <= mid.y && r.y + r.h >= mid.y : near(r.y, mid.y) && r.x <= mid.x && r.x + r.w >= mid.x));
      if (!before || !after || (d.axis === 'x' ? d.w !== 0 || !(d.h > 0) : d.h !== 0 || !(d.w > 0))) bad.push(`${l.id} ${d.id}`);
    }
  }
  check('n - 1 dividers per layout, each between two panes', !bad.length, bad.slice(0, 4).join('; '));
  check('no dividers for a single chart', dividers(layoutOf('1'), equalSizes(layoutOf('1'))).length === 0);
  const d2v = dividers(layoutOf('2v'), equalSizes(layoutOf('2v')));
  const d2h = dividers(layoutOf('2h'), equalSizes(layoutOf('2h')));
  check('side by side panes get a vertical divider, stacked ones a horizontal one', d2v[0].axis === 'x' && near(d2v[0].x, 0.5) && d2h[0].axis === 'y' && near(d2h[0].y, 0.5));
}

console.log('dragging');
{
  const l = layoutOf('2v');
  let s = moveDivider(l, equalSizes(l), '0.0', 420, BOX);
  check('dragging moves the divider to the pointer', near(s[0][0], 420 / 1400) && near(s[0][1], 1 - 420 / 1400));
  check('...without changing the input', near(equalSizes(l)[0][0], 0.5));
  s = moveDivider(l, equalSizes(l), '0.0', -500, BOX);
  check('dragging past the left edge stops at the minimum width', near(s[0][0] * BOX.w, MIN_PANE.w), `${s[0][0] * BOX.w}px`);
  s = moveDivider(l, equalSizes(l), '0.0', 5000, BOX);
  check('...and past the right edge too', near(s[0][1] * BOX.w, MIN_PANE.w), `${s[0][1] * BOX.w}px`);
  const v = layoutOf('2h');
  s = moveDivider(v, equalSizes(v), '0.0', 3, BOX);
  check('stacked panes stop at the minimum height', near(s[0][0] * BOX.h, MIN_PANE.h), `${s[0][0] * BOX.h}px`);

  // Only the two sides of the divider change.
  const c4 = layoutOf('4v');
  s = moveDivider(c4, equalSizes(c4), '0.1', 0.6 * BOX.w, BOX);
  check('only the panes beside the divider change', near(s[0][0], 0.25) && near(s[0][3], 0.25) && near(s[0][1], 0.35) && near(s[0][2], 0.15));
  const g = layoutOf('4');
  s = moveDivider(g, equalSizes(g), '1.0', 300, BOX);
  check('in a grid, a row divider moves that row only', near(s[1][0], 300 / 1400) && near(s[2][0], 0.5) && near(s[0][0], 0.5));
  check('a divider inside a nested split is measured from that split', (() => {
    const b = layoutOf('5l'); // 1 big pane, then 2 × 2 on the right half
    const t = moveDivider(b, equalSizes(b), '2.0', 0.5 * BOX.w + 200, BOX); // first row of the right half
    return near(t[2][0], 200 / 700);
  })());

  // A group of panes needs room for all of them: the big pane's divider in '5l' stops where the
  // two columns on the right are both at their minimum.
  const b = layoutOf('5l');
  s = moveDivider(b, equalSizes(b), '0.0', 5000, BOX);
  check('a group of panes stops at the sum of its minimums', near(s[0][1] * BOX.w, 2 * MIN_PANE.w), `${s[0][1] * BOX.w}px`);

  // Every divider of every layout, dragged to either end, keeps every pane at least the minimum
  // (from equal sizes, which all fit this box) and the panes still tile the area (from any sizes).
  bad = [];
  for (const lay of LAYOUTS) {
    for (const d of dividers(lay, equalSizes(lay))) {
      for (const pos of [-1e5, 1e5]) {
        const moved = px(paneRects(lay, moveDivider(lay, equalSizes(lay), d.id, pos, BOX)));
        const small = moved.findIndex((r) => r.w < MIN_PANE.w - 1e-6 || r.h < MIN_PANE.h - 1e-6);
        if (small >= 0) bad.push(`${lay.id} ${d.id} -> pane ${small} ${Math.round(moved[small].w)}×${Math.round(moved[small].h)}`);
        if (tilingErrors(paneRects(lay, moveDivider(lay, randomSizes(lay), d.id, pos, BOX))).length) bad.push(`${lay.id} ${d.id} broke the tiling`);
      }
    }
  }
  check('every divider clamps so every pane keeps its minimum size', !bad.length, bad.slice(0, 4).join('; '));

  const tiny = { w: 200, h: 120 };
  s = moveDivider(c4, equalSizes(c4), '0.0', 50, tiny);
  check('a chart area too small for the minimums still gives valid sizes', s[0].every((x) => Number.isFinite(x) && x > 0) && near(s[0].reduce((a, x) => a + x, 0), 1));
  check('bad input leaves sizes as they were', [moveDivider(l, equalSizes(l), '5.0', 100, BOX), moveDivider(l, equalSizes(l), '0.1', 100, BOX),
    moveDivider(l, equalSizes(l), '0.0', NaN, BOX), moveDivider(l, equalSizes(l), 'x', 100, BOX)].every((t) => near(t[0][0], 0.5)));
}

console.log('reset');
{
  for (const id of ['4', '8', '7l']) {
    const l = layoutOf(id);
    check(`${id}: equal sizes are equal`, equalSizes(l).every((s) => s.every((v) => near(v, 1 / s.length))));
  }
  const l = layoutOf('8');
  let s = moveDivider(l, equalSizes(l), '1.0', 200, BOX);
  s = moveDivider(l, s, '1.2', 1300, BOX);
  s = moveDivider(l, s, '0.0', 600, BOX);
  const r = resetSplit(l, s, '1.1');
  check('double-click resets that split to equal', r[1].every((v) => near(v, 0.25)));
  check('...and leaves the other splits alone', near(r[0][0], 600 / 800) && r[2].every((v) => near(v, 0.25)));
  check('...without changing the input', !near(s[1][0], 0.25));
  check('resetting an unknown divider changes nothing', resetSplit(l, s, '9.0') === s);
  const rr = paneRects(l, resetSplit(l, resetSplit(l, s, '0.0'), '1.0'));
  check('after resetting both, the 8 panes are equal again', rr.every((x) => near(x.w, 0.25) && near(x.h, 0.5)));
}

console.log('saved sizes');
{
  const l = layoutOf('5');
  const sizes = moveDivider(l, moveDivider(l, equalSizes(l), '0.0', 300, BOX), '2.1', 1000, BOX);
  const back = validSizes(l, JSON.parse(JSON.stringify(sizesEntry(l, sizes))));
  check('saved sizes come back', back.every((s, k) => s.every((v, i) => near(v, sizes[k][i], 1e-4))));
  check('...summing to 1 in every split', back.every((s) => near(s.reduce((a, b) => a + b, 0), 1)));
  const eq = (x) => JSON.stringify(x) === JSON.stringify(equalSizes(l));
  check('nothing saved: equal sizes', eq(validSizes(l, undefined)) && eq(validSizes(l, null)));
  check('junk saved: equal sizes', [42, 'abc', [], {}, { sizes: 'x' }, { shape: shapeOf(l.tree) }, { shape: shapeOf(l.tree), sizes: [1, 2] }].every((x) => eq(validSizes(l, x))));
  check('sizes saved for another shape: equal sizes', eq(validSizes(l, sizesEntry(layoutOf('6'), equalSizes(layoutOf('6'))))) && eq(validSizes(l, { shape: 'v(p,p)', sizes: [[0.2, 0.8]] })));
  check('sizes saved without a shape (older format): equal sizes', eq(validSizes(l, [[0.3, 0.7], [0.5, 0.5], [0.2, 0.3, 0.5]])));
  const broken = sizesEntry(l, sizes);
  broken.sizes[2] = [0.5, -1, NaN];
  const fixed = validSizes(l, broken);
  check('a broken split falls back to equal, the others keep theirs', fixed[2].every((v) => near(v, 1 / 3)) && near(fixed[0][0], sizes[0][0], 1e-4));
  check('an unknown layout id falls back to 1 chart with no splits', validSizes(layoutOf('12'), { shape: 'h(p,p)', sizes: [[0.3, 0.7]] }).length === 0);
  check('shares that do not sum to 1 are scaled', (() => {
    const t = validSizes(layoutOf('2v'), { shape: shapeOf(layoutOf('2v').tree), sizes: [[1, 3]] });
    return near(t[0][0], 0.25) && near(t[0][1], 0.75);
  })());
}

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log('all passed');
