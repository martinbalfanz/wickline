// Multi-chart layouts: which layouts exist and their geometry. A layout is a tree: a pane (null)
// or a split { dir, c } whose children sit side by side (dir 'h') or stacked (dir 'v'). Sizes
// hold one array per split, in depth-first order, with each child's share of that split, so every
// divider moves on its own. Positions are fractions (0..1) of the chart area.
// Pure (no DOM), unit-tested in test/layout.test.mjs.

const P = null;
const H = (...c) => ({ dir: 'h', c }); // side by side
const V = (...c) => ({ dir: 'v', c }); // stacked

/** The smallest a pane can be dragged to, in px. */
export const MIN_PANE = { w: 160, h: 100 };

const countPanes = (t) => (t ? t.c.reduce((s, x) => s + countPanes(x), 0) : 1);

// Panes are numbered depth-first, so the ids and chart order of older layouts stay the same.
export const LAYOUTS = [
  ['1', '1 chart', P],
  ['2v', '2 charts, side by side', H(P, P)],
  ['2h', '2 charts, stacked', V(P, P)],
  ['3v', '3 charts in columns', H(P, P, P)],
  ['3h', '3 charts in rows', V(P, P, P)],
  ['3', '3 charts: 1 big, 2 on the right', H(P, V(P, P))],
  ['3t', '3 charts: 1 big on top, 2 below', V(P, H(P, P))],
  ['4', '4 charts, 2 × 2', V(H(P, P), H(P, P))],
  ['4v', '4 charts in columns', H(P, P, P, P)],
  ['4l', '4 charts: 1 big, 3 on the right', H(P, V(P, P, P))],
  ['4t', '4 charts: 1 big on top, 3 below', V(P, H(P, P, P))],
  ['5', '5 charts: 2 on top, 3 below', V(H(P, P), H(P, P, P))],
  ['5l', '5 charts: 1 big, 4 on the right', H(P, V(H(P, P), H(P, P)))],
  ['5v', '5 charts in columns', H(P, P, P, P, P)],
  ['6', '6 charts, 3 × 2', V(H(P, P, P), H(P, P, P))],
  ['6h', '6 charts, 2 × 3', V(H(P, P), H(P, P), H(P, P))],
  ['7', '7 charts: 3 on top, 4 below', V(H(P, P, P), H(P, P, P, P))],
  ['7l', '7 charts: 1 big, 6 on the right', H(P, V(H(P, P), H(P, P), H(P, P)))],
  ['8', '8 charts, 4 × 2', V(H(P, P, P, P), H(P, P, P, P))],
  ['8h', '8 charts, 2 × 4', V(H(P, P), H(P, P), H(P, P), H(P, P))],
].map(([id, title, tree]) => ({ id, title, tree, n: countPanes(tree) }));

/** The layout with this id, or the single chart for an unknown one. */
export const layoutOf = (id) => LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];

/** A layout's shape as text, e.g. 'v(h(p,p),h(p,p))', so sizes saved for another shape are ignored. */
export const shapeOf = (t) => (t ? `${t.dir}(${t.c.map(shapeOf).join(',')})` : 'p');

function splitsOf(t, out = []) {
  if (t) { out.push(t); for (const x of t.c) splitsOf(x, out); }
  return out;
}

const equal = (n) => Array(n).fill(1 / n);

/** Every split divided equally. */
export const equalSizes = (layout) => splitsOf(layout.tree).map((s) => equal(s.c.length));

/**
 * Sizes saved with sizesEntry() if they still fit the layout, else equal ones (also for each
 * split whose saved shares are broken).
 */
export function validSizes(layout, saved) {
  const splits = splitsOf(layout.tree);
  const ok = !!saved && saved.shape === shapeOf(layout.tree) && Array.isArray(saved.sizes) && saved.sizes.length === splits.length;
  return splits.map((s, k) => {
    const a = ok ? saved.sizes[k] : null;
    if (!Array.isArray(a) || a.length !== s.c.length || !a.every((v) => Number.isFinite(v) && v > 0)) return equal(s.c.length);
    const sum = a.reduce((x, y) => x + y, 0);
    return a.map((v) => v / sum);
  });
}

/** What to save for a layout's sizes (read back with validSizes). */
export const sizesEntry = (layout, sizes) => ({
  shape: shapeOf(layout.tree),
  sizes: sizes.map((s) => s.map((v) => Math.round(v * 1e5) / 1e5)),
});

