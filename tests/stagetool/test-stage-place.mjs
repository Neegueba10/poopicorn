// The stagetool's placement and selection power tools: drag-painted runs,
// the variant brush, Alt+drag duplication, the repeat array, align and
// distribute, select-similar, "box stamps", and a marquee/clipboard that
// carries collision boxes and objects along with the stamps.
//
// Every one of these exists because `delve` was built one click at a time —
// its ground is thirty individual placements — and because the marquee and
// the clipboard used to see stamps only.
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
      name: '_pl_ball',
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
      name: '_pl_sheet',
      sprites: [
        { model: '_pl_ball', view: {}, w: 8, h: 8 },
        { model: '_pl_ball', view: {}, w: 12, h: 12 },
      ],
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
  const clickId = id => b.evaluate(`document.getElementById('${id}').click(), 'ok'`);
  const key = (k, opts = '') => b.evaluate(
    `window.dispatchEvent(new KeyboardEvent('keydown', { key: '${k}'${opts} })), 'ok'`);
  const pick = (sel, v) => b.evaluate(`{
    const s = document.getElementById('${sel}');
    s.value = ${JSON.stringify(v)};
    s.dispatchEvent(new Event('change'));
    'ok'
  }`);
  const setVal = async (id, v) => {
    await b.evaluate(`document.getElementById('${id}').value = ${JSON.stringify(String(v))}, 'ok'`);
    await b.evaluate(`document.getElementById('${id}').dispatchEvent(new Event('input')), 'ok'`);
  };
  const reset = () => b.evaluate(`{
    Object.assign(stagetool.state, {
      layers: [{ rate: 1 }], stamps: [], aabbs: [], objects: [], sel: null,
      multi: [], multiA: [], multiO: [], variants: [], paintSpacing: 0,
      cam: [0, 0], snap: 1, locked: new Set(),
      hiddenLayers: [], lockedLayers: [], soloLayer: null,
      arm: { ...stagetool.state.arm, l: 0 }, l0: 0, l1: 1e9,
    });
    stagetool.emit();
    'ok'
  }`);

  await pick('sheet-select', '_pl_sheet');
  await sleep(700);

  const [gx, gy, gz, ox, oy] = await st(`(() => {
    const r = document.getElementById('display').getBoundingClientRect();
    return [r.left, r.top, stagetool.state.zoom, ...stagetool.state.origin];
  })()`);
  check('geometry sanity: zoom is 1', gz === 1);
  const at = (wx, wy) => [gx + (wx + ox + .5) * gz, gy + (wy + oy + .5) * gz];

  // =======================================================================
  // A — drag-painted runs
  // =======================================================================
  await reset();
  await clickId('sprite-0-0');       // arms the 8x8 and switches to the stamp tool
  await b.press(...at(0, 0));
  for (const x of [20, 40, 60, 80]) await b.move(...at(x, 0));
  await b.release(...at(80, 0));
  await sleep(200);
  const run = await st('stagetool.state.stamps.map(s => s.x)');
  check('a drag lays a run of stamps, not one', run.length === 5);
  check('the run is spread along the drag, in order',
    JSON.stringify(run) === '[0,20,40,60,80]');

  // an explicit gap wins over the sprite's own size
  await reset();
  await setVal('paint-spacing', '32');
  await b.press(...at(0, 0));
  for (const x of [8, 16, 24, 32, 40]) await b.move(...at(x, 0));
  await b.release(...at(40, 0));
  await sleep(200);
  check('the gap field controls the spacing',
    JSON.stringify(await st('stagetool.state.stamps.map(s => s.x)')) === '[0,32]');
  await setVal('paint-spacing', '0');

  // =======================================================================
  // B — the variant brush
  // =======================================================================
  await reset();
  await clickId('sprite-0-0');
  await b.evaluate(`{
    document.getElementById('sprite-0-1')
      .dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
    'ok'
  }`);
  await sleep(150);
  check('Shift-click adds a sprite to the variant brush',
    JSON.stringify(await st('stagetool.state.variants')) === '[[0,1]]');
  await b.evaluate(`{
    // 40 placements: both members appearing is certain enough to assert
    for (let n = 0; n < 40; n++) stagetool.addStamp(n * 20, 0, stagetool.brushSource());
    stagetool.emit();
    'ok'
  }`);
  await sleep(150);
  const ids = await st('[...new Set(stagetool.state.stamps.map(s => s.i))].sort()');
  check('the brush places both of its sprites', JSON.stringify(ids) === '[0,1]');
  await clickId('variants-clear');
  await sleep(100);
  check('"clear variants" empties the brush',
    await st('stagetool.state.variants.length') === 0);

  // =======================================================================
  // C — Alt+drag duplicates, Ctrl+D repeats
  // =======================================================================
  await reset();
  await b.evaluate(`{
    stagetool.state.stamps = [{ k: 0, i: 0, x: 100, y: 100, fx: 0, l: 0 }];
    stagetool.state.tool = 'select';
    stagetool.setMultiStamps([0]);
    stagetool.emit();
    'ok'
  }`);
  await sleep(150);
  await b.press(...at(104, 104), { modifiers: 1 });  // 1 = Alt
  await b.move(...at(144, 104), { modifiers: 1 });
  await b.release(...at(144, 104), { modifiers: 1 });
  await sleep(200);
  const dup = await st('stagetool.state.stamps.map(s => [s.x, s.y])');
  check('Alt+drag leaves the original behind and drags a copy',
    dup.length === 2 && dup[0][0] === 100 && dup[1][0] === 140);
  check('the copy is what stays selected',
    JSON.stringify(await st('stagetool.state.multi')) === '[1]');

  await setVal('rep-n', '3');
  await b.evaluate(`{ document.getElementById('rep-dx').value = '40'; 'ok' }`);
  await b.evaluate(`{ document.getElementById('rep-dy').value = '0'; 'ok' }`);
  await clickId('rep-go');
  await sleep(200);
  check('repeat duplicates the selection n times along the step',
    JSON.stringify(await st('stagetool.state.stamps.map(s => s.x)')) === '[100,140,180,220,260]');

  // =======================================================================
  // D — align, distribute, select-similar, box stamps
  // =======================================================================
  await reset();
  await b.evaluate(`{
    stagetool.state.layers = [{ rate: 1 }, { rate: 2 }];
    stagetool.state.stamps = [
      { k: 0, i: 0, x: 0, y: 10, fx: 0, l: 0 },
      { k: 0, i: 0, x: 50, y: 30, fx: 0, l: 0 },
      { k: 0, i: 1, x: 200, y: 70, fx: 0, l: 1 },
    ];
    stagetool.setMultiStamps([0, 1, 2]);
    stagetool.emit();
    'ok'
  }`);
  await sleep(150);
  await clickId('al-top');
  await sleep(150);
  check('align top puts every selected item on the group\'s top edge',
    JSON.stringify(await st('stagetool.state.stamps.map(s => s.y)')) === '[10,10,10]');

  await b.evaluate(`{
    stagetool.state.layers = [{ rate: 1 }];
    stagetool.state.stamps = [
      { k: 0, i: 0, x: 0, y: 0, fx: 0, l: 0 },
      { k: 0, i: 0, x: 10, y: 0, fx: 0, l: 0 },
      { k: 0, i: 0, x: 100, y: 0, fx: 0, l: 0 },
    ];
    stagetool.setMultiStamps([0, 1, 2]);
    stagetool.emit();
    'ok'
  }`);
  await sleep(150);
  await clickId('dist-x');
  await sleep(150);
  const spread = await st('stagetool.state.stamps.map(s => s.x)');
  check('spread x leaves the ends alone and evens the gaps',
    spread[0] === 0 && spread[2] === 100 && Math.abs(spread[1] - 50) <= 1);

  await b.evaluate(`{ stagetool.setMultiStamps([0]); stagetool.emit(); 'ok' }`);
  await sleep(120);
  await b.evaluate(`{ document.getElementById('sel-sprite').click(), 'ok' }`);
  await sleep(150);
  check('"same sprite" selects every stamp with that source',
    JSON.stringify(await st('stagetool.state.multi')) === '[0,1,2]');

  await b.evaluate(`{ stagetool.setMultiStamps([0]); stagetool.emit(); 'ok' }`);
  await sleep(120);
  await key('b');
  await sleep(200);
  check('B boxes the selected stamp at its exact bounds',
    JSON.stringify(await st('stagetool.state.aabbs[0]'))
    === '{"type":0,"x0":0,"y0":0,"x1":8,"y1":8}');

  // =======================================================================
  // E — the marquee and the clipboard carry boxes and objects too
  // =======================================================================
  await reset();
  await b.evaluate(`{
    stagetool.state.stamps = [{ k: 0, i: 0, x: 20, y: 20, fx: 0, l: 0 }];
    stagetool.state.aabbs = [{ type: 0, x0: 40, y0: 20, x1: 60, y1: 40 }];
    stagetool.state.objects = [{ x: 70, y: 30, k: -2, i: 0, fx: 0, kvs: [['hp', 3]] }];
    stagetool.state.tool = 'select';
    stagetool.emit();
    'ok'
  }`);
  await sleep(150);
  await b.drag(...at(10, 10), ...at(100, 60));
  await sleep(250);
  check('a marquee collects stamps, boxes and objects',
    await st('stagetool.state.multi.length') === 1
    && await st('stagetool.state.multiA.length') === 1
    && await st('stagetool.state.multiO.length') === 1);

  await key('c', ', ctrlKey: true');
  await sleep(120);
  await key('v', ', ctrlKey: true');
  await sleep(250);
  check('the clipboard pastes all three kinds together',
    await st('stagetool.state.stamps.length') === 2
    && await st('stagetool.state.aabbs.length') === 2
    && await st('stagetool.state.objects.length') === 2);
  check('the pasted object keeps its KV pairs',
    JSON.stringify(await st('stagetool.state.objects[1].kvs')) === '[["hp",3]]');

  await b.evaluate(`{ stagetool.setSelection([], [1], []); stagetool.emit(); 'ok' }`);
  await sleep(120);
  await b.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })), 'ok'`);
  await sleep(200);
  check('Delete removes a selected collision box',
    await st('stagetool.state.aabbs.length') === 1);

  console.log('console:', b.consoleMsgs.length ? b.consoleMsgs : '(clean)');
  if (b.consoleMsgs.length) fail++;
} finally {
  await b.close();
}

try { unlinkSync(SHEETS + '_pl_sheet.js'); } catch {}
try { unlinkSync(MODELS + '_pl_ball.js'); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
