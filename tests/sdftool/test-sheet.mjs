/**
 * sdftool — the sheet tab, and the bake it drives.
 *
 * Headless Chrome rather than Node, because the sheet baker
 * (src/js/core/sdfsheet.js) bakes into a real canvas — and because the tool
 * previews through THAT baker rather than a copy, driving the page tests both
 * at once.
 *
 * The load-bearing assertions are about IDS. A sprite id is a position in the
 * sheet, a game stores those numbers, and deleting a sprite must therefore
 * leave a tombstone rather than shift everything after it. The suite deletes
 * from the middle and checks that the sprite after it did not move.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { launch } from '../cdp.mjs';
import { BASE, ROOT, sleep } from '../helpers.mjs';
import { bootCPU } from './boot.mjs';

const SHEETS = ROOT + 'src/js/sheets/';
const PROBE = '_probe';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const p = await launch(`${BASE}/sdf`);
const q = async expr => JSON.parse(await p.evaluate(expr));

/** Wait for the current bake to finish, or give up. */
async function baked(tries = 100) {
  for (let i = 0; i < tries; i++) {
    await sleep(100);
    if (await p.evaluate(`!!(window.sdftool && window.sdftool.sheetui.done())`)) return true;
  }
  return false;
}

try {
  // `ready`, not `window.sdftool`: the object is assigned before the sheet tab
  // has imported its models, and clicking a tab in that window does nothing.
  // The bake follows the same back end as the preview, and the margin check
  // measures baked pixels against `fit`'s prediction — which is the CPU
  // renderer's geometry. See boot.mjs.
  await bootCPU(p);

  // --- the tab --------------------------------------------------------------
  await p.evaluate(`document.getElementById('tab-sheet').click()`);
  await sleep(400);
  const tab = await q(`JSON.stringify({
    mode: window.sdftool.getMode(),
    canvas: !document.getElementById('sheetdisplay').hidden,
    model: document.getElementById('stage').hidden,
    models: document.querySelectorAll('#addfacings option').length })`);
  check('the sheet tab shows its own preview and hides the model one',
    tab.mode === 'sheet' && tab.canvas && tab.model);
  check(`the model list is offered (${tab.models - 1} models)`, tab.models > 1);

  // --- eight facings from one model ----------------------------------------
  await p.evaluate(`(()=>{const s=document.getElementById('addfacings');
    s.value='creature'; s.dispatchEvent(new Event('change'));})()`);
  await sleep(600);
  const facings = await q(`JSON.stringify({
    n: window.sdftool.sheet.sheet.slots.length,
    models: window.sdftool.sheet.sheet.slots.map(s => s.model),
    yaws: window.sdftool.sheet.sheet.slots.map(s => s.view.yaw),
    rows: document.querySelectorAll('#sprites .op-row').length })`);
  check('eight facings are eight slots over one model',
    facings.n === 8 && facings.models.every(m => m === 'creature') && facings.rows === 8);
  check('their yaws are one turn, evenly spaced',
    facings.yaws.every((y, i) => Math.abs(y - i / 8) < 1e-9));

  check('the bake finishes', await baked());
  const first = await q(`JSON.stringify({
    rects: window.sdftool.sheetui.rects(), hash: window.sdftool.sheetui.hash() })`);
  const rectOf = (r, id) => r.slice(id * 4, id * 4 + 4);
  check('every sprite got a rect of its own size',
    first.rects.length === 32
    && [0, 1, 2, 3, 4, 5, 6, 7].every(i => rectOf(first.rects, i)[2] === 48
      && rectOf(first.rects, i)[3] === 48));

  // Sprites sharing sheet space would bake over each other.
  let overlap = false;
  for (let a = 0; a < 8; a++) {
    for (let b = a + 1; b < 8; b++) {
      const [ax, ay, aw, ah] = rectOf(first.rects, a), [bx, by, bw, bh] = rectOf(first.rects, b);
      if (aw && bw && ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah) overlap = true;
    }
  }
  check('the packing does not overlap', !overlap);

  // The facings must differ: eight identical sprites is a view that is not
  // reaching the renderer, which reads as a working sheet of the wrong art.
  const distinct = await q(`(()=>{
    const c = window.sdftool.sheetui;
    const cv = document.getElementById('sheetdisplay').getContext('2d');
    const r = c.rects();
    const sig = id => {
      const d = cv.getImageData(r[id*4], r[id*4+1], r[id*4+2], r[id*4+3]).data;
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
      return h >>> 0;
    };
    return JSON.stringify(new Set([0,1,2,3,4,5,6,7].map(sig)).size);})()`);
  check(`the eight facings are eight different pictures (${distinct})`, distinct === 8);

  // --- the same bake twice --------------------------------------------------
  await p.evaluate(`document.getElementById('sbake').click()`);
  await sleep(200);
  check('the bake finishes again', await baked());
  const again = await q(`JSON.stringify({ hash: window.sdftool.sheetui.hash() })`);
  check('baking twice gives identical pixels', again.hash === first.hash);

  // --- tombstones -----------------------------------------------------------
  await p.evaluate(`(()=>{window.sdftool.sheet.deleteSlot(3);
    window.sdftool.sheetui.render();})()`);
  await sleep(300);
  check('the bake finishes after a delete', await baked());
  const tomb = await q(`JSON.stringify({
    n: window.sdftool.sheet.sheet.slots.length,
    slot3: window.sdftool.sheet.sheet.slots[3],
    yaw4: window.sdftool.sheet.sheet.slots[4].view.yaw,
    rects: window.sdftool.sheetui.rects() })`);
  check('deleting keeps the id and empties it', tomb.n === 8 && tomb.slot3 === null);
  check('the sprite after it did not move', Math.abs(tomb.yaw4 - 0.5) < 1e-9);
  check('a tombstone emits a zero rect',
    rectOf(tomb.rects, 3).every(v => v === 0) && rectOf(tomb.rects, 4)[2] === 48);

  // --- a per-sprite override ------------------------------------------------
  await p.evaluate(`(()=>{window.sdftool.sheet.setSlot(0, { w: 64, h: 64 });
    window.sdftool.sheet.setDial(0, 'scale', 2.4);
    window.sdftool.sheetui.render();})()`);
  await sleep(300);
  check('the bake finishes after a resize', await baked());
  const resized = await q(`JSON.stringify({
    rect: window.sdftool.sheetui.rects().slice(0, 4),
    eff: window.sdftool.sheet.effectiveView(window.sdftool.sheet.sheet.slots[0]),
    pitch: window.sdftool.sheet.models.get('creature')[2].pitch })`);
  check('a resized sprite gets the bigger rect', resized.rect[2] === 64 && resized.rect[3] === 64);
  // The dial the slot sets wins; the ones it does not set come from the model.
  // The inherited one is read from the model rather than written out here: it
  // is the art's number, and the art is free to change.
  check('an override wins over the model view, and the rest is inherited',
    resized.eff.scale === 2.4 && resized.eff.pitch === resized.pitch);

  // --- fit: the frame cropped to the art -----------------------------------
  // The test of a tight crop is not the numbers it wrote, it is what the baked
  // sprite looks like: the art whole, and the margin around it no wider than
  // the bound can promise. A square frame around a model that is not square
  // wastes far more than that on two sides, which is the waste this exists to
  // remove.
  //
  // THE MARGIN IS NOT ZERO AND CANNOT BE. `fit` is analytic — it never renders
  // — so it allows each part its whole `blend`, because a smooth union pushes
  // the surface out by roughly its softness and the bound has to hold for the
  // worst case rather than for this one. On a soft model that is several
  // pixels the art does not use, so the tolerance below is computed from the
  // model rather than guessed: pad, plus the largest blend in pixels.
  await p.evaluate(`(()=>{window.sdftool.sheet.sheet.sel = 0;
    window.sdftool.sheetui.render();})()`);
  await sleep(200);
  await p.evaluate(`document.getElementById('sfit').click()`);
  await sleep(300);
  check('the bake finishes after a fit', await baked());
  const fitted = await q(`JSON.stringify({
    slot: window.sdftool.sheet.sheet.slots[0],
    rect: window.sdftool.sheetui.rects().slice(0, 4) })`);
  check('fit writes the frame and where it looks',
    fitted.slot.view.vx !== undefined && fitted.slot.view.vy !== undefined
    && fitted.slot.view.scale > 0);
  check(`fit keeps the longest side (${fitted.slot.w}x${fitted.slot.h})`,
    Math.max(fitted.slot.w, fitted.slot.h) === 64);

  const margins = await q(`(()=>{
    const r = window.sdftool.sheetui.rects();
    const cv = document.getElementById('sheetdisplay');
    const d = cv.getContext('2d').getImageData(r[0], r[1], r[2], r[3]).data;
    let x0 = r[2], x1 = -1, y0 = r[3], y1 = -1;
    for (let y = 0; y < r[3]; y++) for (let x = 0; x < r[2]; x++) {
      if (!d[(y * r[2] + x) * 4 + 3]) continue;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    return JSON.stringify([x0, r[2] - 1 - x1, y0, r[3] - 1 - y1]);})()`);
  // pad (1) + the softest part's blend, in pixels at this sprite's density.
  const slack = await q(`(()=>{
    const s = window.sdftool.sheet.sheet.slots[0];
    const parts = window.sdftool.sheet.models.get(s.model)[0];
    let blend = 0;
    for (let i = 11; i < parts.length; i += 13) blend = Math.max(blend, parts[i]);
    const wpp = s.view.scale / Math.min(s.w, s.h);
    return JSON.stringify(1 + Math.ceil(blend / wpp));})()`);
  check(`the fitted sprite wastes no more than the bound allows`
    + ` (${margins.join(',')}, allowed ${slack})`,
    margins.every(m => m >= 0 && m <= slack));
  // And the art is WHOLE: a bound that is short crops, and a sprite cropped by
  // a pixel reads as a modelling mistake rather than as a fitting one.
  check('and the art is not cropped', margins.every(m => m >= 1));

  // --- fit set: one frame for the whole facing set -------------------------
  // Fitting eight facings one at a time gives eight frames, each centred on
  // its own art, so the model's origin lands in a different place in every
  // rect and the character shifts under itself as it turns. The set fit is the
  // union, and the check is that they all come out identical.
  await p.evaluate(`document.getElementById('sfitset').click()`);
  await sleep(300);
  check('the bake finishes after a set fit', await baked());
  const set = await q(`JSON.stringify(window.sdftool.sheet.sheet.slots
    .filter(Boolean).map(s => [s.w, s.h, s.view.vx, s.view.vy, s.view.scale]))`);
  check(`every sprite of the set shares one frame (${set[0][0]}x${set[0][1]})`,
    set.every(f => f.every((v, i) => v === set[0][i])));
  // And it must still hold the art: the union is the widest facing, so no
  // facing may now touch its edge.
  const setMargins = await q(`(()=>{
    const r = window.sdftool.sheetui.rects();
    const cv = document.getElementById('sheetdisplay').getContext('2d');
    let worst = 99;
    for (let id = 0; id < r.length / 4; id++) {
      if (!r[id * 4 + 2]) continue;
      const d = cv.getImageData(r[id*4], r[id*4+1], r[id*4+2], r[id*4+3]).data;
      const w = r[id*4+2], h = r[id*4+3];
      let x0 = w, x1 = -1;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++)
        if (d[(y * w + x) * 4 + 3]) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
      worst = Math.min(worst, Math.min(x0, w - 1 - x1));
    }
    return JSON.stringify(worst);})()`);
  check(`no facing touches the shared frame's edge (${setMargins} px clear)`,
    setMargins >= 0 && setMargins < 90);
  // What the file must round-trip through, now that both fits have run.
  const final = await q(`JSON.stringify(window.sdftool.sheet.sheet.slots[0])`);

  // --- save and load back ---------------------------------------------------
  await p.evaluate(`(()=>{const n=document.getElementById('sname');
    n.value=${JSON.stringify(PROBE)}; n.dispatchEvent(new Event('input'));
    document.getElementById('ssave').click();})()`);
  await sleep(700);
  const saved = await q(`JSON.stringify({ status: document.getElementById('status').textContent })`);
  check('saves', /^saved /.test(saved.status));

  const mod = await import(`${SHEETS}${PROBE}.js?v=${Date.now()}`);
  const sheet = mod.default;
  check('the saved file is a sprite list with a tombstone in it',
    Array.isArray(sheet) && sheet.length === 8 && sheet[3] === 0);
  check('a live entry is [model, view, w, h] with the model resolved',
    Array.isArray(sheet[0]) && Array.isArray(sheet[0][0][0])
    && sheet[0][2] === final.w && sheet[0][3] === final.h);

  await p.evaluate(`(()=>{window.sdftool.sheet.sheet.slots = [];
    window.sdftool.sheetui.render();})()`);
  await sleep(200);
  await p.evaluate(`window.sdftool.sheet.loadSheet(${JSON.stringify(PROBE)})
    .then(() => window.sdftool.sheetui.render())`);
  await sleep(800);
  const loaded = await q(`JSON.stringify({
    n: window.sdftool.sheet.sheet.slots.length,
    slot3: window.sdftool.sheet.sheet.slots[3],
    w0: window.sdftool.sheet.sheet.slots[0].w,
    scale0: window.sdftool.sheet.sheet.slots[0].view.scale,
    yaw4: window.sdftool.sheet.sheet.slots[4].view.yaw })`);
  check('loading restores the ids, the tombstone and the overrides',
    loaded.n === 8 && loaded.slot3 === null && loaded.w0 === final.w
    && loaded.scale0 === final.view.scale
    && Math.abs(loaded.yaw4 - 0.5) < 1e-9);

  // --- what the server refuses ---------------------------------------------
  const post = async sprites => {
    const res = await fetch(`${BASE}/api/save-sheet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: PROBE, sprites }),
    });
    return [res.status, await res.text()];
  };
  const ok = { model: 'creature', view: {}, w: 48, h: 48 };
  const [s1, m1] = await post([{ ...ok, model: 'nope' }]);
  check('server rejects a model that does not exist', s1 === 400 && /no model/.test(m1));
  const [s2] = await post([{ ...ok, w: 0 }]);
  check('server rejects a zero size', s2 === 400);
  const [s3] = await post([{ ...ok, w: 40.5 }]);
  check('server rejects a fractional size', s3 === 400);
  const [s4, m4] = await post([{ ...ok, view: { yaw: 'x' } }]);
  check('server rejects a view value that is not a number', s4 === 400 && /must be a number/.test(m4));
  const [s5] = await post([null, ok]);
  check('server accepts a leading tombstone', s5 === 200);

  // A model name is a file name, so it may hold a hyphen — which is not a
  // legal JS identifier. The written sheet must still parse.
  const [s6] = await post([{ ...ok, model: 'poppy-dead' }]);
  const hyphen = (await import(`${SHEETS + PROBE}.js?t=${Date.now()}`)).default;
  check('a hyphenated model name writes a sheet that parses',
    s6 === 200 && hyphen.length === 1 && Array.isArray(hyphen[0][0]));

  // --- the sheet the game ships --------------------------------------------
  // Compacted: no tombstones, because every id it holds was renumbered in
  // src/js/stages/farm.js at the same time. A tombstone reappearing here
  // means a delete went out without that migration.
  const props = (await import(`${ROOT}src/js/sheets/props.js`)).default;
  check('src/js/sheets/props.js carries no tombstones',
    props.length > 0 && props.every(s => Array.isArray(s) && s.length === 4));
} finally {
  await p.close();
  if (existsSync(SHEETS + PROBE + '.js')) unlinkSync(SHEETS + PROBE + '.js');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
