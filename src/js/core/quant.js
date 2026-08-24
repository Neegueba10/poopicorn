/**
 * quant.js — palette back end: colour space, nearest-colour lookup, shade
 * ramps and the ordered dither.
 *
 * Extracted from noodle.js so both renderers share it. This is the part that
 * makes an RGB render land on an indexed palette and still look like art, and
 * it is startlingly cheap: about 324 B gzipped for the lookup and the dither,
 * measured. It is the last place to go
 * looking for bytes.
 *
 * PORTABILITY CONTRACT. Same terms as noodle.js: imports nothing, touches no
 * DOM, assumes no palette size and no resolution. It runs in a Worker and in
 * Node. noodle.js's contract now reads "these two files", which is still a
 * thing you can lift into another project.
 *
 * Everything here is a pure function of a palette, so a renderer builds its
 * tables once in its constructor and never thinks about colour again.
 */

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

/** HSL to RGB, all components 0..1. Returns [r, g, b]. */
export function hslToRgb(h, s, l) {
  h = h - Math.floor(h);
  s = clamp01(s);
  l = clamp01(l);
  const chroma = s * (1 - Math.abs(2 * l - 1));
  const hi = l + chroma / 2, lo = l - chroma / 2;
  if (h < 1 / 6) return [hi, lo + chroma * h * 6, lo];
  if (h < 2 / 6) return [hi - chroma * (h - 1 / 6) * 6, hi, lo];
  if (h < 3 / 6) return [lo, hi, lo + chroma * (h - 2 / 6) * 6];
  if (h < 4 / 6) return [lo, hi - chroma * (h - 3 / 6) * 6, hi];
  if (h < 5 / 6) return [lo + chroma * (h - 4 / 6) * 6, lo, hi];
  return [hi, lo, hi - chroma * (h - 5 / 6) * 6];
}

/** RGB to HSL, all components 0..1. The editor needs this; the engine doesn't. */
export function rgbToHsl(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d < 1e-9) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h /= 6;
  return [h - Math.floor(h), s, l];
}

/**
 * Nearest palette index to (r, g, b), 0..1 each, searched over [lo, hi].
 *
 * The 2:4:1 weighting is the original's and is doing real work — plain
 * euclidean distance is visibly worse. Green dominates perceived luminance,
 * blue barely registers.
 */
export function nearest(pal, lo, hi, r, g, b) {
  let best = lo, bestD = Infinity;
  for (let c = lo; c <= hi; c++) {
    const dr = r - pal[c * 3] / 255;
    const dg = g - pal[c * 3 + 1] / 255;
    const db = b - pal[c * 3 + 2] / 255;
    const d = 2 * dr * dr + 4 * dg * dg + db * db;
    if (d < bestD) { bestD = d; best = c; }
  }
  return best;
}

/**
 * Mean lightness distance between neighbouring representable colours: walk
 * rays of increasing lightness through the palette and count how often the
 * nearest entry changes.
 *
 * This is the number the ordered dither's amplitude has to be scaled from, and
 * the obvious cheaper proxy — mean distance from a random RGB point to the
 * nearest entry — is wrong. It measures how much of the RGB cube the palette
 * fails to cover, which for any palette that does not fill the cube is
 * dominated by off-axis distance rather than by the step between adjacent
 * shades. Shading moves along lightness, so lightness is what to measure.
 *
 * Sanity-checked against a 16-level grey ramp, whose true step is 1/15 =
 * 0.0667: this returns 0.0714.
 */
export function lightnessStep(pal, lo, hi) {
  let sum = 0, rays = 0;
  for (let hq = 0; hq < 8; hq++) {
    for (let si = 0; si <= 2; si++) {
      let prev = -1, transitions = 0;
      for (let i = 0; i < 128; i++) {
        const rgb = hslToRgb(hq / 8, si / 2, i / 127);
        const c = nearest(pal, lo, hi, rgb[0], rgb[1], rgb[2]);
        if (prev >= 0 && c !== prev) transitions++;
        prev = c;
      }
      if (transitions) { sum += 1 / transitions; rays++; }
    }
  }
  return rays ? sum / rays : 0;
}

