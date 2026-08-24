/**
 * sdftool — the shape cage: the box a part's shape actually fills.
 *
 * THE CAGE IS CHECKED AGAINST THE FIELD, not against the numbers that produced
 * it. A cage measured from `supportLocal` and asserted against `supportLocal`
 * proves nothing; what has to be true is that the surface `map()` renders lies
 * inside the box and touches it. So every check below marches the real
 * primitive.
 *
 * Two properties, for every kind:
 *
 *   CONTAINS — no point of the surface is outside the box. A cage that clips
 *   the shape is worse than none: it says a part ends where it does not.
 *
 *   TOUCHES — the box is not loose. Each of the six faces has the surface on
 *   it, or the cage is a claim about empty space and the handles that will hang
 *   off it in M2 would sit off the shape.
 *
 * Pure Node: shapewidget.js is geometry and imports no DOM.
 */
import { cage, EDGES } from '../../tools/sdftool/shapewidget.js';
import { KINDS, NEW_DIMS, STRIDE } from '../../tools/sdftool/state.js';
import { map, prepRot } from '../../src/js/core/sdf.js';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

/** A part row of `kind` at the origin, at its own default size. */
const rowOf = (kind, extra = {}) => {
  const r = [kind, extra.x ?? 0, extra.y ?? 0, extra.z ?? 0,
    extra.rx ?? 0, extra.ry ?? 0, extra.rz ?? 0,
    ...NEW_DIMS[kind & 31], extra.blend ?? 0, 0];
  return r;
};

check(`a cage is a box (${EDGES.length} edges)`, EDGES.length === 12);

for (let k = 0; k < KINDS.length; k++) {
  // Off the origin and turned, so nothing passes by accident on a part whose
  // frame happens to be the world's.
  const parts = rowOf(k, { x: 0.21, y: -0.13, z: 0.08, rx: 0.07, ry: 0.19, rz: -0.11 });
  const cg = cage(parts, 0);
  if (k === 13) {                                   // the plane is a half-space
    check('a plane has no cage', cg === null);
    continue;
  }
  if (!cg) { check(`${KINDS[k]}: has a cage`, false); continue; }

  const rot = prepRot(parts);
  // The part's own frame, from the cage itself: a local point in world.
  const at = l => [0, 1, 2].map(w => cg.c[w]
    + cg.axes[0][w] * l[0] + cg.axes[1][w] * l[1] + cg.axes[2][w] * l[2]);

  // --- contains ---------------------------------------------------------------
  // Walk a shell just outside the box. Every sample there must be outside the
  // shape, or the surface reaches past the cage.
  const pad = 0.004;
  let leak = 0;
  const N = 15;
  for (let f = 0; f < 6; f++) {
    const ax = f >> 1, sign = f & 1 ? 1 : -1;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const l = [0, 0, 0];
        l[ax] = sign > 0 ? cg.hi[ax] + pad : -cg.lo[ax] - pad;
        const u = (ax + 1) % 3, v = (ax + 2) % 3;
        l[u] = -cg.lo[u] + (cg.hi[u] + cg.lo[u]) * (i / (N - 1));
        l[v] = -cg.lo[v] + (cg.hi[v] + cg.lo[v]) * (j / (N - 1));
        const w = at(l);
        if (map(parts, w[0], w[1], w[2], rot) < 0) leak++;
      }
    }
  }
  check(`${KINDS[k]}: the shape stays inside its cage (${leak} leaks)`, leak === 0);

  // --- touches ----------------------------------------------------------------
  // The nearest the surface comes to each face. A face the shape never reaches
  // is a face a handle would hang off in empty space.
  let worstGap = 0, loosest = '';
  for (let f = 0; f < 6; f++) {
    const ax = f >> 1, sign = f & 1 ? 1 : -1;
    let best = Infinity;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const l = [0, 0, 0];
        l[ax] = sign > 0 ? cg.hi[ax] : -cg.lo[ax];
        const u = (ax + 1) % 3, v = (ax + 2) % 3;
        l[u] = -cg.lo[u] + (cg.hi[u] + cg.lo[u]) * (i / (N - 1));
        l[v] = -cg.lo[v] + (cg.hi[v] + cg.lo[v]) * (j / (N - 1));
        const w = at(l);
        best = Math.min(best, Math.abs(map(parts, w[0], w[1], w[2], rot)));
      }
    }
    if (best > worstGap) { worstGap = best; loosest = 'xyz'[ax] + (sign > 0 ? '+' : '-'); }
  }
  // A face's contact point can fall between grid samples, and a distance field
  // is 1-Lipschitz, so the slack is half a sample step.
  check(`${KINDS[k]}: every face touches the shape (worst ${loosest} ${worstGap.toFixed(3)})`,
    worstGap < 0.03);
}

// --- a paint part is bounded by its REACH -------------------------------------
// It has no surface at all: `shade` mixes its colour in for `blend` past where
// its shape would be, and that is the whole of what it does. A cage on the
// shape alone would be a box round nothing you can see.
const paint = rowOf(64, { blend: 0.2 });
const plain = rowOf(0, { blend: 0.2 });
check('a paint part\'s cage grows by its reach',
  cage(paint, 0).hi[0] > cage(plain, 0).hi[0] + 0.19);
check('and a part with a surface is bounded by the surface',
  Math.abs(cage(plain, 0).hi[0] - NEW_DIMS[0][3]) < 1e-9);

// --- asymmetry ------------------------------------------------------------------
// The pyramid grows from a base below its origin to an apex AT it, so a cage
// that measured one half-extent per axis would be wrong by the whole shape.
const pyr = cage(rowOf(10), 0);
check(`a pyramid's cage is asymmetric in y (${(-pyr.lo[1]).toFixed(2)}..${pyr.hi[1].toFixed(2)})`,
  Math.abs(pyr.hi[1] - pyr.lo[1]) > 0.05);

// --- it follows the part ---------------------------------------------------------
const moved = cage(rowOf(1, { x: 0.5 }), 0);
check('a cage sits on its part', Math.abs(moved.c[0] - 0.5) < 1e-9);
check('and its corners come with it',
  moved.corners.every(p => p[0] > 0.5 - 0.3 && p[0] < 0.5 + 0.3));

// A rotated box's cage is the box, turned — so its corners must NOT stay axis
// aligned in world.
const turned = cage(rowOf(1, { rz: 0.1 }), 0);
check('a turned part gets a turned cage',
  new Set(turned.corners.map(p => p[0].toFixed(4))).size > 2);

// --- degenerate rows --------------------------------------------------------
// A sphere scrubbed to zero radius has no extent at all. The box must not come
// out inside-out — a negative span would draw a cage folded through itself and
// put a face on the wrong side of the part.
const nothing = cage([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0);
check('a part with no extent still gets a box the right way out',
  [0, 1, 2].every(k => nothing.hi[k] + nothing.lo[k] > 0));

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
