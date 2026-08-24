// Stagetool basics: sheet add/remove, stamp place/move/delete, the armed
// LAYER (which owns the parallax rate and the draw order — a stamp has
// neither), the eyedropper, the marquee, the AABB tool (drag-create + handle
// resize), object KV/sprite editing, save (disk byte-equals fileText() AND a
// hand-checked literal), load round trip, and server payload validation.
// Pixel-level draw correctness lives in test-stage-runtime.mjs (the runtime)
// and test-stage-canvas.mjs (the editor's canvas host) — this suite is the
// editor's document.
import { readFileSync, unlinkSync } from 'node:fs';
import { launch } from '../cdp.mjs';
import { BASE, ROOT, sleep } from '../helpers.mjs';

const SHEETS = ROOT + 'src/js/sheets/';
const MODELS = ROOT + 'src/js/models/';
const STAGES = ROOT + 'src/js/stages/';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : fail++; console.log(`${ok ? 'ok ' : 'FAIL'} ${name}`); };

// --- fixtures, saved BEFORE the page boots so the add picker lists them ---
// One sphere, and a sheet holding it twice at two sizes plus a tombstone.
// Sizes come from the BAKE's rect table, so 8x8 and 12x12 are what srcDims
// reports for ids 0 and 1.
{
  const res = await fetch(BASE + '/api/save-model', {
    method: 'POST',
    body: JSON.stringify({
      name: '_st_ball',
      parts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.9, 0, 0],
      mats: [[0.9, 0.3, 0.3]],
      view: { scale: 2 },
    }),
  });
  if (!res.ok) throw new Error('could not save fixture model: ' + await res.text());
}
{
  const res = await fetch(BASE + '/api/save-sheet', {
    method: 'POST',
    body: JSON.stringify({
      name: '_st_sheet',
      sprites: [
        { model: '_st_ball', view: {}, w: 8, h: 8 },
        { model: '_st_ball', view: {}, w: 12, h: 12 },
        null,
      ],
    }),
  });
  if (!res.ok) throw new Error('could not save fixture sheet: ' + await res.text());
}