/**
 * Build the RGB -> palette index lookup, 32x32x32 (5 bits per channel).
 *
 * Picotron bakes this table into a file because building it there is ~10M VM
 * instructions and over a second of frozen startup. In JS it is 32768 cells
 * against a linear palette search, which is tens of milliseconds once — so
 * build it and ship no data.
 *
 * WHY 32 AND NOT MORE. Measured against an exact nearest-colour search over
 * the range of colours these pictures actually request, a 32-bin table picks a
 * different entry 13% of the time but costs only 1.1% more colour error;
 * 64 bins costs 0.3% for eight times the memory and seven times the build.
 * Neither matters, because the error from the palette simply not containing
 * the requested colour is around fifty times larger than either. Lookup
 * precision is not where the quality is. Dithering is.
 *
 * Sample points are bin CENTRES, (2i+1)/64, not edges.
 */
export function buildRgbLut(pal, lo, hi) {
  const lut = new Uint8Array(32768);
  for (let i = 0; i < 32; i++) {
    const r = (2 * i + 1) / 64;
    for (let j = 0; j < 32; j++) {
      const g = (2 * j + 1) / 64;
      for (let k = 0; k < 32; k++) {
        lut[(i << 10) | (j << 5) | k] =
          nearest(pal, lo, hi, r, g, (2 * k + 1) / 64);
      }
    }
  }
  return lut;
}

/**
 * Build the shade ramp: shadeRamp[c * 8 + k] is colour c darkened by (7 - k)
 * steps, so k === 7 is the colour unchanged and k === 0 is as dark as it goes.
 *
 * This table is what draws every outline, and the Picotron notes call the
 * equivalent "the single most visually load-bearing piece of data in the
 * cart". It was hand-authored there because a formula does not give you
 * yellow darkening through orange and brown rather than through grey.
 *
 * FAST PATH — `rampSize`. A palette laid out as N ramps of `rampSize` shades,
 * each ramp ordered dark to light, already IS this table. Darkening is then
 * arithmetic within the colour's own ramp, which is hue-aware by construction
 * and costs no data at all. This repo's 256-colour palette is 32 ramps of 8
 * (verified: every group of 8 increases strictly in luminance).
 *
 * DERIVED PATH — no `rampSize`. Walk each colour's lightness down in HSL and
 * take the nearest palette entry at each step. Works for any palette, gives up
 * the authored taste.
 */
export function buildShadeRamp(pal, n, lo, hi, rampSize) {
  const ramp = new Uint8Array(n * 8);
  for (let c = 0; c < n; c++) {
    for (let k = 0; k < 8; k++) {
      const steps = 7 - k;
      let out;
      if (rampSize) {
        const base = c - (c % rampSize);
        const pos = c % rampSize;
        out = base + Math.max(pos - steps, 0);
      } else {
        const hsl = rgbToHsl(pal[c * 3] / 255, pal[c * 3 + 1] / 255, pal[c * 3 + 2] / 255);
        const rgb = hslToRgb(hsl[0], hsl[1], hsl[2] * (1 - steps / 8));
        out = nearest(pal, lo, hi, rgb[0], rgb[1], rgb[2]);
      }
      // Never darken below the usable range. Index 0 is commonly the
      // transparent entry, and an outline that punches holes is not an
      // outline.
      ramp[c * 8 + k] = out < lo ? lo : out;
    }
  }
  return ramp;
}

//==============================================================================
// DITHER
//==============================================================================
// 4x4 Bayer, pre-centred to -0.5..+0.5 and in the same order RetroBuffer uses.
// Added to the requested colour before the lookup, so a value sitting between
// two palette entries lands on one or the other in a fixed spatial pattern
// instead of banding.
//
// Why this matters more than it did at 16 colours. Measured over the range of
// colours these renderers actually request, the 32x32x32 lookup adds only 1.1%
// to the quantisation error, and a 64x64x64 one would still leave 0.3% — while
// the error from the palette itself not containing the colour is fifty times
// larger. Lookup precision is not the lever. Spreading the residual is.
export const BAYER = new Float64Array([
  0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5,
].map(v => v / 16 - 0.46875));
