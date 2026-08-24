/**
 * sdftool — baking a mirrored part into two real ones.
 *
 * THE ONE ASSERTION THAT MATTERS: the field before the bake and the field after
 * it are the same field. A mirror is a fold in the sample and a baked pair is
 * two rows of numbers, so "did the derivation get the rotation right" is not a
 * question about the editor — it is `map()` at a few thousand points, and only
 * the renderer can answer it.
 *
 * The rotation is the part that can silently be wrong. `x → |x|` happens BEFORE
 * the part's matrix, so the copy's rotation is `M·A·M`, which in this file's
 * Euler order means rx is kept and ry and rz are negated. Get that backwards
 * and a symmetric model still looks symmetric from the front — which is why
 * this samples in 3D rather than looking at a picture.
 *
 * TWO LIMITS ARE UNDER TEST TOO, both found by this suite rather than reasoned
 * about in advance:
 *
 *   THE FOLD CLIPS. Each half of a mirrored part stops at x = 0. Two real rows
 *   do not, so a part straddling the plane bakes into MORE material than it
 *   had. A plane is infinite and always straddles, so it is refused outright;
 *   anything else warns in the inspector (`mirrorCrosses`).
 *
 *   A SMOOTH UNION IS NOT ASSOCIATIVE. One `smin` against the folded part and
 *   two `smin`s against the pair differ by a little wherever the two halves are
 *   both within `blend` of a point — a seam a few thousandths wide down x = 0.
 *   That is inherent to smooth blending, not a bad derivation, so the cases
 *   below carry the tolerance their blend earns.
 *
 * Pure Node: state.js is the editor's document model and has no DOM in it.
 */
import {
  state, bakeMirror, mirrorCrosses, isMirror, count, STRIDE, KINDS,
} from '../../tools/sdftool/state.js';
import { map, bound, prepRot } from '../../src/js/core/sdf.js';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

/** Every `map` sample over a grid covering the model, as one flat array. */
function field(parts) {
  const r = bound(parts) || 1;
  const rot = prepRot(parts);
  const out = [];
  const N = 13, step = (2 * r) / (N - 1);
  for (let iz = 0; iz < N; iz++)
    for (let iy = 0; iy < N; iy++)
      for (let ix = 0; ix < N; ix++)
        out.push(map(parts, -r + ix * step, -r + iy * step, -r + iz * step, rot));
  return out;
}

/** A body for every case to blend or cut against, so the sampled field is a
 * shape and not one primitive alone in space. */
const BODY = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.42, 0, 0];

// [kind, x, y, z, rx, ry, rz, a, b, c, round, blend, mat], and the worst
// difference that row's blend can honestly produce at the seam.
const CASES = [
  // A box off to one side, turned on all three axes. The general case, and a
  // hard join — so it must come back EXACT.
  { tol: 1e-12, row: [1 + 128, 0.34, 0.12, -0.08, 0.07, 0.19, -0.13, 0.16, 0.1, 0.22, 0.02, 0, 0] },
  // A capsule with a real x in its axis — the one primitive that is NOT
  // symmetric under a local x flip, so its `a` has to be negated too. These are
  // the numbers models/creature.js uses for an arm, blend and all. The
  // tolerance is the blend seam: `smin(smin(body, left), right)` is not
  // `smin(body, folded)` where both halves reach the same point.
  { tol: 1e-3, row: [2 + 128, 0.38, 0.02, 0, 0, 0, 0, 0.14, -0.22, 0, 0.11, 0.12, 0] },
  // The same, turned, so the negated axis and the negated angles have to be
  // right at the same time.
  { tol: 1e-12, row: [2 + 128, 0.3, 0.1, 0.05, 0.11, -0.23, 0.08, 0.18, -0.14, 0.06, 0.09, 0, 0] },
  // A cylinder rotated about x only — ry and rz stay 0, so this catches a bake
  // that negates rx by mistake.
  { tol: 1e-12, row: [4 + 128, 0.25, 0, 0, 0.2, 0, 0, 0.12, 0.3, 0, 0, 0.05, 0] },
  // A torus, which reads a and round and nothing else.
  { tol: 1e-12, row: [3 + 128, 0.4, 0.05, 0.1, 0.13, 0.21, 0.3, 0.2, 0, 0, 0.06, 0.08, 0] },
  // A subtracted part: the bake has to keep the flag, and two cuts must remove
  // what one folded cut removed.
  { tol: 1e-12, row: [1 + 32 + 128, 0.36, 0.1, 0, 0, 0.15, 0.05, 0.1, 0.1, 0.1, 0, 0, 0] },
];

