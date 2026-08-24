// Second-pass property mangler, run on dist/game-rollup.js between the main
// rollup+terser build and roadroller.
//
// Why: the main terser pass runs with mangle.properties.builtins:false, which
// (correctly) refuses to rename any property that shares a name with a DOM or
// builtin property — so engine fields like `radius` or `canvas` survive into
// the bundle at full length. This pass reruns the property mangler with
// builtins:true but restricted to the explicit allowlist below: names we have
// verified are only ever used on our own objects in the bundle, never on a
// DOM/builtin object.
//
// Safety: terser's property mangler collects every property name in the file
// and marks non-matched ones unmangleable, and generated names skip that set
// (see node_modules/terser/lib/propmangle.js can_mangle/add) — so this pass
// cannot collide with names produced by the first pass.
//
// Adding a name: grep dist/game-rollup.js for `.<name>` first — every
// occurrence must be one of OUR objects. Never add a name that appears as a
// property access on a canvas/context/audio/DOM/typed-array/builtin object
// anywhere in the bundle (e.g. width, height, buffer, data, value, length,
// style, connect, start).
const { readFileSync, writeFileSync } = require('fs');
const { join } = require('path');
const { minify } = require('terser');

const FILE = join(__dirname, '..', 'dist', 'game-rollup.js');

const NAMES = [
  // engine fields/methods that collide with DOM/builtin property names
  'radius', 'color', 'speed',                    // Entity / ParticleSystem / demo Player
  'cells', 'cols', 'rows', 'reset',              // SpatialGrid
  'pressed', 'released',                         // Key
  'update', 'draw', 'init',                      // game/engine protocol methods
  'line', 'canvas', 'pages',                     // RetroBuffer
  'page', 'sheet',                               // SpriteSheet / SpriteFont / TileMap
  'state', 'seed', 'next',                       // LCG
  'name', 'id',                                  // sound entries / Entity
  'frames', 'mode', 'done',                      // Animation
];

(async () => {
  const src = readFileSync(FILE, 'utf8');
  const out = await minify(src, {
    compress: false,
    mangle: {
      properties: {
        builtins: true,
        keep_quoted: true,
        regex: new RegExp(`^(${NAMES.join('|')})$`),
      },
    },
  });
  writeFileSync(FILE, out.code);
  console.log(`crunch-props: ${src.length} -> ${out.code.length} bytes (${NAMES.length} names)`);
})();
