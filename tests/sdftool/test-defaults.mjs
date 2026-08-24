/**
 * sdftool — what a freshly added part looks like. Pure Node: this is a fact
 * about NEW_DIMS and the field, not about the editing surface.
 *
 * Two properties, and every kind must hold both. A NEW PART MUST BE VISIBLE:
 * a dimension left at 0 on a kind that reads it is a part that renders nothing
 * and reads as a broken tool. AND IT MUST NOT FILL THE VIEWPORT: the default
 * camera frames about a unit, so a part arriving at 0.3 half-extents covered
 * the model it was being added to.
 */
import { NEW_DIMS, FIELDS, KINDS, STRIDE, addPart, state } from '../../tools/sdftool/state.js';
import { map } from '../../src/js/core/sdf.js';

// Half the box the probe sweeps, and its step. LIM is a little over what the
// default camera frames; STEP has to be finer than the thinnest default tube.
const LIM = 0.5, STEP = 0.02;

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

check(`every kind has defaults (${NEW_DIMS.length} of ${KINDS.length})`,
  NEW_DIMS.length === KINDS.length);

for (let k = 0; k < KINDS.length; k++) {
  state.parts = [];
  addPart(k);
  const m = state.parts;
  check(`${KINDS[k]} is one row of ${STRIDE}`, m.length === STRIDE);

  // The plane is a half-space, so it fills whatever box you measure it in and
  // the size assertions below cannot say anything about it.
  if (k === 13) continue;

  // Measured, not derived: sample a grid over the frame the default camera
  // shows and ask where the surface actually is. `bound()` is no use here — it
  // adds `a b c` as extents, and on a capped torus two of those are the sine
  // and cosine of the cap angle, so it reports 1.22 for a shape 0.23 across.
  let inside = 0, reach = 0;
  for (let z = -LIM; z <= LIM; z += STEP)
    for (let y = -LIM; y <= LIM; y += STEP)
      for (let x = -LIM; x <= LIM; x += STEP) {
        if (map(m, x, y, z) >= 0) continue;
        inside++;
        reach = Math.max(reach, Math.abs(x), Math.abs(y), Math.abs(z));
      }
  check(`${KINDS[k]} has volume (${inside} samples inside)`, inside > 0);
  check(`${KINDS[k]} arrives small (reaches ${reach.toFixed(2)})`, reach > 0 && reach <= 0.3);
}

// Every `corner` is a fillet on a shape that is meant to have edges. Large
// enough and a box is a sphere, which is what the old shared 0.25 did.
for (let k = 0; k < KINDS.length; k++) {
  if (FIELDS[k].round !== 'corner') continue;
  check(`${KINDS[k]} starts with a hard corner (${NEW_DIMS[k][3]})`, NEW_DIMS[k][3] <= 0.02);
}

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
