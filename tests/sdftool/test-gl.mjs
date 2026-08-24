/**
 * sdftool — the GPU back end against the CPU renderer, primitive by primitive.
 *
 * THIS SUITE IS THE ANTI-DRIFT MECHANISM. `tools/sdftool/glsl.js` is a second
 * copy of the field maths in `src/js/core/sdf.js` — a port, not a shared
 * implementation, because the two languages have nothing to share. Nothing
 * stops the two diverging except a check that renders the same model both ways
 * and compares the pixels. Change either one and run this.
 *
 * IT ASSERTS A TOLERANCE, NOT A HASH, and it is the only suite in the repo
 * that does. Two reasons, and both are permanent:
 *
 *   1. GPU floating point is not reproducible across vendors. `highp float` is
 *      32 bits against JS's 64; drivers fuse multiply-add, approximate
 *      `inversesqrt`, and choose their own `pow`. A last-bit difference moves
 *      where the march stops, which moves the normal, which moves the shade —
 *      and the palette lookup then rounds to a neighbouring index.
 *   2. Headless Chrome has no GPU. It renders through SwiftShader, which is
 *      not the renderer any user has, so pinning its output would assert on
 *      something nobody runs.
 *
 * What IS exact is the silhouette: a hit is a threshold on the march, not a
 * rounding of a colour, so a silhouette difference is a bug in the port rather
 * than float dust. That is asserted at zero.
 */
import { launch } from '../cdp.mjs';
import { BASE, sleep } from '../helpers.mjs';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

/** Ink pixels that may land on a different palette index. Set from what
 * SwiftShader actually does; raising it needs a measurement, not a hope. */
const TOLERANCE = 0.02;

const p = await launch(`${BASE}/sdf`);
const q = async expr => JSON.parse(await p.evaluate(expr));

/**
 * Render `parts` both ways at the same size and view, and count how the two
 * palette-index images differ. Runs entirely in the page, because that is
 * where both renderers live.
 */
const COMPARE = (parts, mats, view, size) => `(async () => {
  const { default: SDF } = await import('/src/js/core/sdf.js');
  const glr = window.sdftool.glr;
  const pal = window.sdftool.canvas.view.pal;
  const parts = ${JSON.stringify(parts)};
  const mats = ${JSON.stringify(mats)};
  const view = ${JSON.stringify(view)};
  const o = { lo: 1, rampSize: 8 };
  const g = glr.create(${size}, ${size}, pal, o);
  if (!g) return JSON.stringify({ skip: glr.unavailableReason() || 'no context' });
  const c = new SDF(${size}, ${size}, pal, o);
  const a = Uint8Array.from(c.render(parts, mats, view));
  const b = Uint8Array.from(g.render(parts, mats, view));
  let ink = 0, same = 0, mask = 0, ramp = 0;
  for (let i = 0; i < a.length; i++) {
    if (!a[i] && !b[i]) continue;
    if (!a[i] !== !b[i]) { mask++; continue; }
    ink++;
    if (a[i] === b[i]) same++;
    else if ((a[i] & ~7) === (b[i] & ~7)) ramp++;
  }
  return JSON.stringify({ ink, same, mask, ramp, cpuPx: c.px, gpuPx: g.px });
})()`;

/** One part of each kind, sized so it fills a useful part of the frame. */
const KINDS = [
  ['sphere', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0]],
  ['box', [1, 0, 0, 0, 0.05, 0.1, 0, 0.4, 0.3, 0.35, 0.05, 0, 0]],
  ['capsule', [2, 0, 0, 0, 0, 0, 0.1, 0.1, 0.35, 0, 0.18, 0, 0]],
  ['torus', [3, 0, 0, 0, 0.1, 0, 0, 0.4, 0, 0, 0.14, 0, 0]],
  ['cylinder', [4, 0, 0, 0, 0.08, 0, 0, 0.32, 0.36, 0, 0.04, 0, 0]],
  ['cone', [5, 0, 0, 0, 0.05, 0, 0, 0.4, 0.35, 0.12, 0.03, 0, 0]],
  ['octahedron', [6, 0, 0, 0, 0.1, 0.1, 0, 0.5, 0, 0, 0.03, 0, 0]],
  ['hex prism', [7, 0, 0, 0, 0.08, 0.2, 0, 0.4, 0.25, 0, 0.03, 0, 0]],
  ['ellipsoid', [8, 0, 0, 0, 0, 0.1, 0, 0.45, 0.3, 0.25, 0, 0, 0]],
  ['link', [9, 0, 0, 0, 0.05, 0, 0, 0.2, 0.22, 0, 0.09, 0, 0]],
  ['pyramid', [10, 0, -0.3, 0, 0, 0.1, 0, 0.4, 0.6, 0, 0.02, 0, 0]],
  ['capped torus', [11, 0, 0, 0, 0.1, 0, 0, 0.4, 0.6, 0.8, 0.12, 0, 0]],
  ['tri prism', [12, 0, 0, 0, 0.05, 0.15, 0, 0.5, 0.3, 0, 0.03, 0, 0]],
  // A plane is infinite and never grows the bounds, so it needs something to
  // slice — here it takes the top off a sphere.
  ['plane cut', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0,
    13 + 32, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0.25, 0.05, 0]],
];

