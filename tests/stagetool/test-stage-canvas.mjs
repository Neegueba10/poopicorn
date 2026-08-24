// The stagetool's canvas host: the editor renders THROUGH core/stage.js's
// drawStage into a viewport canvas at world resolution, then scales that onto
// the display. This suite reads the viewport canvas back, so it pins what the
// editor actually draws — placement, parallax, the layer filter, the camera
// preview — and the fact that sprite thumbnails are cut from the real bake.
//
// The document-level editing behaviour is test-stage-basics.mjs; the runtime
// itself is test-stage-runtime.mjs.
import { unlinkSync } from 'node:fs';
import { launch } from '../cdp.mjs';
import { BASE, ROOT, sleep } from '../helpers.mjs';

const SHEETS = ROOT + 'src/js/sheets/';
const MODELS = ROOT + 'src/js/models/';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'ok ' : 'FAIL'} ${name}`); };

// A sphere that fills its frame, at one size — the cheapest thing that still
// puts ink on the canvas.
{
  const r = await fetch(BASE + '/api/save-model', {
    method: 'POST',
    body: JSON.stringify({
      name: '_sc_ball',
      parts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0],
      mats: [[0.9, 0.3, 0.3]],
      view: { scale: 2 },
    }),
  });
  if (!r.ok) throw new Error('could not save fixture model: ' + await r.text());
}
{
  const r = await fetch(BASE + '/api/save-sheet', {
    method: 'POST',
    body: JSON.stringify({
      name: '_sc_sheet',
      sprites: [{ model: '_sc_ball', view: {}, w: 8, h: 8 }],
    }),
  });
  if (!r.ok) throw new Error('could not save fixture sheet: ' + await r.text());
}

const b = await launch(BASE + '/stage');
try {
  for (let i = 0; i < 60; i++) {
    if (await b.evaluate(`typeof stagetool !== 'undefined' && stagetool.ready
      && document.getElementById('sheet-select').options.length > 1`).catch(() => false)) break;
    await sleep(200);
  }
  const st = async expr => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));

  await b.evaluate(`{
    const s = document.getElementById('sheet-select');
    s.value = '_sc_sheet';
    s.dispatchEvent(new Event('change'));
    'ok'
  }`);
  // the bake is real raymarching, so wait for it rather than for a fixed time
  for (let i = 0; i < 100; i++) {
    if (!(await st('stagetool.bake.baking()')) && (await st('stagetool.state.sheets.length'))) break;
    await sleep(100);
  }
  check('the sheet finished baking', await st('stagetool.bake.baking()') === false);

  // Read the viewport canvas back. Its content is world-resolution, so a world
  // point lands at (x - effCam) — with cam [0,0] that is just the centering
  // origin, floored the way drawStage floors it.
  await b.evaluate(`{
    window._ink = () => {
      const v = stagetool.canvas.view;
      const px = v.getContext('2d').getImageData(0, 0, v.width, v.height).data;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, n = 0;
      for (let y = 0; y < v.height; y++) for (let x = 0; x < v.width; x++) {
        if (!px[(y * v.width + x) * 4 + 3]) continue;
        n++;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
      return { n, box: x1 < 0 ? null : [x0, y0, x1, y1] };
    };
    'ok'
  }`);
  const ink = () => st('window._ink()');
  // A stamp has no rate of its own: it goes on a LAYER, and the layer has
  // the rate. `place` makes the layer it needs.
  const place = (k, i, x, y, rate, fx = 0) => b.evaluate(`{
    const st = stagetool.state;
    let l = st.layers.findIndex(L => L.rate === ${rate});
    if (l < 0) { st.layers.push({ rate: ${rate} }); l = st.layers.length - 1; }
    st.stamps.push({ k: ${k}, i: ${i}, x: ${x}, y: ${y}, fx: ${fx}, l });
    stagetool.emit();
    'ok'
  }`);
  const setState = patch => b.evaluate(`{
    Object.assign(stagetool.state, ${JSON.stringify(patch)});
    stagetool.canvas.blit();
    'ok'
  }`);
  const reset = () => b.evaluate(`{
    Object.assign(stagetool.state, {
      stamps: [], aabbs: [], objects: [], sel: null, multi: [],
      cam: [0, 0], layers: [{ rate: 1 }], l0: 0, l1: 1e9,
      hiddenLayers: [], lockedLayers: [], soloLayer: null,
    });
    stagetool.emit();
    'ok'
  }`);

  const [ox, oy] = await st('stagetool.state.origin');

  // --- placement ------------------------------------------------------------
  await reset();
  await place(0, 0, 100, 60, 1);
  await sleep(100);
  const one = await ink();
  const ex = Math.floor(100 + ox), ey = Math.floor(60 + oy);
  check('a placed stamp draws at its world position, offset by the camera pane',
    one.box && one.box[0] >= ex && one.box[2] <= ex + 7
    && one.box[1] >= ey && one.box[3] <= ey + 7 && one.n > 20);

  // --- parallax -------------------------------------------------------------
  await reset();
  await place(0, 0, 100, 60, 0.5);
  await sleep(100);
  const far0 = await ink();
  await setState({ cam: [40, 0] });
  await sleep(100);
  const far40 = await ink();
  check('moving the camera 40 px moves a rate-.5 layer 20 px on screen',
    far0.box && far40.box && far0.box[0] - far40.box[0] === 20
    && far0.box[1] === far40.box[1]);

  // --- the layer window -----------------------------------------------------
  await reset();
  await place(0, 0, 100, 60, 0.5);       // makes layer 1
  await sleep(100);
  await setState({ l0: 0, l1: 1 });
  await sleep(100);
  check('a stamp outside the layer filter is left out of the content pass',
    (await ink()).n === 0);
  await setState({ l0: 1, l1: 2 });
  await sleep(100);
  check('a stamp inside the layer filter comes back', (await ink()).n > 20);

  // --- hide and solo --------------------------------------------------------
  await reset();
  await place(0, 0, 100, 60, 0.3);       // makes layer 1
  await sleep(100);
  await setState({ hiddenLayers: [1] });
  await sleep(100);
  check('a hidden layer draws nothing', (await ink()).n === 0);
  await setState({ hiddenLayers: [], soloLayer: 0 });
  await sleep(100);
  check('a solo on another layer hides this one too', (await ink()).n === 0);
  await setState({ soloLayer: null });

  // --- the camera preview ---------------------------------------------------
  await reset();
  await b.evaluate(`stagetool.ui.toggleRuntimeView(), 'ok'`);
  await sleep(150);
  const [dw, dh, hidden] = await st(`[
    document.getElementById('display').width,
    document.getElementById('display').height,
    document.getElementById('left').style.display === 'none',
  ]`);
  check('Tab crops the display to exactly one game screen and hides the panels',
    dw === 480 && dh === 270 && hidden);
  await b.evaluate(`stagetool.ui.toggleRuntimeView(), 'ok'`);
  await sleep(150);
  check('leaving the preview restores the panels',
    await st(`document.getElementById('left').style.display === ''`));

  // --- thumbnails come from the bake ---------------------------------------
  const thumb = await st(`(() => {
    const c = stagetool.canvas.spriteThumb('_sc_sheet', 0);
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
    return [c.width, c.height, n];
  })()`);
  check('a sprite thumbnail is the baked sprite, scaled up whole',
    thumb[0] === 32 && thumb[1] === 32 && thumb[2] > 100);

  console.log('console:', b.consoleMsgs.length ? b.consoleMsgs : '(clean)');
  if (b.consoleMsgs.length) fail++;
} finally {
  await b.close();
}

try { unlinkSync(SHEETS + '_sc_sheet.js'); } catch {}
try { unlinkSync(MODELS + '_sc_ball.js'); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
