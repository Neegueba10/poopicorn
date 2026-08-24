// The stagetool's parallax layers — the spine of the document since the
// stamps lost their `rate` and `depth`. A layer owns the parallax rate, and
// its POSITION in the list owns the draw order, so this suite pins both: that
// hide/lock/solo work, that re-planing keeps a stamp where it was on screen,
// that reordering layers and reordering stamps within one change the file's
// order, and that none of the editor-only parts of a layer reach the bytes.
import { unlinkSync } from 'node:fs';
import { launch } from '../cdp.mjs';
import { BASE, ROOT, sleep } from '../helpers.mjs';

const SHEETS = ROOT + 'src/js/sheets/';
const MODELS = ROOT + 'src/js/models/';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'ok ' : 'FAIL'} ${name}`); };

{
  const res = await fetch(BASE + '/api/save-model', {
    method: 'POST',
    body: JSON.stringify({
      name: '_sp_ball',
      parts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0],
      mats: [[0.9, 0.3, 0.3]],
      view: { scale: 2 },
    }),
  });
  if (!res.ok) throw new Error('fixture model: ' + await res.text());
}
{
  const res = await fetch(BASE + '/api/save-sheet', {
    method: 'POST',
    body: JSON.stringify({
      name: '_sp_sheet',
      sprites: [{ model: '_sp_ball', view: {}, w: 8, h: 8 }],
    }),
  });
  if (!res.ok) throw new Error('fixture sheet: ' + await res.text());
}

const b = await launch(BASE + '/stage');
try {
  for (let i = 0; i < 60; i++) {
    if (await b.evaluate(`typeof stagetool !== 'undefined' && stagetool.ready
      && document.getElementById('sheet-select').options.length > 1`).catch(() => false)) break;
    await sleep(200);
  }
  const st = async expr => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  const pick = (sel, v) => b.evaluate(`{
    const s = document.getElementById('${sel}');
    s.value = ${JSON.stringify(v)};
    s.dispatchEvent(new Event('change'));
    'ok'
  }`);

  await pick('sheet-select', '_sp_sheet');
  await sleep(600);

  // three layers — 0.5 (far), 1 (gameplay), 2 (near) — one stamp each, all at
  // the same world position, so only the layer tells them apart
  const seed = () => b.evaluate(`{
    Object.assign(stagetool.state, {
      layers: [{ rate: 0.5 }, { rate: 1 }, { rate: 2 }],
      stamps: [
        { k: 0, i: 0, x: 40, y: 40, fx: 0, l: 0 },
        { k: 0, i: 0, x: 40, y: 40, fx: 0, l: 1 },
        { k: 0, i: 0, x: 40, y: 40, fx: 0, l: 2 },
      ],
      aabbs: [], objects: [], sel: null, multi: [], multiA: [], multiO: [],
      hiddenLayers: [], lockedLayers: [], soloLayer: null, cam: [0, 0],
      l0: 0, l1: 1e9, arm: { k: 0, i: 0, fx: 0, l: 1 }, locked: new Set(),
    });
    stagetool.emit();
    'ok'
  }`);
  await seed();
  await sleep(200);

  // --- the panel ---
  check('one row per layer, in draw order',
    JSON.stringify(await st(`[...document.querySelectorAll('#layers .plane-row')].map(r => +r.dataset.rate)`))
    === '[0.5,1,2]');
  check('the panel shows where the actors draw',
    await st(`!!document.querySelector('#layers .split-row')`) === true);

  // --- hide / lock / solo ---
  await b.evaluate(`{ stagetool.toggleLayerHidden(0); stagetool.emit(); 'ok' }`);
  await sleep(150);
  check('a hidden layer is not visible',
    await st('stagetool.visible(stagetool.state.stamps[0])') === false
    && await st('stagetool.visible(stagetool.state.stamps[1])') === true);
  check('a hidden layer cannot be picked up either',
    await st('stagetool.pickable(0)') === false && await st('stagetool.pickable(1)') === true);
  await b.evaluate(`{ stagetool.toggleLayerHidden(0); stagetool.emit(); 'ok' }`);

  await b.evaluate(`{ stagetool.toggleLayerLocked(2); stagetool.emit(); 'ok' }`);
  await sleep(150);
  check('a locked layer still draws but cannot be picked',
    await st('stagetool.visible(stagetool.state.stamps[2])') === true
    && await st('stagetool.pickable(2)') === false);
  await b.evaluate(`{ stagetool.toggleLayerLocked(2); stagetool.emit(); 'ok' }`);

  await b.evaluate(`{ stagetool.toggleLayerSolo(1); stagetool.emit(); 'ok' }`);
  await sleep(150);
  check('solo leaves exactly one layer visible',
    JSON.stringify(await st('stagetool.state.stamps.map(s => stagetool.visible(s))'))
    === '[false,true,false]');
  await b.evaluate(`{ stagetool.layers.showAllLayers(); 'ok' }`);
  await sleep(150);
  check('"show all" clears both the solo and the hidden list',
    await st('stagetool.state.soloLayer') === null
    && await st('stagetool.state.hiddenLayers.length') === 0);

  // --- select every stamp on a layer ---
  await b.evaluate(`{
    const rows = [...document.querySelectorAll('#layers .plane-row')];
    rows.find(r => +r.dataset.layer === 1).querySelector('.plane-count').click();
    'ok'
  }`);
  await sleep(150);
  check('the count button selects that layer\'s stamps',
    JSON.stringify(await st('stagetool.state.multi')) === '[1]');

  // --- re-planing keeps the screen position ---
  // At camera 0,0 a stamp's screen position does not depend on its rate, so
  // move the camera first: that is the only state in which the correction
  // moveStampsToLayer applies is observable at all.
  await seed();
  await b.evaluate(`{
    stagetool.state.cam = [100, 50];
    stagetool.setMultiStamps([1]);
    stagetool.emit();
    'ok'
  }`);
  await sleep(150);
  const before = await st(`(() => {
    const s = stagetool.state.stamps[1], r = stagetool.layerRate(s.l);
    return [s.x - 100 * r, s.y - 50 * r];
  })()`);
  await b.evaluate(`{ stagetool.layers.replaneSelection(0); 'ok' }`);
  await sleep(200);
  const moved = await st('stagetool.state.multi');
  const afterPos = await st(`(() => {
    const i = stagetool.state.multi[0];
    const s = stagetool.state.stamps[i], r = stagetool.layerRate(s.l);
    return [s.x - 100 * r, s.y - 50 * r];
  })()`);
  check('re-planing keeps the stamp in the same place on screen',
    JSON.stringify(before) === JSON.stringify(afterPos));
  check('re-planing did change the layer',
    await st(`stagetool.state.stamps[stagetool.state.multi[0]].l`) === 0
    && moved.length === 1);

  // --- layer order is draw order, and moving a layer moves its stamps ---
  await seed();
  await sleep(150);
  check('the file groups stamps by layer, rate first',
    JSON.stringify(await st('stagetool.flatLayers()'))
    === '[[0.5,0,0,40,40,0],[1,0,0,40,40,0],[2,0,0,40,40,0]]');
  await b.evaluate(`{ stagetool.state.arm.l = 0; stagetool.layers.shiftLayer(1); 'ok' }`);
  await sleep(200);
  check('moving a layer forward moves its rate and its stamps together',
    JSON.stringify(await st('stagetool.flatLayers()'))
    === '[[1,0,0,40,40,0],[0.5,0,0,40,40,0],[2,0,0,40,40,0]]');
  check('and the armed layer follows the one that moved',
    await st('stagetool.state.arm.l') === 1);

  // --- stamp order within a layer ---
  await b.evaluate(`{
    Object.assign(stagetool.state, {
      layers: [{ rate: 1 }],
      stamps: [
        { k: 0, i: 0, x: 1, y: 0, fx: 0, l: 0 },
        { k: 0, i: 0, x: 2, y: 0, fx: 0, l: 0 },
        { k: 0, i: 0, x: 3, y: 0, fx: 0, l: 0 },
      ],
      sel: null, multi: [], multiA: [], multiO: [], locked: new Set(),
      arm: { k: 0, i: 0, fx: 0, l: 0 },
    });
    stagetool.setMultiStamps([0]);
    stagetool.emit();
    'ok'
  }`);
  await sleep(150);
  await b.evaluate(`{ stagetool.ui.orderStamps(1, true); 'ok' }`);   // to front
  await sleep(200);
  check('"bring to front" puts the stamp last in the layer, which is last drawn',
    JSON.stringify((await st('stagetool.flatLayers()'))[0]) === '[1,0,0,2,0,0,0,0,3,0,0,0,0,1,0,0]');
  check('the selection follows the stamp it moved, not its old index',
    JSON.stringify(await st('stagetool.state.multi')) === '[2]');
  await b.evaluate(`{ stagetool.ui.orderStamps(-1); 'ok' }`);
  await sleep(200);
  check('one step back moves it one place earlier',
    JSON.stringify(await st('stagetool.state.stamps.map(s => s.x)')) === '[2,1,3]');

  // --- editor-only parts never reach the file ---
  await b.evaluate(`{ stagetool.prefs.setLayerName(0, 'far ridge'); 'ok' }`);
  const text = await b.evaluate('stagetool.fileText()');
  check('a layer name never reaches the file', !text.includes('far ridge'));
  check('the file carries the rate and nothing else about a layer',
    text.includes('[S,[[1,'));

  console.log('console:', b.consoleMsgs.length ? b.consoleMsgs : '(clean)');
  if (b.consoleMsgs.length) fail++;
} finally {
  await b.close();
}

try { unlinkSync(SHEETS + '_sp_sheet.js'); } catch {}
try { unlinkSync(MODELS + '_sp_ball.js'); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
