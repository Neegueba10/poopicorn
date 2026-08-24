/**
 * palette.js — 256 colours, an RGB cube plus a grey ramp, from NO data at all.
 *
 * WHY A PALETTE AT ALL. The look. `sdf.js` shades in true colour and quantises
 * the result through an ordered dither and a scanline error carry, and that
 * last step is most of why these sprites read as pre-rendered rather than as
 * smooth 3D. Turning it off was built, measured at 96 B and declined
 * The palette stays; only its CONTENT changed.
 *
 * WHY IT IS NO LONGER AUTHORED. It used to be 192 hex digits sampled from
 * src/assets/palette.png — the dark and light end of 32 ramps, six shades
 * interpolated between — because a formula could not reproduce hue curves a
 * person chose. That reasoning belonged to the indexed era, when the palette
 * was the drawing surface and every stored pixel was one of its entries. On
 * the canvas stack nothing is drawn IN palette colours: a material is true
 * colour, the lights are true colour, and the palette is only the last hop.
 * What matters there is not taste but COVERAGE — how far the nearest entry is
 * from whatever colour the shading asks for — and a cube covers better than
 * any 32 authored hues, most visibly in the reds and purples the sampled
 * palette was thin on.
 *
 * SO THE DITHER DOES THE TASTE NOW. Rendered side by side on the game's own
 * sprites, the authored palette and this one are near enough indistinguishable
 * — the error carry is what smooths a ramp, not the ramp's authorship.
 *
 * 6 x 8 x 5 IS THE 2:4:1 WEIGHTING quant.js's `nearest` already uses: green
 * carries perceived luminance, blue barely registers, so green gets the levels
 * and blue gives them up. The 15 greys are on top because most of this art is
 * grey and the cube's own r = g = b diagonal is three coarse steps wide.
 *
 * NOT RAMP-STRUCTURED ANY MORE, and two things cared: `buildShadeRamp`'s
 * `rampSize` fast path (noodle.js only) and `sdf.js`'s `outline` (guarded by
 * `rampSize === 8`, and no game on this stack turns it on). `sdfsheet.js` no
 * longer claims the layout, so the outline pass declines rather than darkening
 * into a neighbouring colour. Pass `rampSize` yourself with a ramped palette.
 *
 * PORTABILITY. Imports nothing, touches no DOM.
 */

/**
 * @returns {Uint8Array} 768 bytes, RGB per entry
 */
export function genPalette() {
  const p = new Uint8Array(768);
  // Entry 0 stays black: it is the transparent one by convention here, and
  // every renderer takes `lo: 1` so the quantiser never picks it.
  let i = 3;
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 8; g++) {
      for (let b = 0; b < 5; b++) {
        p[i++] = r * 51;
        p[i++] = g * 255 / 7;
        p[i++] = b * 63.75;
      }
    }
  }
  for (let k = 0; k < 15; k++) {
    const v = k * 255 / 14;
    p[i++] = v;
    p[i++] = v;
    p[i++] = v;
  }
  return p;
}
