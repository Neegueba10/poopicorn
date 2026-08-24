/**
 * sdftool — the face handles: an adjustable bounding box.
 *
 * THE PROPERTY IS THAT THE OPPOSITE FACE DOES NOT MOVE. That is the whole
 * difference between this and the scale arms, and it is the half that is easy
 * to get subtly wrong: a face drag writes TWO numbers, a dimension and the
 * part's centre, and any error in the split shows up as the far side of the
 * shape creeping while you drag the near one. Measured against `map()`, not
 * against the numbers, because the numbers are what is under test.
 *
 * FACES ARE NOT OFFERED ON EVERY KIND, and the second half of this suite is
 * about which. A cylinder has two end caps and one radius — its x and z faces
 * are the same number, so a handle there would drag a pair of faces it did not
 * claim. A sphere's six faces are one radius. A torus's cage touches it at four
 * points that mean nothing. A control that lies about what it does is worse
 * than no control, so those kinds get none.
 *
 * Pure Node.
 */
import { handles } from '../../tools/sdftool/shapewidget.js';
import { KINDS, NEW_DIMS } from '../../tools/sdftool/state.js';
import { map, prepRot } from '../../src/js/core/sdf.js';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const proj = (x, y, z) => [100 * (x - z * 0.5), 100 * (-y - z * 0.25)];

const rowOf = (kind, extra = {}) => [
  kind, extra.x ?? 0, extra.y ?? 0, extra.z ?? 0,
  extra.rx ?? 0, extra.ry ?? 0, extra.rz ?? 0,
  ...(extra.dims ?? NEW_DIMS[kind & 31]), extra.blend ?? 0, 0,
];

const faces = parts => handles(parts, 0, proj).filter(h => h.type === 'face');

/**
 * Where the far face is, as a distance along `h.wdir` from a FIXED world point.
 *
 * Fixed, and not the part's own centre, because an asymmetric drag moves that
 * centre — measuring from it would move the ruler along with the thing being
 * measured and every face would look like it stayed put.
 *
 * The walk starts well outside on the far side and comes in, so the crossing it
 * wants is outside-to-inside. This file's own scan, so the checks below are not
 * an echo of the widget's marcher.
 */
function oppositeFace(parts, h, base) {
  const rot = prepRot(parts);
  const from = [0, 1, 2].map(k => base[k] - h.wdir[k] * 2);
  const at = t => map(parts, from[0] + h.wdir[0] * t, from[1] + h.wdir[1] * t,
    from[2] + h.wdir[2] * t, rot);
  const HI = 4, N = 80000;
  let prev = at(0);
  for (let i = 1; i <= N; i++) {
    const t = HI * (i / N);
    const v = at(t);
    if (prev > 0 && v <= 0) {
      const t0 = HI * ((i - 1) / N);
      return -2 + t0 + (t - t0) * (prev / (prev - v));
    }
    prev = v;
  }
  return NaN;
}

/** Apply what a face drag would write, the way canvas.js does. */
function dragFace(parts, h, dist, symmetric) {
  const out = [...parts];
  const solo = symmetric || !h.movesCentre;
  out[h.col] = Math.max(0, parts[h.col] + dist / (solo ? 1 : 2) / h.gain);
  if (!solo) for (let k = 0; k < 3; k++) out[1 + k] = parts[1 + k] + h.wdir[k] * (dist / 2);
  return out;
}

// --- which kinds offer faces, and how many ------------------------------------
const WANT = {
  box: 6, ellipsoid: 6, cylinder: 2, cone: 2, 'hex prism': 2, 'tri prism': 2,
  pyramid: 1,
};
for (let k = 0; k < KINDS.length; k++) {
  const n = faces(rowOf(k)).length;
  const want = WANT[KINDS[k]] || 0;
  check(`${KINDS[k]}: ${want || 'no'} face handle${want === 1 ? '' : 's'} (${n})`,
    n === want);
}

// --- the opposite face stays put ----------------------------------------------
// Turned and off the origin, so a drag that happened to work in the world's
// frame is not enough to pass.
for (const kind of [1, 8, 4, 5, 7, 12]) {
  const parts = rowOf(kind, { x: 0.14, y: -0.09, z: 0.05, rx: 0.04, ry: 0.12, rz: -0.07 });
  const base = [parts[1], parts[2], parts[3]];
  for (const h of faces(parts)) {
    const before = oppositeFace(parts, h, base);
    const after = oppositeFace(dragFace(parts, h, 0.08, false), h, base);
    const name = `${KINDS[kind]} ${'xyz'[h.ldir.findIndex(v => v)]}`
      + `${h.ldir.some(v => v < 0) ? '-' : '+'}`;
    check(`${name}: the opposite face stays put (${(after - before).toExponential(1)})`,
      Math.abs(after - before) < 2e-4);
  }
}

// --- and the dragged face moves by what the hand moved -------------------------
// The contract every widget on this pane keeps. A face that moved by half the
// drag would still pass the check above.
for (const kind of [1, 8, 4, 12]) {
  const parts = rowOf(kind, { rx: 0.04, ry: 0.12 });
  for (const h of faces(parts)) {
    const D = 0.06;
    const moved = dragFace(parts, h, D, false);
    const h2 = handles(moved, 0, proj).find(g => g.type === 'face'
      && g.col === h.col && g.ldir.every((v, i) => v === h.ldir[i]));
    const went = (h2.lpos[0] - h.lpos[0]) * h.ldir[0]
      + (h2.lpos[1] - h.lpos[1]) * h.ldir[1] + (h2.lpos[2] - h.lpos[2]) * h.ldir[2];
    // The anchor is in the part's frame and the centre moved too, so the face's
    // travel in WORLD is the anchor's plus the centre's — half each.
    const total = went + D / 2;
    check(`${KINDS[kind]} col ${h.col}: the dragged face travels with the hand`
      + ` (${total.toFixed(4)} of ${D})`, Math.abs(total - D) < 2e-3);
  }
}

// --- Alt resizes about the centre ----------------------------------------------
const box = rowOf(1, { dims: [0.2, 0.15, 0.1, 0] });
const fx = faces(box).find(h => h.ldir[0] > 0);
const sym = dragFace(box, fx, 0.1, true);
check('Alt leaves the centre where it was', sym[1] === box[1]);
check('and grows the dimension by the whole drag',
  Math.abs(sym[7] - (box[7] + 0.1)) < 1e-9);
const asym = dragFace(box, fx, 0.1, false);
check('an asymmetric drag splits it between the two',
  Math.abs(asym[7] - (box[7] + 0.05)) < 1e-9
  && Math.abs(asym[1] - (box[1] + 0.05)) < 1e-9);

// --- the pyramid pins its own apex ---------------------------------------------
// The format puts the apex at the part's origin, so growing the height already
// moves the base and nothing else. Moving the centre as well would drag the
// apex off the point the numbers say it is at.
const pyr = faces(rowOf(10));
check('a pyramid offers only its base', pyr.length === 1 && pyr[0].ldir[1] < 0);
check('and it does not move the part', pyr[0].movesCentre === false);
const grown = dragFace(rowOf(10), pyr[0], 0.1, false);
check('so its base drops and its centre holds',
  grown[1] === 0 && grown[2] === 0 && grown[3] === 0 && grown[8] > NEW_DIMS[10][1]);

// --- nothing goes inside out ------------------------------------------------------
const squashed = dragFace(box, fx, -10, false);
check('a face dragged through the part stops at zero', squashed[7] === 0);

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
