/**
 * The view dials a sprite or a clip channel may override.
 *
 * A FILE OF ITS OWN, AND `.mjs` ON PURPOSE. The dev server validates a saved
 * sheet and a saved clip against this list, and it imports it rather than
 * keeping a copy — a duplicated list works until one of them gains a dial. The
 * server is CommonJS, so importing a bare `.js` from it makes Node reparse the
 * file and warn on every boot; `.mjs` states the module type outright. Same
 * shape as tools/dyntool/slots.mjs, and for the same reason.
 *
 * `sheet.js` re-exports all three, so nothing in the browser has to know this
 * file exists.
 */

/**
 * `vx`/`vy` move what the centre of the frame looks at, which is what a
 * non-square crop of off-centre art needs; `fit` writes all five at once.
 */
export const POV_DIALS = ['yaw', 'pitch', 'scale', 'vx', 'vy'];

/**
 * THE LIGHT DIRECTIONS ARE DIALS TOO, with a warning attached: **aim a light
 * on one sprite of a facing set and you have lit
 * that facing only**, so the character turns and the key jumps with it. That is
 * wrong for a facing set and right for a prop — a lamp lit from its own flame,
 * a sign catching the sun, one model baked twice under two different skies. So
 * the dial exists, the widget writes it (tools/sdftool/sheetwidgets.js), and
 * the panel offers "apply to set" for the case where you meant all eight.
 *
 * `lcam` IS THE OTHER ANSWER TO THAT WARNING, and the cheaper one: set it on
 * the MODEL and the directions are read against the camera, so every facing is
 * lit from the same side of the screen and the rows stay one number each.
 */
export const LIGHT_DIALS = ['lcam', 'lx', 'ly', 'lz', 'li', 'lw',
  'l2x', 'l2y', 'l2z', 'l2i', 'l2w'];

/**
 * `fog` AND THE THREE COLOURS ARE HERE FOR ATMOSPHERE ACROSS A STAGE. One model
 * baked twice — once clear for the foreground, once hazy and flat for the
 * parallax layer behind it — is two numbers on a row, not a second model.
 */
export const VIEW_DIALS = [...POV_DIALS, 'spec', 'ao', ...LIGHT_DIALS,
  'fog', 'fogr', 'fogg', 'fogb'];
