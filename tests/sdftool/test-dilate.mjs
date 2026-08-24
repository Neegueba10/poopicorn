/**
 * sdftool — the `round` handle, the one widget that serves eight primitives.
 *
 * `round` is a DILATION: every primitive that has one returns `core(p) − round`,
 * so the shape is a core swept by a ball of that radius. The handle is placed
 * and driven entirely out of `supportLocal`, with no per-kind constants, and
 * this suite exists to prove that derivation against the FIELD rather than
 * against the function it came from.
 *
 * Two properties, and both are about the handle staying honest:
 *
 *   ON THE SURFACE — the anchor is the shape's support point along a direction,
 *   computed as the gradient of the support function's 1-homogeneous extension.
 *   `map()` at that point must be zero. If it is not, the handle floats off the
 *   fillet it claims to edit — which is what happens if you differentiate the
 *   support function as written, where `+ round` reads as a constant and the
 *   gradient loses it.
 *
 *   THE GAIN IS REAL — one unit of drag along the direction must move the
 *   surface one unit. The octahedron is the case that catches a wrong answer:
 *   its `round` rounds the PLANE distance, so its vertices sit at `a + round·√3`
 *   and its gain is √3, not 1.
 *
 * Pure Node.
 */
import { handles, cage, toWorld } from '../../tools/sdftool/shapewidget.js';
import { KINDS, NEW_DIMS, FIELDS, SCALE_COLS, STRIDE } from '../../tools/sdftool/state.js';
import { map, prepRot } from '../../src/js/core/sdf.js';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

/** A projection stand-in: the handle geometry under test is the WORLD anchor,
 * and screen placement is the camera's business, checked in the browser suite.
 * An axonometric drop keeps every direction non-degenerate. */
const proj = (x, y, z) => [100 * (x - z * 0.5), 100 * (-y - z * 0.25)];

const rowOf = (kind, extra = {}) => [
  kind, extra.x ?? 0, extra.y ?? 0, extra.z ?? 0,
  extra.rx ?? 0, extra.ry ?? 0, extra.rz ?? 0,
  ...(extra.dims ?? NEW_DIMS[kind & 31]), extra.blend ?? 0, 0,
];

/** The kinds whose `round` no scale arm reaches — the ones this handle is for. */
const WANT = [];
for (let k = 0; k < KINDS.length; k++) {
  if (k === 13) continue;                       // the plane's round is an offset
  if (!FIELDS[k].round) continue;
  if (SCALE_COLS[k].includes(10)) continue;     // an arm already writes it
  WANT.push(k);
}
check(`eight kinds need a round handle (${WANT.map(k => KINDS[k]).join(', ')})`,
  WANT.length === 8);

for (const k of WANT) {
  // Turned and off the origin, so nothing passes because a frame happened to be
  // the world's.
  const parts = rowOf(k, { x: 0.17, y: -0.11, z: 0.06, rx: 0.05, ry: 0.14, rz: -0.09 });
  // Only the dilate handle: shape mode may also offer face handles on this
  // kind, and they are a different suite's business.
  const hs = handles(parts, 0, proj).filter(h => h.type === 'dilate');
  check(`${KINDS[k]}: offers a round handle`, hs.length === 1 && hs[0].col === 10);
  if (!hs.length) continue;

  // --- the anchor is on the surface -------------------------------------------
  // Recomputed here from the same local point the widget drew, through the
  // cage's own frame — so this checks the number the handle uses, not a
  // re-derivation of it.
  const cg = cage(parts, 0);
  const rot = prepRot(parts);
  // Undo the projection to recover the world anchor: the widget hands back
  // pixels, so ask it again for the local point by matching what it drew.
  // Simpler and stricter — walk the direction out from the centre until `map`
  // crosses zero, and check the handle is that far out.
  const w = anchorOf(parts, 0);
  const d = map(parts, w[0], w[1], w[2], rot);
  check(`${KINDS[k]}: the handle sits on the surface (map ${d.toFixed(5)})`,
    Math.abs(d) < 2e-3);

  // --- the gain is real --------------------------------------------------------
  // How far the surface ACTUALLY moves along the handle's direction per unit of
  // `round` — found here with this file's own root finder, not the widget's, so
  // this is a check and not an echo. A drag divides by the gain; get it wrong
  // and the handle slides out from under the pointer.
  const STEP = 0.03;
  const t0 = crossing(k, parts, hs[0], 0);
  const t1 = crossing(k, parts, hs[0], STEP);
  const rate = (t1 - t0) / STEP;
  check(`${KINDS[k]}: the surface moves ${rate.toFixed(3)}x per unit of round`
    + ` (gain ${hs[0].gain.toFixed(3)})`,
    Math.abs(rate - hs[0].gain) < 0.02);

  // And the anchor is still on the surface once the number has changed, which
  // is the on-surface claim made again after a drag rather than before one.
  const grown = [...parts];
  grown[10] += STEP;
  const w2 = anchorOf(grown, 0);
  check(`${KINDS[k]}: and stays on the surface as it grows`,
    Math.abs(map(grown, w2[0], w2[1], w2[2], prepRot(grown))) < 2e-3);
}

