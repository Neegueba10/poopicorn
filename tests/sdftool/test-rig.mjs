/**
 * sdftool — the group maths: rotate rigid parts about a pivot, and write the
 * answer back as the three Euler turns the format holds.
 *
 * Pure Node. The rig is editor-only geometry with no DOM in it, and the whole
 * risk it carries is a convention mismatch: `prepRot` reads `rx ry rz` as
 * `R = Rz·Ry·Rx`, and a decomposition in any other order looks correct until
 * the second axis is used. So the first thing checked here is that this
 * module's matrix IS the renderer's, term for term, taken from `prepRot`
 * itself rather than from a comment about it.
 *
 * The second is that a turn is RIGID. A group that stretched, or that let its
 * members' own rotations drift out of step with their positions, would look
 * almost right and be impossible to debug from a sprite.
 */
import {
  axisMatrix, mul, apply, eulerToMatrix, matrixToEuler, transformGroup,
  translateGroup, centroid, GIMBAL_EPS,
} from '../../tools/sdftool/rig.js';
import { prepRot, STRIDE } from '../../src/js/core/sdf.js';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
const mClose = (a, b, eps = 1e-9) =>
  a.every((row, i) => row.every((v, j) => close(v, b[i][j], eps)));

// A deterministic spread of angles. Math.random would make a failure
// unreproducible, which is the one thing a geometry suite must not be.
let seed = 12345;
const rnd = () => ((seed = seed * 16807 % 2147483647) / 2147483647);

// --- the matrix is the renderer's ---------------------------------------------
// `prepRot` builds R = Rz·Ry·Rx and stores its TRANSPOSE, column by column, so
// reading it back as m[i][j] = out[j * 3 + i] recovers R itself.
function fromPrepRot(rx, ry, rz) {
  const part = [0, 0, 0, 0, rx, ry, rz, 0, 0, 0, 0.3, 0, 0];
  const out = prepRot(part);
  return [0, 1, 2].map(i => [0, 1, 2].map(j => out[j * 3 + i]));
}

let worst = 0;
for (let t = 0; t < 200; t++) {
  const [rx, ry, rz] = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
  const mine = eulerToMatrix(rx, ry, rz), theirs = fromPrepRot(rx, ry, rz);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) worst = Math.max(worst, Math.abs(mine[i][j] - theirs[i][j]));
  }
}
check(`eulerToMatrix is prepRot's own product (worst ${worst.toExponential(1)})`, worst < 1e-12);
check('a part is STRIDE numbers, as prepRot reads them', STRIDE === 13);

// --- the decomposition is its exact inverse -----------------------------------
let bad = 0, gimbals = 0;
for (let t = 0; t < 500; t++) {
  // Pitch kept clear of ±0.25 turns, which is the degenerate case tested below.
  const rx = rnd() - 0.5, ry = (rnd() - 0.5) * 0.45, rz = rnd() - 0.5;
  const e = matrixToEuler(eulerToMatrix(rx, ry, rz));
  if (e.gimbal) gimbals++;
  if (!close(e.rx, rx, 1e-9) || !close(e.ry, ry, 1e-9) || !close(e.rz, rz, 1e-9)) bad++;
}
check(`matrixToEuler round-trips away from lock (${bad} wrong)`, !bad && !gimbals);

// A turn of exactly 1 is the identity, which is the check that catches a wrong
// angle unit — degrees or radians here would land somewhere arbitrary.
check('a full turn is the identity (angles are TURNS)',
  mClose(eulerToMatrix(1, 1, 1), eulerToMatrix(0, 0, 0), 1e-12));

// --- gimbal lock is reported, and the ROTATION still survives -------------------
// At a quarter turn of pitch the X and Z rotations become the same rotation, so
// the three numbers cannot come back as they went in. What must come back is
// the same ORIENTATION — a group that jumped to a different pose there would be
// a bug; one that renamed the roll is the arithmetic being honest.
for (const ry of [0.25, -0.25]) {
  const src = eulerToMatrix(0.13, ry, 0.21);
  const e = matrixToEuler(src);
  check(`ry ${ry} is reported as gimbal lock`, e.gimbal);
  check(`ry ${ry} still reproduces the same rotation`,
    mClose(eulerToMatrix(e.rx, e.ry, e.rz), src, 1e-9));
  check(`ry ${ry} folds the roll into the yaw`, e.rx === 0);
}
check('an ordinary pitch is not reported as lock', !matrixToEuler(eulerToMatrix(0.1, 0.2, 0.3)).gimbal);
check('the threshold is a real tolerance, not zero', GIMBAL_EPS > 0 && GIMBAL_EPS < 0.1);

