/**
 * font.js — the bitmap font, inlined.
 *
 * The same 5x9 glyphs `SpriteFont` blits out of `src/img/palette.webp`, packed
 * into source so the canvas boot can drop that image entirely.
 *
 * `ctx.fillText` is not a substitute and was never meant to be one: it picks
 * whatever the machine happens to have, hints and antialiases at 8 px, and
 * lands on different pixels on different computers. A pixel font has to be
 * pixels.
 *
 * UPPERCASE ONLY. The 26 lowercase glyphs were dropped — 234 characters of row
 * data — and poppy.js speaks in capitals. `draw` advances a blank for anything
 * it does not have, so the OTHER games in src/js/games/ (delve, cliptest,
 * sdfcanvas, stagetest) still write lowercase and now render gaps. Uppercase
 * their strings if any of them is ever picked up again.
 *
 * ENCODING — one character per glyph ROW, five bits of it, from a 32-symbol
 * alphabet. That is LONGER than base64 and SMALLER after compression, because
 * a five-pixel row is the unit that repeats: a couple of dozen distinct row
 * patterns cover the whole alphabet, and `iiuii` — the waist of an A, an H, a
 * plus sign — turns up everywhere. Packing to bytes scatters those repeats
 * across byte boundaries where no compressor can see them. Worth knowing
 * before anyone "optimises" this into a tighter array.
 *
 * PORTABILITY — the data and the decode need nothing at all. `bakeFont` wants
 * a DOM, which is why it is a separate function: the packing stays testable in
 * Node.
 */

/**
 * THE PUNCTUATION IS BROKEN, AND KNOWN TO BE. Everything from '`' onward came
 * across mis-spaced from the strip in src/img/palette.webp — the glyphs are
 * sheared into each other, and re-packing from the image would only import the
 * same spacing error. Letters, digits and space are correct.
 *
 * They are fixed BY HAND, one at a time, as the game needs them. `$` is done:
 * the font's own S with a stem above and below it, which is why it reuses the
 * S's four row patterns and adds none — a row pattern that already occurs
 * elsewhere costs nothing after compression.
 *
 * Check a glyph before trusting it: `glyphBits(ch)` below returns its lit
 * pixels and needs no DOM, so a punctuation mark can be printed in Node.
 */

/** Glyph order, unchanged from SpriteFont so both read the same strip. */
export const FONT_CHARS =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'
  + '`~!@#$%^&*-=_+\\|;:\'",./?()[]{}<> ';

export const GLYPH_W = 5, GLYPH_H = 9;

/** 5 bits per row, 9 rows per glyph, in FONT_CHARS order. */
const ROWS = '0ciiuii000sisiis000ciggic000siiiis000ugsggu00'
  + '0ugsggg000cigmic000iiuiii000e4444e0006222ic00'
  + '0ikokii000gggggu000iuuiii000iqqmmi000ciiiic00'
  + '0sisggg000ciiiqc600sisoki000ci84ic000e4444400'
  + '0iiiiic000iiiccc000iiiuui000iiccii000iiic4400'
  + '0u248gu0004c4444000ci48gu000u242ic0004cku4400'
  + '0ugs2ic000cgsiic000u24488000ciciic000ciie2c00'
  + '0cimqic0008411000000ia40000089aa2a1022naqv2i0'
  + 'ggpihpjh04ci84ic40009hi288000hi99210003h28g80'
  + '00g0g300000003o3000000o0o0300011711o02211o000'
  + '00000gg880gghgghhi000100100011100000022200000'
  + '0ggg0011200000001000000112208bgg101000g9h1100'
  + '0ah0000ha011hhhh110h000000h0hhhihhhgr0000000r'
  + '0gghqhgg00ah000ha0000g8g000000000000';

const ALPHABET = '0123456789abcdefghijklmnopqrstuv';

/**
 * Bake every glyph into one offscreen canvas, in `css` colour.
 *
 * Baked rather than drawn per pixel for the same reason the sprites are: one
 * `drawImage` per character is the browser's work, and a rect per lit pixel is
 * ours. Text is redrawn every frame, so the difference is not academic.
 *
 * @param {string} [css] any canvas fill colour
 * @param {number} [scale] whole-number pixel size; 1 is the authored font
 * @returns {{ canvas: HTMLCanvasElement, w: number, h: number,
 *   draw(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void }}
 */
export function bakeFont(css = '#fff', scale = 1) {
  const n = FONT_CHARS.length;
  const w = GLYPH_W * scale, h = GLYPH_H * scale;
  const canvas = document.createElement('canvas');
  canvas.width = n * w;
  canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = css;
  for (let i = 0; i < n; i++) {
    for (let y = 0; y < GLYPH_H; y++) {
      const bits = ALPHABET.indexOf(ROWS[i * GLYPH_H + y]);
      for (let x = 0; x < GLYPH_W; x++) {
        // Bit 4 is the leftmost pixel: rows were packed most-significant first.
        if (bits & (16 >> x)) g.fillRect(i * w + x * scale, y * scale, scale, scale);
      }
    }
  }
  return {
    canvas,
    w,
    h,
    /** Left-aligned at (x, y); `\n` starts a new line. */
    draw(ctx, text, x, y) {
      let cx = x, cy = y;
      for (const ch of text) {
        if (ch === '\n') { cx = x; cy += h; continue; }
        const i = FONT_CHARS.indexOf(ch);
        // An unknown character advances without drawing, so a stray glyph
        // never shifts the rest of the line.
        if (i >= 0) ctx.drawImage(canvas, i * w, 0, w, h, cx, cy, w, h);
        cx += w;
      }
    },
  };
}

/** The lit pixels of glyph `ch` as a w*h array of 0/1 — the decode on its own,
 * so it can be checked without a DOM. */
export function glyphBits(ch) {
  const i = FONT_CHARS.indexOf(ch);
  if (i < 0) return null;
  const out = [];
  for (let y = 0; y < GLYPH_H; y++) {
    const bits = ALPHABET.indexOf(ROWS[i * GLYPH_H + y]);
    for (let x = 0; x < GLYPH_W; x++) out.push((bits & (16 >> x)) ? 1 : 0);
  }
  return out;
}
