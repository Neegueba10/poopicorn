/**
 * sdfanim.js — turn a CLIP into ordinary sheet rows.
 *
 * A clip is one model, a frame count, and a dense table of numbers: one value
 * per animated field per frame. This module copies the model once per frame,
 * writes that frame's numbers into the copy, and hands back rows that
 * `sheetBaker` (or `sdfbake`) already knows how to bake. Nothing downstream
 * learns that animation exists — a frame is an ordinary sprite id.
 *
 * WHY THE TABLE IS DENSE AND NOT KEYFRAMED. A clip is 6 to 12 frames, so keys
 * and per-frame values cost about the same in numbers. Dense wins twice: the
 * run time copies instead of interpolating, and the editor is free to ease,
 * smooth or hold, because it samples the curve at save time. Easing costs zero
 * bytes here.
 *
 * THE FORMAT, `src/js/clips/<name>.js`:
 *
 *   [model, view, w, h, frames, fps, mode, channels]
 *
 *   model     the model, as imported from src/js/models/
 *   view      view overrides on top of the model's own, as a sheet row's are
 *   w h       the size every frame bakes at — one size for the whole clip, or
 *             the art shifts under itself as it plays
 *   frames    how many sprites the clip becomes
 *   fps mode  for the game. mode 0 loop, 1 pingpong, 2 once — core/Animation.js
 *             numbering. Neither is read here.
 *   channels  one row per animated field: [target, v0, v1, ... v(frames-1)]
 *             A NUMBER target is an index into the flat parts array,
 *             `part * 13 + column`. A STRING target is a view dial by name, so
 *             a spinning coin is a `yaw` channel rather than six posed models.
 *
 * The parts array is copied per frame, so the model itself is never touched and
 * a clip and a static sheet row can share one model.
 *
 * NO PLAYER SHIPS. The frame at time t is one line of arithmetic:
 *
 *   id0 + ((t * clip[5] / 1000) | 0) % clip[4]
 *
 * PORTABILITY. This imports nothing at all, touches no DOM, and runs in a
 * Worker and in Node — the same terms sdf.js keeps.
 */

/**
 * Expand `clip` into `frames` sheet rows, in frame order.
 *
 * @param {any[]} clip [model, view, w, h, frames, fps, mode, channels]
 * @returns {any[][]} rows of [model, view, w, h], ready to concatenate onto a
 *   sheet. The caller owns the ids: `const HERO0 = SHEET.length`.
 */
export function clipSheet(clip) {
  const [model, view, w, h, frames, , , channels] = clip;
  const rows = [];
  for (let f = 0; f < frames; f++) {
    const parts = model[0].slice();
    // The clip's own view first, then this frame's dials on top of it.
    const v = { ...view };
    for (const ch of channels) {
      const t = ch[0];
      if (typeof t == 'number') parts[t] = ch[f + 1];
      else v[t] = ch[f + 1];
    }
    // The model's own materials and its own default view come along unchanged:
    // a posed frame is the same asset in a different shape.
    rows.push([[parts, model[1], model[2]], v, w, h]);
  }
  return rows;
}
