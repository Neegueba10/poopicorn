// Boot: create the viewport canvas, wire the UI, bind input. There is no
// palette image to wait for — core/palette.js generates the palette from 96
// bytes of source, which is the whole reason the canvas stack ships no image.
import * as state from './state.js';
import * as canvas from './canvas.js';
import * as ui from './ui.js';
import * as bake from './bake.js';
import * as tiles from './tiles.js';
import * as prefs from './prefs.js';
import * as layers from './layers.js';
import * as arrange from './arrange.js';
import * as overview from './overview.js';
import * as playtest from './playtest.js';

canvas.setup();
ui.initUI();
await import('./input.js'); // binds pointer handlers to the display canvas

// console/automation access to editor state. `ready` last, so a test that
// polls for it knows every handler above is bound (the sdftool suites learned
// this the hard way).
window.stagetool = {
  ...state, canvas, ui, bake, tiles, prefs, layers, arrange, overview, playtest,
  ready: true,
};
