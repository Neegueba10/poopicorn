/**
 * Two decimal places, and a model never holds anything else.
 *
 * A model bakes at roughly 35 px per world unit, so a third digit is a byte in
 * the zip and a thirtieth of a pixel on screen. Rounding the models poppy.js
 * ships took 139 B out of the zip.
 *
 * IT ROUNDS AT THE EDGES OF THE DOCUMENT, not on every write. `set` keeps what
 * a gesture gives it, because a group rotate writes six columns from a matrix
 * and a group scale writes a dimension and a centre — quantising each
 * intermediate accumulates the error through the gestures test-gizmo.mjs and
 * test-multiselect.mjs measure to a thousandth. `fileText` rounds once, and the
 * server rounds again on the way to disk, so a stale client or a hand-rolled
 * POST cannot slip a long number in. The server is the authority.
 *
 * Pure Node for the first half — state.js touches no DOM until something calls
 * `fetch`. The second half needs the tools server the runner boots.
 */
import { readFileSync, unlinkSync } from 'node:fs';

import {
  state, set, get, setDial, addMat, setMat, addPart, fileText, q2, COL, STRIDE,
} from '../../tools/sdftool/state.js';
import { BASE, ROOT } from '../helpers.mjs';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const MODELS = ROOT + 'src/js/models/';
const PROBE = '_precision_probe';

/** Every number in a generated file, with the integers dropped. */
const decimals = text => [...text.matchAll(/-?\d+\.\d+/g)].map(m => m[0]);
const longest = text => decimals(text).reduce((n, d) => Math.max(n, d.split('.')[1].length), 0);

// --- the editor writes -------------------------------------------------------
state.parts = [];
state.mats = [[0.7, 0.7, 0.7]];
state.view = {};
addPart(1);

set(0, COL.x, 0.123456);
check('set() keeps what the gesture gave it', get(0, COL.x) === 0.123456);
setDial('yaw', 0.74812);
check('setDial() does too', state.view.yaw === 0.74812);

// The columns that are not lengths must come through the quantiser untouched:
// a scatter seed is up to 2147483646, and a kind carries the flag bits.
check('q2 leaves a scatter seed alone', q2(2147483646) === 2147483646);
check('q2 leaves a flagged kind alone', q2(128 + 12) === 140);
check('q2 rounds a negative the same way it rounds its twin',
  q2(-0.567) === -0.57 && q2(0.567) === 0.57);
check('q2 drops a number under half a hundredth to 0', q2(0.004) === 0);

// A colour is picked against the real palette, so the editor holds it exactly
// as `entry / 255` — rounding it in place would make the swatch a colour the
// palette does not have (tests/sdftool/test-tool.mjs asserts it does).
addMat([0.85490196, 0.3333, 0.1]);
check('addMat() keeps the palette entry it was given',
  state.mats[1][0] === 0.85490196);
setMat(1, [0.46666667, 1, 0.12345]);
check('setMat() does too', state.mats[1][0] === 0.46666667);

// And the file rounds everything, however long the numbers in the editor got.
addPart(2);
for (let c = 1; c < STRIDE - 1; c++) set(1, c, Math.PI / (c + 7));
setDial('li', 0.76391);
const text = fileText();
check(`fileText() emits nothing longer than 2 dp (longest ${longest(text)})`, longest(text) <= 2);
check('fileText() still writes the numbers it has', decimals(text).length > 0);
check('fileText() rounded the part it was given', /0\.12,/.test(text));
check('fileText() rounded the view', /li: 0\.76/.test(text));
check('fileText() rounded the materials', /\[0\.85, 0\.33, 0\.1\]/.test(text)
  || /\[0\.47, 1, 0\.12\]/.test(text));

// --- the server writes -------------------------------------------------------
// The authority. This is the path a save actually takes, and the one a stale
// client cannot get around.
try {
  const res = await fetch(`${BASE}/api/save-model`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: PROBE,
      parts: [1, 0.123456, -0.98765, 0.5, 0, 0, 0, 0.1234, 0.2345, 0.3456, 0.06789, 0.1, 0],
      mats: [[0.85490196, 0.46666667, 0.3333]],
      view: { yaw: 0.74812, scale: 1.80735, li: 0.7639 },
    }),
  });
  check('the server accepts a model with long numbers', res.status === 200);
  const text = readFileSync(MODELS + PROBE + '.js', 'utf8');
  check(`the file it wrote is 2 dp throughout (longest ${longest(text)})`, longest(text) <= 2);
  check('the parts rounded', /0\.12, -0\.99, 0\.5/.test(text));
  check('the materials rounded', /\[0\.85, 0\.47, 0\.33\]/.test(text));
  check('the view rounded', /yaw: 0\.75/.test(text) && /scale: 1\.81/.test(text));
  const back = (await import(MODELS + PROBE + '.js')).default;
  check('and it is still a model the runtime can read',
    back[0].length === STRIDE && back[1].length === 1);
} finally {
  try { unlinkSync(MODELS + PROBE + '.js'); } catch {}
}

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