const VIEW = { yaw: 0.12, pitch: 0.15, scale: 1.6, spec: 0.35, ao: 1 };
const MATS = [[0.55, 0.5, 0.45], [0.8, 0.4, 0.3]];

let skipped = '';

try {
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (await p.evaluate('!!(window.sdftool && window.sdftool.ready)')) break;
  }

  // --- the back end exists ----------------------------------------------------
  const probe = await q(COMPARE(KINDS[0][1], MATS, VIEW, 64));
  if (probe.skip) {
    // A machine with no usable WebGL2 is a supported machine — the tool falls
    // back and says so. Report it loudly rather than passing quietly.
    skipped = probe.skip;
    console.log(`SKIP  no GPU back end here (${probe.skip}) — the CPU path is`
      + ' the authority and its own suites still ran');
  } else {
    check('the GPU back end reports itself available',
      await p.evaluate('window.sdftool.glr.available()'));

    // --- every primitive ------------------------------------------------------
    for (const [name, parts] of KINDS) {
      const r = await q(COMPARE(parts, MATS, VIEW, 64));
      const off = (r.ink - r.same) / (r.ink || 1);
      check(`${name}: silhouette identical (${r.mask} px differ)`, r.mask === 0);
      check(`${name}: ${(100 * (1 - off)).toFixed(1)}% of ${r.ink} ink px identical`,
        r.ink > 50 && off <= TOLERANCE);
    }

    // --- the flags, which are where a port goes wrong --------------------------
    const FLAGS = [
      ['subtract', [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0],
        [0 + 32, 0.3, 0.2, 0.25, 0, 0, 0, 0, 0, 0, 0.3, 0.08, 1]].flat()],
      ['paint', [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0],
        [0 + 64, 0, -0.2, 0.3, 0, 0, 0, 0, 0, 0, 0.3, 0.2, 1]].flat()],
      ['mirror', [[2, 0.2, 0, 0, 0, 0, 0.08, 0.14, 0.3, 0, 0.12, 0, 0]].flat()],
      ['mirrored cut', [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0, 0],
        [0 + 32 + 128, 0.35, 0.1, 0.2, 0, 0, 0, 0, 0, 0, 0.22, 0.05, 1]].flat()],
      // A scatter expands in begin(), which BOTH renderers call — so this
      // checks that the expansion reaches the texture, not that it is right.
      ['scatter', [[256, 1337, -8, 0.4, 0.4, 0.4, 0.3, 0, 0, 0, 0.05, 0, 1],
        [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.16, 0.04, 0]].flat()],
    ];
    for (const [name, parts] of FLAGS) {
      const r = await q(COMPARE(parts, MATS, VIEW, 64));
      const off = (r.ink - r.same) / (r.ink || 1);
      check(`${name}: silhouette identical (${r.mask} px differ)`, r.mask === 0);
      check(`${name}: ${(100 * (1 - off)).toFixed(1)}% of ${r.ink} ink px identical`,
        r.ink > 50 && off <= TOLERANCE);
    }

    // --- the view dials the shader has to honour -------------------------------
    const DIALS = [
      ['fog', { ...VIEW, fog: 0.6, fogr: 0.3, fogg: 0.4, fogb: 0.6 }],
      ['a rim light', { ...VIEW, l2x: -0.5, l2y: 0.2, l2z: 0.8, l2w: 0, l2i: 0.7 }],
      ['a coloured key', { ...VIEW, lr: 1, lg: 0.7, lb: 0.4, li: 0.9, lw: 0.4 }],
      ['no occlusion', { ...VIEW, ao: 0 }],
      ['a cast shadow', { ...VIEW, shadow: 1 }],
      ['exposure and ambient', { ...VIEW, exposure: 1.2, amb: 0.3 }],
      ['an off-centre frame', { ...VIEW, vx: 0.15, vy: -0.12 }],
      ['an outline', { ...VIEW, outline: 1 }],
    ];
    const CREATURE = [
      0, 0, -0.1, 0, 0, 0, 0, 0, 0, 0, 0.42, 0, 1,
      2, -0.38, 0.02, 0, 0, 0, 0, -0.14, -0.22, 0, 0.11, 0.12, 1,
      2, 0.38, 0.02, 0, 0, 0, 0, 0.14, -0.22, 0, 0.11, 0.12, 1,
      64, 0, -0.18, 0.3, 0, 0, 0, 0, 0, 0, 0.26, 0.2, 0,
    ];
    for (const [name, view] of DIALS) {
      const r = await q(COMPARE(CREATURE, MATS, view, 64));
      const off = (r.ink - r.same) / (r.ink || 1);
      check(`${name}: silhouette identical (${r.mask} px differ)`, r.mask === 0);
      check(`${name}: ${(100 * (1 - off)).toFixed(1)}% of ${r.ink} ink px identical`,
        r.ink > 50 && off <= TOLERANCE);
    }

    // --- a non-square frame, which the sheet's `fit` produces ------------------
    const NS = await q(`(async () => {
      const { default: SDF } = await import('/src/js/core/sdf.js');
      const glr = window.sdftool.glr, pal = window.sdftool.canvas.view.pal;
      const o = { lo: 1, rampSize: 8 };
      const parts = ${JSON.stringify(CREATURE)}, mats = ${JSON.stringify(MATS)};
      const view = ${JSON.stringify(VIEW)};
      const g = glr.create(40, 72, pal, o), c = new SDF(40, 72, pal, o);
      const a = Uint8Array.from(c.render(parts, mats, view));
      const b = Uint8Array.from(g.render(parts, mats, view));
      let ink = 0, same = 0, mask = 0;
      for (let i = 0; i < a.length; i++) {
        if (!a[i] && !b[i]) continue;
        if (!a[i] !== !b[i]) { mask++; continue; }
        ink++; if (a[i] === b[i]) same++;
      }
      return JSON.stringify({ ink, same, mask });
    })()`);
    check(`a 40x72 frame: silhouette identical (${NS.mask} px differ)`, NS.mask === 0);
    check(`a 40x72 frame: ${(100 * NS.same / NS.ink).toFixed(1)}% of ${NS.ink} ink px identical`,
      NS.ink > 50 && (NS.ink - NS.same) / NS.ink <= TOLERANCE);

    // --- the limits fall back rather than lying --------------------------------
    check('a model with too many materials is refused by supports()',
      !(await p.evaluate(`window.sdftool.glr.supports([0,0,0,0,0,0,0,0,0,0,1,0,0],
        Array.from({length: 40}, () => [1, 1, 1]))`)));
    check('an ordinary model is accepted by supports()',
      await p.evaluate(`window.sdftool.glr.supports([0,0,0,0,0,0,0,0,0,0,1,0,0], [[1,1,1]])`));
  }

  // --- the toggle, which must work whether or not there is a GPU --------------
  await p.evaluate('window.sdftool.canvas.view.gpu = false');
  check('with the GPU off the preview reports the CPU back end',
    (await p.evaluate('window.sdftool.canvas.view.backend()')) === 'cpu');
  await p.evaluate('window.sdftool.canvas.view.gpu = true');
  check('with the GPU on the preview reports whichever back end is real',
    ['gpu', 'cpu'].includes(await p.evaluate('window.sdftool.canvas.view.backend()')));
} finally {
  console.log('\nconsole:', p.consoleMsgs.length ? p.consoleMsgs.join('\n') : '(clean)');
  await p.close();
}

if (skipped) console.log(`\n(GPU checks skipped: ${skipped})`);
process.exitCode = fail ? 1 : 0;
