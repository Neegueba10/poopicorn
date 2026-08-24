/**
 * sdf clips — the runtime that turns a clip into sheet rows.
 *
 * Pure Node, no browser and no server, as tests/sdftool/test-sdf.mjs is:
 * core/sdfanim.js imports nothing and touches no DOM, and proving that is half
 * the point.
 *
 * The assertions that matter most are the ones about what does NOT change. A
 * clip writes a handful of numbers; every other number, the materials, the
 * model itself and a scatter's instances must come through the frames
 * untouched, or the character comes apart as it plays.
 */
import { readFileSync } from 'node:fs';

import { clipSheet } from '../../src/js/core/sdfanim.js';
import SDF, { STRIDE, expand } from '../../src/js/core/sdf.js';
import creature from '../../src/js/models/creature.js';
import HERO from '../../src/js/clips/hero.js';
import { pngPalette, hashPixels } from '../../tools/sdftool/nodeutil.mjs';
import { ROOT } from '../helpers.mjs';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

// --- the shape of what comes back --------------------------------------------
const rows = clipSheet(HERO);
const [, view, w, h, frames, fps, mode, channels] = HERO;

check(`a ${frames}-frame clip is ${frames} rows`, rows.length === frames);
check('every row is a sheet row: [model, view, w, h]',
  rows.every(r => r.length === 4 && r[2] === w && r[3] === h));
check('every row carries a [parts, mats, view] model',
  rows.every(r => r[0].length === 3 && r[0][1] === creature[1] && r[0][2] === creature[2]));
check('the materials are the model\'s own, not a copy',
  rows.every(r => r[0][1] === creature[1]));
check('fps and mode are for the game, and are whole and in range',
  Number.isInteger(fps) && fps > 0 && [0, 1, 2].includes(mode));

// --- the model is not touched -------------------------------------------------
// A clip and a static sheet row may share one model, so posing has to copy.
const before = creature[0].join();
clipSheet(HERO);
check('the model itself is never mutated', creature[0].join() === before);
check('each frame gets its own parts array',
  new Set(rows.map(r => r[0][0])).size === frames);

// --- only the animated columns move ------------------------------------------
const numeric = channels.filter(c => typeof c[0] == 'number').map(c => c[0]);
const strings = channels.filter(c => typeof c[0] == 'string').map(c => c[0]);
let strayPart = 0, wrongValue = 0;
for (let f = 0; f < frames; f++) {
  const parts = rows[f][0][0];
  for (let i = 0; i < parts.length; i++) {
    if (numeric.includes(i)) continue;
    if (parts[i] !== creature[0][i]) strayPart++;
  }
  for (const ch of channels) {
    if (typeof ch[0] == 'number' && parts[ch[0]] !== ch[f + 1]) wrongValue++;
  }
}
check(`no column outside the channels moves (${strayPart} stray)`, !strayPart);
check(`every numeric channel lands in its own slot (${wrongValue} wrong)`, !wrongValue);
check('a numeric target is part * 13 + column',
  numeric.every(t => t < creature[0].length && t % STRIDE !== 0));

// --- view channels land in the view, and nowhere else -------------------------
let viewOk = 1, leaked = 0;
for (let f = 0; f < frames; f++) {
  const v = rows[f][1];
  for (const ch of channels) {
    if (typeof ch[0] == 'string' && v[ch[0]] !== ch[f + 1]) viewOk = 0;
  }
  // The clip's own dials survive under the frame's.
  for (const k in view) if (!strings.includes(k) && v[k] !== view[k]) viewOk = 0;
  for (const t of numeric) if (t in v) leaked++;
}
check('every string channel lands in the frame\'s view', viewOk);
check(`a numeric target never reaches the view (${leaked} leaked)`, !leaked);
check('each frame gets its own view object',
  new Set(rows.map(r => r[1])).size === frames && rows[0][1] !== view);

// --- a clip actually animates -------------------------------------------------
const pal = pngPalette(ROOT + 'src/assets/palette.png');
const s = new SDF(w, h, pal, { lo: 1, rampSize: 8 });
const bake = r => hashPixels(Uint8Array.from(
  s.render(r[0][0], r[0][1], { ...r[0][2], ...r[1] })));
const shots = rows.map(bake);
check(`the frames are distinct pictures (${new Set(shots).size}/${frames})`,
  new Set(shots).size === frames);
// And a frame is stable: the same numbers must give the same pixels, or a
// re-bake after an edit would flicker.
check('a frame renders identically twice', bake(rows[1]) === shots[1]);

// --- a scatter is stable across the frames ------------------------------------
// The seed, the count and every spread live on the header row, and a channel
// may not target one. So `expand()` has to produce the SAME instances, in the
// same order, in every frame — a mass that reshuffles per frame is confetti.
const SCA = 256;
const massModel = [[
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.4, 0, 0,
  SCA, 1337, 12, 0.5, 0.4, 0.5, 0.25, 0, 0, 0, 0.03, 0, 0,
  0, 0, 0.2, 0, 0, 0, 0, 0, 0, 0, 0.09, 0.02, 0,
], [[0.5, 0.45, 0.4]], { scale: 2.2 }];
// Column 2 (y) of part 0 — the body, not the header and not the template.
const massClip = [massModel, {}, 32, 32, 3, 8, 0, [[2, 0, 0.1, 0.2]]];
const massRows = clipSheet(massClip);
const grown = massRows.map(r => expand(r[0][0]));
check('a scattered clip expands to the same instance count in every frame',
  grown.every(g => g.length === grown[0].length));
check('and to the same instances, in the same order',
  grown.every(g => g.slice(STRIDE).join() === grown[0].slice(STRIDE).join()));
check('while the animated part still moves',
  grown[0][2] === 0 && grown[2][2] === 0.2);

// --- the portability contract --------------------------------------------------
const imports = f => [...readFileSync(ROOT + f, 'utf8')
  .matchAll(/^\s*(?:import|export)\b[^;]*?from\s*['"]([^'"]+)['"]/gm)].map(m => m[1]);
const noDom = f => !/\b(document|window|navigator|HTMLElement)\b/
  .test(readFileSync(ROOT + f, 'utf8'));

check('sdfanim imports nothing', !imports('src/js/core/sdfanim.js').length);
check('sdfanim touches no DOM', noDom('src/js/core/sdfanim.js'));
// A clip is data about a model, so it may reference models and nothing else.
check('a clip imports models and nothing else',
  imports('src/js/clips/hero.js').every(i => i.startsWith('../models/')));

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
