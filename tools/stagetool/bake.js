// The tool's sheet bakes, cached by sheet name.
//
// A sheet is SDF models, so baking one is hundreds of milliseconds of
// raymarching — the thing every other editor here does in a frame. Two
// consequences shape this module:
//
//   - CACHE BY NAME. The worldtool could rebake an atlas page on every zoom
//     step because a bake was a drawShape. This one must not, so the baked
//     canvas outlives the viewport, the camera and the document.
//   - THE RECT TABLE IS READY IMMEDIATELY. sheetBaker packs in its
//     constructor, so sizes, hit-testing and the stamp list all work while
//     the pixels are still arriving. Nothing waits on a bake.
//
// The bake itself runs through the SHIPPED sheetBaker, at the generated
// palette, so a sprite placed here is the sprite the game draws.
import { genPalette } from '/src/js/core/palette.js';
import { sheetBaker } from '/src/js/core/sdfsheet.js';

export const pal = genPalette();

const art = new Map();      // sheet name -> sheetBaker
let pump = 0;               // rAF id of the stepping loop, 0 when idle

/** The baker for `name`, or null if it was never asked for. */
export const artOf = name => art.get(name) || null;

/** Rect table of sheet `name` — available before any ray is marched. */
export const rectsOf = name => art.get(name)?.rects || null;

/**
 * Start (or reuse) the bake of sheet `name`. `onFrame(stillBaking)` is called
 * after every slice, so the editor can show the picture filling in — and once
 * more with `false` when the last sheet lands, which is the moment the
 * thumbnails are worth rebuilding.
 */
export function ensureArt(name, sheet, onFrame) {
  if (!art.has(name)) {
    art.set(name, sheetBaker(sheet, pal, 256));
    start(onFrame);
  }
  return art.get(name);
}

/** Forget a bake, so the next ensureArt re-marches it (a sheet was edited). */
export function dropArt(name) { art.delete(name); }

export const baking = () => [...art.values()].some(b => !b.done());

/** Fraction of every live bake that is done, 1 when nothing is baking. */
export function progress() {
  const all = [...art.values()];
  return all.length ? all.reduce((a, b) => a + b.progress(), 0) / all.length : 1;
}

// One loop for every unfinished bake, 8 ms a frame — the same budget a game's
// loading screen gives it, so the editor stays responsive while it fills in.
function start(onFrame) {
  if (pump) return;
  const tick = () => {
    for (const b of art.values()) if (!b.done()) b.step(8);
    const more = baking();
    onFrame?.(more);
    pump = more ? requestAnimationFrame(tick) : 0;
  };
  pump = requestAnimationFrame(tick);
}
