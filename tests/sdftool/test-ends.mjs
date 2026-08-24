/**
 * sdftool — the capsule's two ends.
 *
 * A CAPSULE IS NOT A BOX. Its `a b c` is an axis VECTOR from the centre, not
 * three half-extents, so its cage is square to a frame the shape runs
 * diagonally through and none of that box's faces is a number anyone edits.
 * What it has is two joints, and the control is to drag one while the other
 * stays — the same asymmetry a face handle offers, in three dimensions instead
 * of one.
 *
 * THE PROPERTY IS THAT THE FAR JOINT DOES NOT MOVE. A drag writes six numbers,
 * three of centre and three of axis, and any error in that split shows as the
 * other end of the limb sliding while you place this one. Measured in world
 * space from the numbers the widget would write, and confirmed against `map()`.
 *
 * Pure Node.
 */
import { handles, endWrite } from '../../tools/sdftool/shapewidget.js';
import { KINDS, NEW_DIMS } from '../../tools/sdftool/state.js';
import { partAxes } from '../../tools/sdftool/fit.js';
import { map, prepRot } from '../../src/js/core/sdf.js';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const proj = (x, y, z) => [100 * (x - z * 0.5), 100 * (-y - z * 0.25)];

const rowOf = (dims, extra = {}) => [
  2, extra.x ?? 0, extra.y ?? 0, extra.z ?? 0,
  extra.rx ?? 0, extra.ry ?? 0, extra.rz ?? 0, ...dims, 0, 0,
];

const ends = parts => handles(parts, 0, proj).filter(h => h.type === 'end');

/** The two joints in world, straight from the row — the widget's answer has to
 * agree with this, and this is one line of arithmetic. */
function joints(parts) {
  const ax = partAxes(parts, 0);
  const c = [parts[1], parts[2], parts[3]];
  const v = [0, 1, 2].map(k =>
    ax[0][k] * parts[7] + ax[1][k] * parts[8] + ax[2][k] * parts[9]);
  return [c.map((q, k) => q + v[k]), c.map((q, k) => q - v[k])];
}

/** Apply what an end drag would write, the way canvas.js does. */
function dragEnd(parts, h, move) {
  const w = endWrite(h, [parts[1], parts[2], parts[3]], move);
  const out = [...parts];
  for (let k = 0; k < 3; k++) {
    out[1 + k] = w.centre[k];
    out[7 + k] = w.axis[k];
  }
  return out;
}

// --- only the capsule has them -------------------------------------------------
for (let k = 0; k < KINDS.length; k++) {
  const n = ends([k, 0, 0, 0, 0, 0, 0, ...NEW_DIMS[k], 0, 0]).length;
  check(`${KINDS[k]}: ${k === 2 ? 'two ends' : 'no ends'} (${n})`,
    n === (k === 2 ? 2 : 0));
}

// --- the handles are on the joints ----------------------------------------------
const parts = rowOf([0.14, -0.22, 0.05, 0.11],
  { x: 0.3, y: 0.1, z: -0.05, rx: 0.06, ry: 0.17, rz: -0.08 });
const js = joints(parts);
for (const h of ends(parts)) {
  const want = h.sign > 0 ? js[0] : js[1];
  check(`the ${h.sign > 0 ? '+' : '-'} handle sits on its joint`,
    h.wpos.every((v, k) => Math.abs(v - want[k]) < 1e-9));
}

// --- dragging one leaves the other exactly where it was --------------------------
for (const move of [[0.2, 0, 0], [0, -0.15, 0.1], [-0.05, 0.3, -0.2], [0, 0, 0.25]]) {
  for (const h of ends(parts)) {
    const after = dragEnd(parts, h, move);
    const [p1, m1] = joints(after);
    const far = h.sign > 0 ? m1 : p1;
    const wantFar = h.sign > 0 ? js[1] : js[0];
    check(`drag ${move} on the ${h.sign > 0 ? '+' : '-'} end: the far joint holds`,
      far.every((v, k) => Math.abs(v - wantFar[k]) < 1e-9));
    // And the dragged joint went exactly where the hand did.
    const near = h.sign > 0 ? p1 : m1;
    const wantNear = h.wpos.map((v, k) => v + move[k]);
    check(`  and the near joint follows the pointer`,
      near.every((v, k) => Math.abs(v - wantNear[k]) < 1e-9));
  }
}

// --- the shape really is where the numbers say ----------------------------------
// The joints are the segment the capsule is swept along, so `map` at a joint
// must read minus the radius — inside by exactly the tube.
const swung = dragEnd(parts, ends(parts)[0], [0.1, 0.25, -0.12]);
const [np] = joints(swung);
check(`the dragged end is a radius inside the surface`
  + ` (${map(swung, np[0], np[1], np[2], prepRot(swung)).toFixed(4)} vs ${-swung[10]})`,
  Math.abs(map(swung, np[0], np[1], np[2], prepRot(swung)) + swung[10]) < 1e-6);

// --- a capsule turns without its rotation columns ---------------------------------
// The axis is a vector, so aiming a limb is aiming that vector. `rx ry rz` are
// untouched, which is what lets a clip animate an end without fighting a
// rotation channel.
check('an end drag writes no rotation',
  [4, 5, 6].every(k => swung[k] === parts[k]));
check('and it does change the axis', [7, 8, 9].some(k => swung[k] !== parts[k]));

// --- a degenerate capsule ---------------------------------------------------------
// A zero axis is a sphere. Both handles land on the centre, and dragging one
// must give a real axis rather than a NaN.
const flat = rowOf([0, 0, 0, 0.1]);
const fe = ends(flat);
check('a capsule with no axis still has two handles', fe.length === 2);
const opened = dragEnd(flat, fe[0], [0.2, 0, 0]);
check('dragging one opens it out again',
  opened.every(Number.isFinite) && Math.hypot(opened[7], opened[8], opened[9]) > 0.09);

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