/**
 * Where the part's surface is along a handle's direction, measured from the
 * part's own origin — this file's own root finder, deliberately not the
 * widget's, so the gain check above compares two independent answers.
 *
 * A scan rather than a bisection: it makes no assumption about brackets, which
 * is the one thing the widget's marcher does assume.
 */
function crossing(kind, parts, h, extra) {
  const a = parts[7], b = parts[8], c = parts[9], r = parts[10] + extra;
  const m = [kind, 0, 0, 0, 0, 0, 0, a, b, c, r, 0, 0];
  const base = h.lpos, d = h.ldir;
  const at = t => map(m, base[0] + d[0] * t, base[1] + d[1] * t,
    base[2] + d[2] * t, null);
  // The anchor is within a `round` or so of the answer at any step this suite
  // takes; sweep a window that comfortably covers it.
  const LO = -0.5, HI = 0.5, N = 20000;
  let prev = at(LO);
  for (let i = 1; i <= N; i++) {
    const t = LO + (HI - LO) * (i / N);
    const v = at(t);
    if (prev <= 0 && v > 0) {
      // Linear between the straddling samples: a distance field is smooth here.
      const t0 = LO + (HI - LO) * ((i - 1) / N);
      return t0 + (t - t0) * (-prev / (v - prev));
    }
    prev = v;
  }
  return NaN;
}

/**
 * The world anchor the widget places its handle at.
 *
 * The widget returns pixels, so this re-runs its placement through a projection
 * that is trivially invertible — two axis-aligned probes recover the point.
 */
function anchorOf(parts, row) {
  // A projection that just reports the world point, one component per call.
  const pick = c => handles(parts, row, (x, y, z) => [[x, y, z][c], 0])
    .find(h => h.type === 'dilate').x;
  return [pick(0), pick(1), pick(2)];
}

// --- the octahedron is the case a constant would get wrong ---------------------
// Its `round` rounds the PLANE distance, so a vertex sits at `a + round·√3`.
const dilateOf = parts => handles(parts, 0, proj).find(h => h.type === 'dilate');
const octa = dilateOf(rowOf(6));
check(`an octahedron's gain is √3 (${octa.gain.toFixed(4)})`,
  Math.abs(octa.gain - Math.sqrt(3)) < 1e-3);
const boxH = dilateOf(rowOf(1));
check(`a box's gain is 1 (${boxH.gain.toFixed(4)})`, Math.abs(boxH.gain - 1) < 1e-3);

// --- a box whose half-extents all differ --------------------------------------
// The corner of the CORE is (a, b, c) and the rounded corner is that plus
// `round` along the diagonal. Anchoring on the supporting plane instead would
// put the handle at the mean of the three, which is right only for a cube — so
// this is the case that catches it.
const oblong = rowOf(1, { dims: [0.3, 0.12, 0.2, 0.06] });
const w = anchorOf(oblong, 0);
const s = 0.06 / Math.sqrt(3);
check(`an oblong box's handle is on its own corner (${w.map(v => v.toFixed(3))})`,
  Math.abs(w[0] - (0.3 + s)) < 1e-3 && Math.abs(w[1] - (0.12 + s)) < 1e-3
  && Math.abs(w[2] - (0.2 + s)) < 1e-3);

// --- the capsule's perpendicular ------------------------------------------------
// Its `round` is a radius, so the handle must stand out SIDEWAYS from the axis.
// Along the axis it would read as "lengthen", which is a different number.
for (const axis of [[0.2, 0, 0], [0, 0.2, 0], [0, 0, 0.2], [0.1, 0.14, -0.08]]) {
  const cap = rowOf(2, { dims: [...axis, 0.06] });
  const p = anchorOf(cap, 0);
  const dotAxis = (p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2])
    / Math.hypot(...axis);
  check(`a capsule along ${axis}: its handle stands off the axis`,
    Math.abs(dotAxis) < 1e-6 && Math.hypot(...p) > 0.05);
}
// A capsule with no axis at all is a sphere, and has no perpendicular to find.
// It must not produce a NaN anchor.
const degenerate = anchorOf(rowOf(2, { dims: [0, 0, 0, 0.1] }), 0);
check('a capsule with no axis still gets a real anchor',
  degenerate.every(Number.isFinite));

// --- nothing else grows a handle -------------------------------------------------
for (let k = 0; k < KINDS.length; k++) {
  if (WANT.includes(k)) continue;
  check(`${KINDS[k]}: no round handle, its dial is reached elsewhere`,
    !dilateOf(rowOf(k)));
}

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