for (const { row, tol } of CASES) {
  state.parts = [...BODY, ...row];
  const name = `${KINDS[row[0] & 31]} at rx ${row[4]} ry ${row[5]} rz ${row[6]}`;
  check(`${name}: sits clear of the plane`, !mirrorCrosses(1));
  const before = field(state.parts);
  check(`${name}: bakes`, bakeMirror(1));
  check(`${name}: leaves three rows`, count() === 3);
  check(`${name}: neither row is mirrored any more`, !isMirror(1) && !isMirror(2));
  check(`${name}: the flags carry`, (state.parts[STRIDE] & ~128) === (row[0] & ~128)
    && (state.parts[2 * STRIDE] & ~128) === (row[0] & ~128));

  const after = field(state.parts);
  let worst = 0;
  for (let i = 0; i < before.length; i++)
    worst = Math.max(worst, Math.abs(before[i] - after[i]));
  check(`${name}: the field is unchanged (worst ${worst.toExponential(1)})`, worst < tol);
}

// --- the clip, which is what bounds the whole feature -------------------------
// A part straddling x = 0 is folded into a chevron and each half stops at the
// plane. Two real rows do not stop, so the bake hands the clipped halves back.
//
// A LONG BOX ACROSS THE PLANE IS NOT A TEST. It is its own mirror image, so
// the halves the fold clipped are exactly the halves the copy puts back and
// the field comes out identical. The shape has to be asymmetric about its own
// centre in x for the clip to show — hence a box on a slight turn.
state.parts = [...BODY, 1 + 128, 0.05, 0, 0, 0, 0, 0.08, 0.5, 0.1, 0.1, 0, 0, 0];
check('a part reaching over the plane is flagged', mirrorCrosses(1));
const crossBefore = field(state.parts);
bakeMirror(1);
const crossAfter = field(state.parts);
let crossWorst = 0;
for (let i = 0; i < crossBefore.length; i++)
  crossWorst = Math.max(crossWorst, Math.abs(crossBefore[i] - crossAfter[i]));
check(`and baking it really does change the shape (${crossWorst.toFixed(3)})`,
  crossWorst > 0.01);

// The warning must NOT fire on the case the feature exists for. The creature's
// arm sits 0.13 clear of the plane; an earlier extent-based test called it a
// crossing, which would have put an orange warning under every mirrored limb.
state.parts = [...BODY, 2 + 128, 0.38, 0.02, 0, 0, 0, 0, 0.14, -0.22, 0, 0.11, 0.12, 0];
check('a mirrored arm is not flagged', !mirrorCrosses(1));

// --- what it refuses ----------------------------------------------------------
state.parts = [...BODY, 1, 0.3, 0, 0, 0, 0, 0, 0.1, 0.1, 0.1, 0, 0, 0];
check('an unmirrored part has nothing to bake', !bakeMirror(1));

// Infinite, so it always straddles: there is no placement that makes it exact.
state.parts = [...BODY, 13 + 128, 0.2, 0, 0, 0, 0.1, 0, 0.7, 0.5, -0.2, 0.05, 0, 0];
check('a plane is always crossing', mirrorCrosses(1));
check('and is refused', !bakeMirror(1) && count() === 2);

// A scatter's instances are rolled from a seed at render time, so two scatters
// are two arrangements rather than one reflected. It has to refuse.
state.parts = [
  256, 1337, -12, 0.5, 0.5, 0.5, 0.5, 0, 0, 0, 0.04, 0, 0,
  128, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.09, 0.03, 0,
];
check('a scatter header refuses', !bakeMirror(0));
check('and so does its template', !bakeMirror(1));
check('the scatter is untouched', count() === 2 && isMirror(1));

// --- the cost -----------------------------------------------------------------
// The whole point is that this is not free: it spends a row of STRIDE numbers
// to buy two sides that can be animated apart.
state.parts = [...BODY, ...CASES[0].row];
const rows = state.parts.length;
bakeMirror(1);
check(`it costs exactly one row (${state.parts.length - rows} numbers)`,
  state.parts.length - rows === STRIDE);
check('and selects the new part', state.sel === 2);

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
