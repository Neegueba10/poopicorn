// Align, distribute and repeat, over the whole selection: stamps, collision
// boxes and objects together.
//
// Every item is measured by its own WORLD rect, at its own parallax rate.
// Aligning a mixed-rate group is therefore aligning world coordinates, not
// screen positions — which is the only definition that survives a camera
// move. Align within a plane; the planes panel is how you get there.
import { state, srcDims, stampBounds, selStampIxs, selAabbIxs, selObjIxs } from './state.js';

/** The selection as a uniform list of movable rects. */
export function selItems() {
  const items = [];
  for (const i of selStampIxs()) {
    const s = state.stamps[i];
    items.push({
      rect: () => stampBounds(s),
      move: (dx, dy) => { s.x += dx; s.y += dy; },
    });
  }
  for (const i of selAabbIxs()) {
    const a = state.aabbs[i];
    items.push({
      rect: () => [a.x0, a.y0, a.x1, a.y1],
      move: (dx, dy) => { a.x0 += dx; a.x1 += dx; a.y0 += dy; a.y1 += dy; },
    });
  }
  for (const i of selObjIxs()) {
    const o = state.objects[i];
    items.push({
      rect: () => {
        const [w, h] = srcDims(o.k, o.i);
        return [o.x, o.y, o.x + w, o.y + h];
      },
      move: (dx, dy) => { o.x += dx; o.y += dy; },
    });
  }
  return items;
}

const EDGES = {
  left: (r, b) => [b[0] - r[0], 0],
  right: (r, b) => [b[2] - r[2], 0],
  top: (r, b) => [0, b[1] - r[1]],
  bottom: (r, b) => [0, b[3] - r[3]],
  hcenter: (r, b) => [(b[0] + b[2]) / 2 - (r[0] + r[2]) / 2, 0],
  vcenter: (r, b) => [0, (b[1] + b[3]) / 2 - (r[1] + r[3]) / 2],
};

/** Align every selected item to the group's own bounding box edge. */
export function alignSelection(edge) {
  const items = selItems();
  if (items.length < 2) return 0;
  const rects = items.map(it => it.rect());
  const box = [
    Math.min(...rects.map(r => r[0])), Math.min(...rects.map(r => r[1])),
    Math.max(...rects.map(r => r[2])), Math.max(...rects.map(r => r[3])),
  ];
  items.forEach((it, i) => {
    const [dx, dy] = EDGES[edge](rects[i], box);
    it.move(Math.round(dx), Math.round(dy));
  });
  return items.length;
}

/**
 * Even gaps along `axis` ('x' or 'y'): the two extreme items stay put and
 * everything between them is spread so the SPACE between neighbours is
 * equal. Equal gaps, not equal centres — items are different sizes here.
 */
export function distributeSelection(axis) {
  const items = selItems();
  if (items.length < 3) return 0;
  const lo = axis === 'x' ? 0 : 1, hi = lo + 2;
  const sorted = items.map(it => ({ it, r: it.rect() })).sort((a, b) => a.r[lo] - b.r[lo]);
  const first = sorted[0].r, last = sorted[sorted.length - 1].r;
  const span = last[hi] - first[lo];
  const used = sorted.reduce((n, s) => n + (s.r[hi] - s.r[lo]), 0);
  const gap = (span - used) / (sorted.length - 1);
  let cursor = first[lo];
  for (const s of sorted) {
    const d = Math.round(cursor - s.r[lo]);
    s.it.move(axis === 'x' ? d : 0, axis === 'x' ? 0 : d);
    cursor += (s.r[hi] - s.r[lo]) + gap;
  }
  return sorted.length;
}

/** The selection's own bounding box, for the repeat dialog's default step. */
export function selSpan() {
  const rects = selItems().map(it => it.rect());
  if (!rects.length) return [0, 0];
  return [
    Math.max(...rects.map(r => r[2])) - Math.min(...rects.map(r => r[0])),
    Math.max(...rects.map(r => r[3])) - Math.min(...rects.map(r => r[1])),
  ];
}