// Visits each split (with its index and rect) and each pane's rect. Neighbours share their
// edge exactly: both come from the same running sum.
function walk(layout, sizes, { pane, split }) {
  let k = 0;
  const go = (t, r) => {
    if (!t) { pane?.(r); return; }
    const idx = k++;
    const shares = sizes[idx];
    split?.(t, idx, r, shares);
    const h = t.dir === 'h';
    const from = h ? r.x : r.y, len = h ? r.w : r.h;
    let at = 0;
    t.c.forEach((c, i) => {
      const a = from + at * len;
      at += shares[i];
      const b = i === t.c.length - 1 ? from + len : from + at * len;
      go(c, h ? { x: a, y: r.y, w: b - a, h: r.h } : { x: r.x, y: a, w: r.w, h: b - a });
    });
  };
  go(layout.tree, { x: 0, y: 0, w: 1, h: 1 });
}

/** Each pane's { x, y, w, h }, in chart order. */
export function paneRects(layout, sizes) {
  const out = [];
  walk(layout, sizes, { pane: (r) => out.push(r) });
  return out;
}

/**
 * The dividers: { id: 'split.index', axis, x, y, w, h }. A divider is a line: axis 'x' ones are
 * vertical (dragged sideways, w = 0), axis 'y' ones horizontal (dragged up and down, h = 0).
 */
export function dividers(layout, sizes) {
  const out = [];
  walk(layout, sizes, {
    split: (t, k, r, shares) => {
      const h = t.dir === 'h';
      const from = h ? r.x : r.y, len = h ? r.w : r.h;
      let at = 0;
      for (let i = 0; i < shares.length - 1; i++) {
        at += shares[i];
        const p = from + at * len;
        out.push(h ? { id: `${k}.${i}`, axis: 'x', x: p, y: r.y, w: 0, h: r.h } : { id: `${k}.${i}`, axis: 'y', x: r.x, y: p, w: r.w, h: 0 });
      }
    },
  });
  return out;
}

// The least room a subtree needs along an axis, in px.
function minAlong(t, axis, min) {
  if (!t) return axis === 'x' ? min.w : min.h;
  const m = t.c.map((c) => minAlong(c, axis, min));
  return (t.dir === 'h') === (axis === 'x') ? m.reduce((a, b) => a + b, 0) : Math.max(...m);
}

/**
 * Sizes after dragging divider `id` to `pos` px (from the left or top of a chart area of
 * box = { w, h } px). Only the panes (or groups of panes) on either side change, and neither gets
 * smaller than its minimum; when there isn't room for both, they share it by their minimums.
 */
export function moveDivider(layout, sizes, id, pos, box, min = MIN_PANE) {
  const [k, i] = String(id).split('.').map(Number);
  let found = null;
  walk(layout, sizes, { split: (t, idx, r) => { if (idx === k) found = { t, r }; } });
  if (!found || !(i >= 0 && i < found.t.c.length - 1) || !Number.isFinite(pos)) return sizes;
  const { t, r } = found;
  const axis = t.dir === 'h' ? 'x' : 'y';
  const start = axis === 'x' ? r.x * box.w : r.y * box.h;
  const len = axis === 'x' ? r.w * box.w : r.h * box.h;
  if (!(len > 0)) return sizes;
  const shares = sizes[k];
  const before = shares.slice(0, i).reduce((a, b) => a + b, 0);
  const pair = shares[i] + shares[i + 1];
  const minA = minAlong(t.c[i], axis, min) / len, minB = minAlong(t.c[i + 1], axis, min) / len;
  const a = minA + minB >= pair
    ? pair * (minA / (minA + minB))
    : Math.min(pair - minB, Math.max(minA, (pos - start) / len - before));
  const next = sizes.map((s) => s.slice());
  next[k][i] = a;
  next[k][i + 1] = pair - a;
  return next;
}

/** Sizes with the split that divider `id` belongs to divided equally again. */
export function resetSplit(layout, sizes, id) {
  const k = Number(String(id).split('.')[0]);
  if (!Array.isArray(sizes[k])) return sizes;
  const next = sizes.map((s) => s.slice());
  next[k] = equal(next[k].length);
  return next;
}