const b = await launch(BASE + '/stage');
try {
  for (let i = 0; i < 60; i++) {
    if (await b.evaluate(`typeof stagetool !== 'undefined' && stagetool.ready
      && document.getElementById('sheet-select').options.length > 1`).catch(() => false)) break;
    await sleep(200);
  }

  const ev = (id, type) => b.evaluate(`document.getElementById('${id}').dispatchEvent(new Event('${type}')), 'ok'`);
  const setVal = async (id, v) => {
    await b.evaluate(`document.getElementById('${id}').value = ${JSON.stringify(String(v))}, 'ok'`);
    await ev(id, 'input');
  };
  const setChecked = async (id, v) => {
    await b.evaluate(`document.getElementById('${id}').checked = ${v}, 'ok'`);
    await ev(id, 'change');
  };
  const pick = (sel, v) => b.evaluate(`{
    const s = document.getElementById('${sel}');
    s.value = ${JSON.stringify(v)};
    s.dispatchEvent(new Event('change'));
    'ok'
  }`);
  const clickId = id => b.evaluate(`document.getElementById('${id}').click(), 'ok'`);
  const key = (k, opts = '') => b.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}'${opts} })), 'ok'`);
  const st = async expr => JSON.parse(await b.evaluate(`JSON.stringify(${expr})`));
  // reset the document (bypassing the 'new' button's confirm() dialog) while
  // keeping the loaded sheet — every section after the first starts from a
  // clean stamp/aabb/object slate
  const reset = () => b.evaluate(`{
    Object.assign(stagetool.state, {
      layers: [{ rate: 1 }], stamps: [], aabbs: [], objects: [],
      sel: null, multi: [], multiA: [], multiO: [],
      arm: { ...stagetool.state.arm, l: 0 }, l0: 0, l1: 1e9,
    });
    stagetool.emit();
    'ok'
  }`);
  // The armed layer is the plane the next placement lands on. Rebuilt here
  // rather than clicked, because the panel rows are what the layers suite is
  // about; this suite is about what a placement does with them.
  const setLayers = rates => b.evaluate(`{
    stagetool.state.layers = ${JSON.stringify(rates)}.map(rate => ({ rate }));
    stagetool.emit();
    'ok'
  }`);
  const armLayer = l => b.evaluate(`{ stagetool.state.arm.l = ${l}; stagetool.emit(); 'ok' }`);

  // --- add a sheet ---
  await pick('sheet-select', '_st_sheet');
  await sleep(600);
  check('added sheet is in state.sheets',
    JSON.stringify(await st('stagetool.state.sheets')) === '["_st_sheet"]');
  // sheetBaker packs in its constructor, so sizes are known before a single
  // ray is marched — the editor never waits on a bake to lay a stage out
  check('sprite sizes come from the rect table, tombstone included',
    JSON.stringify(await st('[stagetool.srcDims(0,0), stagetool.srcDims(0,1), stagetool.srcDims(0,2)]'))
    === '[[8,8],[12,12],[0,0]]');

  // canvas-click -> world-coordinate geometry: cam is [0,0] and zoom is 1 for
  // this whole suite (never changed), so a display-canvas client point maps to
  // a world coordinate via a fixed offset — state.origin, the camera pane's
  // centering offset within the (bigger) editor viewport.
  const [gx, gy, gz, ox, oy] = await st(`(() => {
    const r = document.getElementById('display').getBoundingClientRect();
    return [r.left, r.top, stagetool.state.zoom, ...stagetool.state.origin];
  })()`);
  check('geometry sanity: zoom is 1 (test assumes a 1:1 world<->display map)', gz === 1);
  const at = (wx, wy) => [gx + (wx + ox + .5) * gz, gy + (wy + oy + .5) * gz];
  // the STAMP TOOL places under the cursor in the ARMED RATE's world space
  // (placeFromEvent), so with the camera pane centered a non-1 armed rate
  // needs the origin term scaled by that rate too
  const placeAt = (wx, wy, rate) => [gx + (wx + ox * rate + .5) * gz, gy + (wy + oy * rate + .5) * gz];

  // =========================================================================
  // Section A — placement, rate/depth/flip persistence, eyedropper, drag,
  // delete, marquee bulk edit
  // =========================================================================
  await clickId('sprite-0-0');
  check('clicking a palette sprite arms it and switches to the stamp tool',
    await st('stagetool.state.tool') === 'stamp'
    && JSON.stringify(await st('[stagetool.state.arm.k, stagetool.state.arm.i]')) === '[0,0]');

  await b.click(...at(10, 10));
  await sleep(150);
  check('a placed stamp carries no rate and no depth, only its layer',
    JSON.stringify(await st('stagetool.state.stamps[0]'))
    === '{"k":0,"i":0,"x":10,"y":10,"fx":0,"l":0}');

  await setLayers([1, 0.5]);
  await armLayer(1);
  await b.click(...placeAt(50, 10, 0.5));
  await sleep(150);
  check('the armed layer is what the next placement lands on',
    JSON.stringify(await st('stagetool.state.stamps[1]'))
    === '{"k":0,"i":0,"x":50,"y":10,"fx":0,"l":1}');
  check('and the layer is where its parallax rate comes from',
    await st('stagetool.layerRate(stagetool.state.stamps[1].l)') === 0.5);

  await setChecked('arm-fx', true);
  await b.click(...placeAt(70, 10, 0.5));
  await sleep(150);
  check('flip toggles independently while the layer stays armed',
    JSON.stringify(await st('stagetool.state.stamps[2]'))
    === '{"k":0,"i":0,"x":70,"y":10,"fx":1,"l":1}');

  await b.click(...at(14, 14), { modifiers: 1 }); // alt, inside stamp 0's box
  await sleep(150);
  check('eyedropper adopts the clicked stamp\'s source, flip AND layer',
    JSON.stringify(await st('stagetool.state.arm'))
    === '{"k":0,"i":0,"fx":0,"l":0}');

  await clickId('tool-select');
  await b.drag(...at(14, 14), ...at(34, 34));
  await sleep(150);
  check('drag moves the selected stamp by the pointer delta',
    JSON.stringify(await st('[stagetool.state.stamps[0].x, stagetool.state.stamps[0].y]')) === '[30,30]');

  await b.click(...placeAt(74, 14, 0.5)); // the flipped stamp
  await sleep(100);
  await key('Delete');
  await sleep(150);
  check('delete removes the selected stamp',
    await st('stagetool.state.stamps.length') === 2
    && (await st('stagetool.state.stamps')).every(s => s.fx === 0));

  await clickId('tool-stamp');
  await armLayer(0);
  await setChecked('arm-fx', false);
  for (const x of [300, 320, 340]) { await b.click(...at(x, 5)); await sleep(100); }
  await clickId('tool-select');
  await b.drag(...at(295, 0), ...at(345, 15), { modifiers: 8 }); // shift
  await sleep(150);
  check('shift-drag marquees every stamp inside the box',
    await st('stagetool.state.multi.length') === 3);
  await setVal('insp-fx', '1');
  await sleep(150);
  check('the bulk inspector field edits every marqueed stamp',
    (await st('stagetool.state.stamps')).filter(s => s.x >= 300).every(s => s.fx === 1));
  check('the inspector offers no rate or depth field on a stamp',
    await st(`[!!document.getElementById('insp-rate'), !!document.getElementById('insp-depth')]`)
      .then(v => JSON.stringify(v)) === '[false,false]');

  // =========================================================================
  // Section B — AABB tool: drag-create, and a resize drag on a handle
  // =========================================================================
  // The click->world mapping above was measured once, so it is only valid
  // while the display canvas stays where it was. It is centered inside
  // #center, so ANYTHING that changes that pane's size — a status bar that
  // wraps to a second line, a panel that grows — moves it, and every
  // coordinate in this suite then lands somewhere else. Assert it here rather
  // than let the next section fail as if it were about AABBs.
  check('the display canvas has not moved since the mapping was measured',
    JSON.stringify(await st(`(() => {
      const r = document.getElementById('display').getBoundingClientRect();
      return [r.left, r.top, ...stagetool.state.origin];
    })()`)) === JSON.stringify([gx, gy, ox, oy]));

  await reset();
  await clickId('tool-aabb');
  await setVal('aabb-type', '2');
  await b.drag(...at(10, 10), ...at(19, 19));
  await sleep(150);
  check('dragging with the aabb tool creates a box (x1/y1 exclusive)',
    JSON.stringify(await st('stagetool.state.aabbs[0]'))
    === '{"type":2,"x0":10,"y0":10,"x1":20,"y1":20}');

  await clickId('tool-select');
  await b.click(...at(10, 10));
  await sleep(150);
  await b.drag(...at(19, 19), ...at(29, 29));
  await sleep(150);
  check('dragging a handle resizes the box',
    JSON.stringify(await st('stagetool.state.aabbs[0]'))
    === '{"type":2,"x0":10,"y0":10,"x1":30,"y1":30}');

  // =========================================================================
  // Section C — objects: placement, KV table, sprite assign/clear, nudge
  // =========================================================================
  await reset();
  await clickId('tool-object');
  await b.click(...at(50, 50));
  await sleep(150);
  check('placing an object with the object tool creates a bare marker',
    JSON.stringify(await st('stagetool.state.objects[0]'))
    === '{"x":50,"y":50,"k":-2,"i":0,"fx":0,"kvs":[]}');

  await clickId('object-kv-add');
  await sleep(100);
  await b.evaluate(`{
    const tds = document.querySelectorAll('#object-kv tr:nth-child(2) input');
    tds[0].value = 'hp'; tds[0].dispatchEvent(new Event('input'));
    tds[1].value = '5'; tds[1].dispatchEvent(new Event('input'));
    'ok'
  }`);
  await sleep(100);
  check('KV key/value inputs edit the object\'s kv pairs',
    JSON.stringify(await st('stagetool.state.objects[0].kvs')) === '[["hp",5]]');

  await clickId('object-src-btn');
  await clickId('sprite-0-1'); // sheet 0, sprite id 1, the 12x12
  await sleep(150);
  check('picking a sprite after "sprite..." assigns it to the object, not a new stamp',
    JSON.stringify(await st('[stagetool.state.objects[0].k, stagetool.state.objects[0].i]')) === '[0,1]'
    && await st('stagetool.state.stamps.length') === 0);
  await clickId('object-src-clear');
  await sleep(100);
  check('"clear" reverts the object to a bare marker',
    JSON.stringify(await st('[stagetool.state.objects[0].k, stagetool.state.objects[0].i]')) === '[-2,0]');

  await clickId('tool-select');
  await b.click(...at(50, 50));
  await sleep(100);
  await key('ArrowRight');
  await key('ArrowDown', ', shiftKey: true');
  await sleep(150);
  check('arrow keys nudge the selected object (1px, Shift = 8px)',
    JSON.stringify(await st('[stagetool.state.objects[0].x, stagetool.state.objects[0].y]')) === '[51,58]');
  await key('Delete');
  await sleep(150);
  check('delete removes the selected object', await st('stagetool.state.objects.length') === 0);

  // =========================================================================
  // Section D — a source in use cannot be removed (removing it would
  // renumber every k above it and silently repoint the stage)
  // =========================================================================
  await reset();
  await b.evaluate(`{ stagetool.state.arm = { k: 0, i: 0, fx: 0, l: 0 }; stagetool.state.tool = 'stamp'; stagetool.emit(); 'ok' }`);
  await b.click(...at(5, 5));
  await sleep(150);
  await b.evaluate(`document.querySelector('#sheet-list button').click(), 'ok'`);
  await sleep(150);
  check('removing a sheet a stamp still uses is refused',
    (await st('stagetool.state.sheets')).length === 1
    && (await b.evaluate(`document.getElementById('status').textContent`)).includes('still in use'));

  // =========================================================================
  // Section E — depth-sort-on-save, save (byte-equals fileText() AND a
  // hand-checked literal), and a load round trip
  // =========================================================================
  await b.evaluate(`{ document.getElementById('name').value = '_st_min'; stagetool.state.name = '_st_min'; 'ok' }`);
  // a second layer, and one stamp on each: the FILE's order is the layer
  // order, and within a layer the list order — nothing sorts
  await setLayers([1, 0.5]);
  await armLayer(1);
  await b.click(...placeAt(30, 5, 0.5));
  await sleep(150);
  check('stamps keep their placement order in state.stamps',
    JSON.stringify((await st('stagetool.state.stamps')).map(s => [s.x, s.l]))
    === '[[5,0],[30,1]]');
  check('flatLayers() groups them by layer, rate first',
    JSON.stringify(await st('stagetool.flatLayers()'))
    === '[[1,0,0,5,5,0],[0.5,0,0,30,5,0]]');

  await clickId('tool-aabb');
  await setVal('aabb-type', '0');
  await b.drag(...at(10, 10), ...at(19, 19));
  await sleep(150);

  await clickId('tool-object');
  await b.click(...at(50, 50));
  await sleep(100);
  await clickId('object-kv-add');
  await sleep(100);
  await b.evaluate(`{
    const tds = document.querySelectorAll('#object-kv tr:nth-child(2) input');
    tds[0].value = 'hp'; tds[0].dispatchEvent(new Event('input'));
    tds[1].value = '5'; tds[1].dispatchEvent(new Event('input'));
    'ok'
  }`);
  await sleep(100);

  await clickId('save');
  await sleep(500);
  const expected = "import _0 from '../sheets/_st_sheet.js';\n"
    + 'const S=[_0];\n'
    + 'export default [S,[[1,0,0,5,5,0],[0.5,0,0,30,5,0]],[0,10,10,20,20],'
    + '[50,50,-2,0,0,1,"hp",5]];\n';
  const text = readFileSync(STAGES + '_st_min.js', 'utf8');
  check('saved file byte-equals fileText()', text === await st('stagetool.fileText()'));
  check('generated file has the documented, hand-checked shape', text === expected);

  await b.evaluate(`{ stagetool.state.dirty = false; 'ok' }`); // don't prompt
  await pick('load-select', '_st_min');
  await sleep(900);
  check('load restores the sheet list',
    JSON.stringify(await st('stagetool.state.sheets')) === '["_st_sheet"]');
  check('load restores the layers with their rates',
    JSON.stringify(await st('stagetool.state.layers')) === '[{"rate":1},{"rate":0.5}]');
  check('load restores stamps in the saved order, each on its own layer',
    JSON.stringify(await st('stagetool.state.stamps'))
    === '[{"k":0,"i":0,"x":5,"y":5,"fx":0,"l":0},'
    + '{"k":0,"i":0,"x":30,"y":5,"fx":0,"l":1}]');
  check('load restores the aabb', JSON.stringify(await st('stagetool.state.aabbs[0]'))
    === '{"type":0,"x0":10,"y0":10,"x1":20,"y1":20}');
  check('load restores the object', JSON.stringify(await st('stagetool.state.objects[0]'))
    === '{"x":50,"y":50,"k":-2,"i":0,"fx":0,"kvs":[["hp",5]]}');
  check('a reloaded stage re-generates the same bytes', await st('stagetool.fileText()') === text);

  console.log('console:', b.consoleMsgs.length ? b.consoleMsgs : '(clean)');
  if (b.consoleMsgs.length) fail++;
} finally {
  await b.close();
}

