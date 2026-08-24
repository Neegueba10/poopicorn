/**
 * sdfsheet.js — bake SDF models into ONE offscreen canvas, and hand back a
 * rect table. The alternative host adapter to sdfbake.js, for a game with no
 * indexed framebuffer at all.
 *
 * THE IDEA. An indexed buffer earns its keep when you want to do things in
 * palette space at run time — recolour by remapping indices, cycle a palette,
 * blend two indices into a third. A game whose art is PRE-RENDERED wants none
 * of that: the pixels were quantised at bake time and never change again. So
 * the palette look survives without the machinery, because it is baked into
 * the pixels rather than enforced at draw time.
 *
 * What that buys, beyond the bytes:
 *
 *   - `drawImage` is the browser's, so drawing is GPU-accelerated instead of a
 *     JS loop per pixel — and so is the full-screen index-to-RGBA conversion
 *     that an indexed buffer pays EVERY FRAME (129,600 iterations at 480x270).
 *   - Rotation, scale, alpha, clipping and every `globalCompositeOperation`
 *     come free, which is the honest answer to "where did the blend modes go".
 *
 * What it costs, and the rule that follows:
 *
 *   - Compositing happens in RGB, after the palette. Draw a sprite at
 *     `globalAlpha = 0.5` and the blended pixels are NOT palette colours.
 *     Baked sprites have hard alpha — index 0 is transparent, everything else
 *     is opaque — so plain `source-over` keeps every visible pixel exactly a
 *     palette colour. Anything else is a deliberate trade, per effect.
 *   - Runtime palette tricks are gone. Bake the variant instead; a recoloured
 *     sprite is more sheet space, not more code.
 *
 * The low-resolution look is unaffected: render into a small canvas and scale
 * it up with `image-rendering: pixelated`.
 */
import SDF from './sdf.js';

/**
 * Start baking `sheet` into an offscreen canvas.
 *
 * A sheet entry is `[model, view, w, h]` — the model as imported from
 * `src/js/models/`, the view overrides on top of the model's own default view,
 * and the size the sprite bakes at. A falsy entry is a TOMBSTONE: it renders
 * nothing and emits a zero rect, so a deleted sprite never shifts the id of
 * one after it.
 *
 * THE LAYOUT IS NOT DATA. Sprites are shelf-packed here, at boot, from the
 * sizes the sheet already carries — so a sheet file stores no x/y at all. That
 * is the smallest thing that can work, and it is only possible because these
 * are pre-rendered sprites on a private surface: nothing outside the game ever
 * needs to know where sprite 7 landed.
 *
 * @param {any[][]} sheet
 * @param {Uint8Array} pal palette RGB
 * @param {number} [sheetW]
 * @param {object} [opts] SDF constructor options
 * @param {(w: number, h: number, pal: Uint8Array, opts: object) => any} [make]
 *   the renderer to bake with. The game never passes this; the sdftool passes
 *   its GPU back end so that the packing, the order sprites finish in and the
 *   rect table stay THIS code rather than a second copy of it
 *   (tools/sdftool/glrender.js).
 * @returns {{ step(ms?: number): void, done(): boolean, progress(): number,
 *   rects: Int16Array, canvas: HTMLCanvasElement }}
 */
export function sheetBaker(sheet, pal, sheetW = 512, opts = {}, make) {
  // Shelf-pack, tallest first, and grow the canvas to whatever the rows need.
  const live = sheet.map((_, i) => i).filter(i => sheet[i]);
  const order = live.slice().sort((a, b) => sheet[b][3] - sheet[a][3]);
  const rects = new Int16Array(sheet.length * 4);
  let x = 0, y = 0, shelf = 0;
  for (const i of order) {
    const w = sheet[i][2], h = sheet[i][3];
    if (x + w > sheetW) { x = 0; y += shelf; shelf = 0; }
    rects[i * 4] = x;
    rects[i * 4 + 1] = y;
    rects[i * 4 + 2] = w;
    rects[i * 4 + 3] = h;
    x += w;
    if (h > shelf) shelf = h;
  }
  const sheetH = y + shelf;

  const canvas = document.createElement('canvas');
  canvas.width = sheetW;
  canvas.height = Math.max(1, sheetH);
  const ctx = canvas.getContext('2d');

  // lo: 1 — index 0 is the transparent entry, and a sprite's alpha comes from
  // exactly that index.
  //
  // NO `rampSize`. core/palette.js is a cube and a grey ramp, not 32 ramps of
  // 8, so the claim would be false and `outline` would darken a pixel into
  // whatever colour sits eight entries below it. A host baking against a
  // ramp-structured palette passes `rampSize: 8` itself.
  const o = { lo: 1, ...opts };
  const s = make ? make(1, 1, pal, o) : new SDF(1, 1, pal, o);
  let n = 0, started = false;

  return {
    step(ms = 8) {
      const t0 = Date.now();
      while (n < live.length) {
        const i = live[n];
        const [model, view, w, h] = sheet[i];
        if (!started) {
          if (s.w !== w || s.h !== h) s.setSize(w, h);
          // The model's own view is the default and the entry overrides it, so
          // a facing set spells one number per sprite instead of a whole view.
          s.begin(model[0], model[1], { ...model[2], ...view });
          started = true;
        }
        s.step(Math.max(1, ms - (Date.now() - t0)));
        if (!s.done()) return;                 // resume mid-sprite next frame
        const img = ctx.createImageData(w, h);
        s.toRGBA(new Uint8ClampedArray(img.data.buffer));
        ctx.putImageData(img, rects[i * 4], rects[i * 4 + 1]);
        n++;
        started = false;
        if (Date.now() - t0 >= ms) return;
      }
    },
    done: () => n >= live.length,
    progress: () => (live.length ? n / live.length : 1),
    rects,
    canvas,
  };
}