// --- a group turn is rigid -----------------------------------------------------
// Three parts strung out along X, as an arm is, with their own rotations on.
const arm = [
  0, 0.2, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0, 0,
  2, 0.6, 0.1, 0, 0.05, 0, 0.1, 0.2, 0, 0, 0.08, 0, 0,
  1, 1.0, 0.1, 0.2, 0, 0.15, 0, 0.1, 0.1, 0.1, 0, 0, 0,
  0, -3, -3, -3, 0, 0, 0, 0, 0, 0, 0.1, 0, 0,     // not a member
];
const IDS = [0, 1, 2];
const PIVOT = [0, 0, 0];
const posed = (parts, writes) => {
  const out = parts.slice();
  for (const [i, v] of writes) out[i] = v;
  return out;
};
const centreOf = (p, id) => [p[id * STRIDE + 1], p[id * STRIDE + 2], p[id * STRIDE + 3]];
const rotOf = (p, id) => [p[id * STRIDE + 4], p[id * STRIDE + 5], p[id * STRIDE + 6]];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const G = axisMatrix(2, 0.1);                       // a tenth turn about Z
const turned = transformGroup(arm, PIVOT, IDS, G);
check('a turn writes six numbers per member', turned.writes.length === 6 * IDS.length);
check('and reports no lock at a gentle angle', !turned.gimbal);
const after = posed(arm, turned.writes);

check('a non-member is untouched',
  centreOf(after, 3).join() === centreOf(arm, 3).join()
  && rotOf(after, 3).join() === rotOf(arm, 3).join());

let stretched = 0;
for (const a of IDS) {
  for (const b of IDS) {
    if (Math.abs(dist(centreOf(after, a), centreOf(after, b))
      - dist(centreOf(arm, a), centreOf(arm, b))) > 2e-3) stretched++;
  }
}
check(`the members keep their distances (${stretched} stretched)`, !stretched);

// The centres go where `pivot + G·(c − pivot)` says, to the three decimals the
// file is written at.
let offCentre = 0;
for (const id of IDS) {
  const want = apply(G, centreOf(arm, id).map((v, k) => v - PIVOT[k])).map((v, k) => v + PIVOT[k]);
  if (dist(centreOf(after, id), want) > 2e-3) offCentre++;
}
check(`every centre lands on pivot + G·(c − pivot) (${offCentre} off)`, !offCentre);

// AND THE ROTATIONS FOLLOW. This is the assertion that separates a rig from
// three parts that merely moved: each part's own frame must have turned by
// exactly G, or the arm slides through itself.
let unturned = 0;
for (const id of IDS) {
  const want = mul(G, eulerToMatrix(...rotOf(arm, id)));
  if (!mClose(eulerToMatrix(...rotOf(after, id)), want, 3e-3)) unturned++;
}
check(`every member's own rotation turned by G too (${unturned} adrift)`, !unturned);

// A pivot away from the origin is the case a shoulder actually is.
const SHOULDER = [0.2, 0.1, 0];
const swung = posed(arm, transformGroup(arm, SHOULDER, IDS, axisMatrix(0, 0.25)).writes);
check('a part sitting ON the pivot does not move',
  dist(centreOf(posed(arm, transformGroup(arm, centreOf(arm, 0), [0], G).writes), 0),
    centreOf(arm, 0)) < 2e-3);
check('a pivot away from the origin still swings the rest',
  dist(centreOf(swung, 2), centreOf(arm, 2)) > 0.1);

// A quarter turn about Y sends +X to −Z — the same check test-sdf.mjs makes of
// the renderer, so the two conventions are pinned to each other.
const one = [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0.1, 0, 0];
const q = posed(one, transformGroup(one, [0, 0, 0], [0], axisMatrix(1, 0.25)).writes);
check(`a quarter turn about Y sends +X to −Z (${centreOf(q, 0).join()})`,
  dist(centreOf(q, 0), [0, 0, -1]) < 2e-3);

// --- translation ----------------------------------------------------------------
const moved = translateGroup(arm, IDS, [0.5, 0, -0.25]);
check('a move writes three numbers per member', moved.writes.length === 3 * IDS.length);
check('and never a rotation column',
  moved.writes.every(([i]) => i % STRIDE >= 1 && i % STRIDE <= 3));
check('a move can never hit gimbal lock', !moved.gimbal);
const slid = posed(arm, moved.writes);
check('every member slid by the same vector',
  IDS.every(id => close(centreOf(slid, id)[0] - centreOf(arm, id)[0], 0.5, 2e-3)
    && close(centreOf(slid, id)[2] - centreOf(arm, id)[2], -0.25, 2e-3)));
check('and kept its own rotation',
  IDS.every(id => rotOf(slid, id).join() === rotOf(arm, id).join()));

// --- the pivot a new group starts at ---------------------------------------------
check(`centroid is the middle of the members (${centroid(arm, IDS).join()})`,
  close(centroid(arm, IDS)[0], 0.6, 1e-3));
check('centroid of nothing is the origin', centroid(arm, []).join() === '0,0,0');
check('centroid ignores an id that is not there', centroid(arm, [0, 99]).join()
  === centroid(arm, [0]).join());

// --- the identity does nothing ----------------------------------------------------
// A drag of zero must be a no-op to the last decimal, or every press would nudge
// the pose before the pointer had moved.
const still = posed(arm, transformGroup(arm, SHOULDER, IDS, axisMatrix(1, 0)).writes);
check('an identity turn changes no number',
  IDS.every(id => centreOf(still, id).every((v, k) => close(v, centreOf(arm, id)[k], 1e-3))
    && rotOf(still, id).every((v, k) => close(v, rotOf(arm, id)[k], 1e-3))));

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