// =========================================================================
// Section F — server validation (payloads the editor can't produce, but a
// hand-rolled POST could)
// =========================================================================
const post = body => fetch(BASE + '/api/save-stage', { method: 'POST', body: JSON.stringify(body) });
const ok = {
  name: '_st_bad', sheets: ['_st_sheet'],
  layers: [[1, 0, 0, 0, 0, 0]], aabbs: [0, 0, 0, 10, 10], objects: [],
};
const rejects = async (why, patch) => {
  const res = await post({ ...ok, ...patch });
  check(`server rejects ${why}`, res.status === 400);
};
check('server accepts a valid stage', (await post(ok)).ok);
await rejects('a bad name', { name: 'bad name!' });
await rejects('an unknown sheet', { sheets: ['_st_nope'] });
await rejects('a stamp sheet index out of range', { layers: [[1, 5, 0, 0, 0, 0]] });
await rejects('a stamp sprite id out of range', { layers: [[1, 0, 999, 0, 0, 0]] });
await rejects('a marker (k=-2) used as a stamp', { layers: [[1, -2, 0, 0, 0, 0]] });
await rejects('an out-of-range layer rate', { layers: [[9, 0, 0, 0, 0, 0]] });
await rejects('a layer with no rate', { layers: [[]] });
await rejects('a layer whose stamps are not stride 5', { layers: [[1, 0, 0, 0, 0]] });
await rejects('an invalid stamp flip', { layers: [[1, 0, 0, 0, 0, 2]] });
await rejects('an empty aabb (x1 <= x0)', { aabbs: [0, 10, 10, 10, 20] });
await rejects('an object with n out of range', { objects: [0, 0, -2, 0, 0, 99] });
await rejects('an object with a non-numeric kv value', { objects: [0, 0, -2, 0, 0, 1, 'k', 'nope'] });
// a tombstoned id is legal: it is in range and simply draws nothing
check('server accepts a stamp on a tombstoned sprite id',
  (await post({ ...ok, name: '_st_bad', layers: [[1, 0, 2, 0, 0, 0]] })).ok);
check('server accepts an empty layer (its POSITION is what later indices mean)',
  (await post({ ...ok, name: '_st_bad', layers: [[0.5], [1, 0, 0, 0, 0, 0]] })).ok);

for (const f of ['_st_min', '_st_bad']) { try { unlinkSync(STAGES + f + '.js'); } catch {} }
try { unlinkSync(SHEETS + '_st_sheet.js'); } catch {}
try { unlinkSync(MODELS + '_st_ball.js'); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
