/**
 * sdftool — the editor: parts, the inspector, the gestures, save and load.
 *
 * Unlike tests/sdftool/test-sdf.mjs (pure Node) this drives the real page in
 * headless Chrome, because what is under test is the editing surface over the
 * numeric model, not the renderer.
 *
 * The load-bearing assertion is the DRAG ROUND TRIP: drag a part 40 px right,
 * drag it back, and the numbers return exactly. The camera is orthographic, so
 * that is a property the projection guarantees — and if it ever stops holding,
 * the screen-to-world mapping has drifted and every gesture in the tool is
 * subtly lying.
 */
import { unlinkSync } from 'node:fs';
import { launch } from '../cdp.mjs';
import { BASE, ROOT, sleep, artifact } from '../helpers.mjs';
import { bootCPU, waitFor } from './boot.mjs';

const MODELS = ROOT + 'src/js/models/';
const PROBE = '_probe';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const p = await launch(`${BASE}/sdf`);
const q = async expr => JSON.parse(await p.evaluate(expr));

try {
  // Poll for the first completed render rather than sleeping a fixed amount:
  // a cold boot loads the module graph and builds a 32768-entry colour lookup
  // before the first frame, and a fixed wait raced it. The checks below read
  // `view.rb`, so this holds the tool on the CPU renderer — see boot.mjs.
  await bootCPU(p);

  // --- boots and renders ----------------------------------------------------
  const boot = await q(`JSON.stringify({
    parts: window.sdftool.count(),
    px: window.sdftool.canvas.view.rb.px,
    pal: window.sdftool.canvas.view.pal.length,
    rows: document.querySelectorAll('#parts .op-row').length })`);
  check('page boots with one part', boot.parts === 1 && boot.rows === 1);
  check(`the default model draws (${boot.px} px)`, boot.px > 500);
  check('palette generated, 256 entries', boot.pal === 768);

  // --- the panels put controls before prose ---------------------------------
  // The hints are documentation and they grew until they pushed "add part…" off
  // the bottom of the pane — a panel that documents controls you cannot reach.
  // So every help block folds away, and the menu has to be ON SCREEN at boot.
  const panels = await q(`JSON.stringify({
    open: [...document.querySelectorAll('details.help')].filter(d => d.open).length,
    helps: document.querySelectorAll('details.help').length,
    addBottom: document.getElementById('addpart').getBoundingClientRect().bottom,
    tall: innerHeight,
    wide: document.getElementById('addpart').offsetWidth
      <= document.getElementById('right').clientWidth,
    scatterBottom: document.getElementById('addscatter').getBoundingClientRect().bottom })`);
  check(`the help folds away by default (${panels.helps} blocks, ${panels.open} open)`,
    panels.helps >= 5 && panels.open === 0);
  check(`the add-part menu is on screen (${panels.addBottom.toFixed(0)} of ${panels.tall})`,
    panels.addBottom > 0 && panels.addBottom < panels.tall);
  check('and it fits its panel rather than widening it', panels.wide);
  // A scatter is not a primitive, so it is a button beside that menu rather
  // than its sixteenth entry — which is where it went unnoticed.
  check(`the scatter button is beside it and on screen (${panels.scatterBottom.toFixed(0)})`,
    panels.scatterBottom > 0 && panels.scatterBottom < panels.tall);

  // --- adding parts ---------------------------------------------------------
  await p.evaluate(`(()=>{const s=document.getElementById('addpart');
    s.value='2'; s.dispatchEvent(new Event('change'));})()`);
  await sleep(400);
  const added = await q(`JSON.stringify({
    n: window.sdftool.count(),
    kind: window.sdftool.kindOf(1),
    sel: window.sdftool.state.sel,
    rows: document.querySelectorAll('#parts .op-row').length })`);
  check('adding a capsule appends and selects it',
    added.n === 2 && added.kind === 2 && added.sel === 1 && added.rows === 2);

  // --- the inspector shows only the fields the primitive reads -------------
  // A sphere with editable half-extents is three inputs that do nothing.
  const fields = lbl => `[...document.querySelectorAll('#inspector .num')]
    .map(l => l.firstChild.textContent)`;
  const capFields = await q(`JSON.stringify(${fields()})`);
  await p.evaluate(`(()=>{window.sdftool.state.sel = 0; window.sdftool.emit();})()`);
  await sleep(300);
  const sphFields = await q(`JSON.stringify(${fields()})`);
  check('a capsule offers its axis fields', capFields.includes('axis x') && capFields.includes('radius'));
  check('a sphere offers only a radius',
    sphFields.includes('radius') && !sphFields.includes('axis x') && !sphFields.includes('half w'));

  // --- scrubbing a number ---------------------------------------------------
  const SCRUB = (label, dx) => `(async () => {
    const l = [...document.querySelectorAll('#inspector .num')]
      .find(e => e.firstChild.textContent === ${JSON.stringify(label)});
    const i = l.querySelector('input');
    const r = i.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = (t, cx) => new PointerEvent(t, { clientX: cx, clientY: y, button: 0,
      buttons: 1, bubbles: true, pointerId: 1 });
    i.dispatchEvent(ev('pointerdown', x));
    dispatchEvent(ev('pointermove', x + ${dx}));
    dispatchEvent(ev('pointerup', x + ${dx}));
    return JSON.stringify({ v: window.sdftool.get(0, 10) });
  })()`;
  const before = await q(`JSON.stringify({ v: window.sdftool.get(0, 10) })`);
  const scrubbed = await q(SCRUB('radius', 20));
  check(`dragging a number scrubs it (${before.v} -> ${scrubbed.v})`,
    Math.abs(scrubbed.v - (before.v + 20 * 0.01)) < 1e-6);
  const backed = await q(SCRUB('radius', -20));
  check('scrubbing back restores it exactly', Math.abs(backed.v - before.v) < 1e-9);

  // --- dragging a part in the viewport -------------------------------------
  // Orthographic, so screen delta maps to world delta with no depth term and
  // the round trip has to be exact.
  const DRAG = (dx, dy, mods = {}) => `(async () => {
    const cv = document.getElementById('display');
    const r = cv.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    cv.setPointerCapture = () => {};
    const ev = (t, ox, oy) => new PointerEvent(t, Object.assign(
      { clientX: x + ox, clientY: y + oy, button: 0, buttons: 1, bubbles: true, pointerId: 1 },
      ${JSON.stringify(mods)}));
    cv.dispatchEvent(ev('pointerdown', 0, 0));
    cv.dispatchEvent(ev('pointermove', ${dx}, ${dy}));
    cv.dispatchEvent(ev('pointerup', ${dx}, ${dy}));
    return JSON.stringify({ sel: window.sdftool.state.sel,
      p: [0,1,2].map(k => window.sdftool.get(window.sdftool.state.sel, k + 1)),
      yaw: window.sdftool.state.view.yaw });
  })()`;

  // Centre of the canvas is the model, so a plain drag grabs a part.
  const start = await q(`JSON.stringify({ p: [0,1,2].map(k => window.sdftool.get(0, k + 1)) })`);
  const dragged = await q(DRAG(40, 0));
  check(`dragging the model moves the selected part (x ${start.p[0]} -> ${dragged.p[0]})`,
    dragged.p[0] !== start.p[0]);
  const round = await q(DRAG(-40, 0));
  check('dragging back restores the position exactly',
    round.p.every((v, i) => Math.abs(v - start.p[i]) < 1e-9));

  // Shift-drag orbits instead, even with the pointer over the model.
  const yaw0 = await q(`JSON.stringify({ yaw: window.sdftool.state.view.yaw })`);
  const orbited = await q(DRAG(40, 0, { shiftKey: true }));
  check(`shift-drag orbits the camera (yaw ${yaw0.yaw} -> ${orbited.yaw})`,
    Math.abs(orbited.yaw - (yaw0.yaw + 40 * 0.0025)) < 1e-6);

  // BOTH ORBIT AXES PUSH THE NEAR FACE. Asserted on the projection rather than
  // on the sign of `pitch`, because the sign is a fact about sdf.js's basis and
  // the direction is a fact about the hand — and it was the two disagreeing
  // that made the vertical axis feel inverted.
  const nearFar = () => q(`(()=>{
    const c = window.sdftool.canvas;
    return JSON.stringify({ near: c.project(0, 0, -1)[1], far: c.project(0, 0, 1)[1],
      nearX: c.project(0, 0, -1)[0], pitch: window.sdftool.state.view.pitch });})()`);
  await p.evaluate(`{ Object.assign(window.sdftool.state.view, { yaw: 0, pitch: 0 });
    window.sdftool.canvas.restart(); 'ok' }`);
  const flat = await nearFar();
  await q(DRAG(0, 40, { shiftKey: true }));           // drag DOWN
  const down = await nearFar();
  check(`dragging down carries the near face down (screen y ${flat.near.toFixed(1)}`
    + ` -> ${down.near.toFixed(1)}, pitch ${down.pitch})`,
    down.near > flat.near && down.far < flat.far);
  await p.evaluate(`{ Object.assign(window.sdftool.state.view, { yaw: 0, pitch: 0 });
    window.sdftool.canvas.restart(); 'ok' }`);
  await q(DRAG(40, 0, { shiftKey: true }));           // drag RIGHT
  const right = await nearFar();
  check('and dragging right carries the near face right — the same rule on both axes',
    right.nearX > flat.nearX);

  // --- undo -----------------------------------------------------------------
  await p.evaluate(`document.getElementById('undo').click()`);
  await sleep(300);
  const undone = await q(`JSON.stringify({ n: window.sdftool.count() })`);
  check('undo steps back through the edits', undone.n >= 1);

  // --- save round-trip ------------------------------------------------------
  // The status line is shared with the renderer, and the undo above starts a
  // render. Let that one finish first, or its report lands on top of "saved"
  // and the check reads a race rather than the save.
  await waitFor(p, 'window.sdftool.canvas.view.settled()');
  await p.evaluate(`(()=>{const n=document.getElementById('name');
    n.value=${JSON.stringify(PROBE)}; n.dispatchEvent(new Event('input'));
    document.getElementById('save').click();})()`);
  await sleep(700);
  const saved = await q(`JSON.stringify({ status: document.getElementById('status').textContent })`);
  check('saves', /^saved /.test(saved.status));

  const back = (await import(`${MODELS}${PROBE}.js`)).default;
  check('the saved file is [parts, mats, view]',
    Array.isArray(back) && Array.isArray(back[0]) && Array.isArray(back[1])
    && back[0].length % 13 === 0 && back[0].length > 0);
  // It must actually render, not merely parse.
  const SDF = (await import(`${ROOT}src/js/core/sdf.js`)).default;
  const { genPalette } = await import(`${ROOT}src/js/core/palette.js`);
  const r = new SDF(48, 48, genPalette(), { lo: 1, rampSize: 8 });
  r.render(back[0], back[1], back[2]);
  let drawn = 0;
  for (let i = 0; i < r.col.length; i++) if (r.col[i]) drawn++;
  check(`the saved model renders in the runtime (${drawn} px)`, drawn > 100);

  // --- what the server refuses ---------------------------------------------
  const post = async body => {
    const res = await fetch(`${BASE}/api/save-model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: PROBE, mats: [[1, 1, 1]], ...body }),
    });
    return [res.status, await res.text()];
  };
  const [s1] = await post({ parts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0] });   // 12, not 13
  check('server rejects a bad stride', s1 === 400);
  const [s2, m2] = await post({ parts: [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0] });
  check('server rejects an unknown primitive', s2 === 400 && /not a primitive/.test(m2));
  const [s3, m3] = await post({ parts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 5] });
  check('server rejects a dangling material', s3 === 400 && /does not exist/.test(m3));
  const [s4] = await post({ parts: [33, 0, 0, 0, 0, 0, 0, 0.2, 0.2, 0.2, 0.1, 0, 0] });
  check('server accepts a legal subtract part', s4 === 200);
  const [s5] = await post({ parts: [64, 0, 0, 0, 0, 0, 0, 0.2, 0.2, 0.2, 0.1, 0.2, 0] });
  check('server accepts a legal paint part', s5 === 200);
  const [s6] = await post({ parts: [128, 0.3, 0, 0, 0, 0, 0, 0.2, 0.2, 0.2, 0.1, 0, 0] });
  check('server accepts a legal mirror part', s6 === 200);
  // The ceiling moved for the mirror and scatter bits; it is still a ceiling.
  const [s7, m7] = await post({ parts: [1024, 0, 0, 0, 0, 0, 0, 0.2, 0.2, 0.2, 0.1, 0, 0] });
  check('server refuses a kind above the flags', s7 === 400 && /out of range/.test(m7));

  // --- what the server refuses of a SCATTER --------------------------------
  // A header is not a shape: it copies the row after it. So what is checked is
  // what would break that — no template, a count that stalls the bake, a
  // material spread reaching past the table.
  const SC = 256;
  const TMPL = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.08, 0.02, 0];
  const head = (o = {}) => {
    const h = [SC, 1337, 12, 0.5, 0.5, 0.5, 0.2, 0, 0, 0, 0.03, 0, 0];
    for (const [k, v] of Object.entries(o)) h[k] = v;
    return h;
  };
  const [s8] = await post({ parts: [...head(), ...TMPL] });
  check('server accepts a scatter header and its template', s8 === 200);
  const [s9, m9] = await post({ parts: head() });
  check('server refuses a header with no template',
    s9 === 400 && /followed by its template/.test(m9));
  const [s10, m10] = await post({ parts: [...head(), ...head(), ...TMPL] });
  check('server refuses a header whose template is another header',
    s10 === 400 && /followed by its template/.test(m10));
  const [s11, m11] = await post({ parts: [...head({ 2: 0 }), ...TMPL] });
  check('server refuses a zero count', s11 === 400 && /count/.test(m11));
  const [s12, m12] = await post({ parts: [...head({ 2: 65 }), ...TMPL] });
  check('server refuses a count past the cap', s12 === 400 && /count/.test(m12));
  const [s13, m13] = await post({ parts: [...head({ 1: 0 }), ...TMPL] });
  check('server refuses seed 0, which degenerates the generator',
    s13 === 400 && /seed/.test(m13));
  const [s14, m14] = await post({ parts: [...head({ 12: 1 }), ...TMPL] });
  check('server refuses a material spread reaching past the table',
    s14 === 400 && /material/.test(m14));
  const [s15, m15] = await post({ parts: [...head({ 0: SC | 128 }), ...TMPL] });
  check('server refuses flags on the header — they belong on the template',
    s15 === 400 && /carries no other flag/.test(m15));
  // March cost is linear in part count, so the cap is on what the model
  // EXPANDS to and not on how many rows the file holds.
  const many = [];
  for (let k = 0; k < 5; k++) many.push(...head({ 1: k + 1, 2: 64 }), ...TMPL);
  const [s16, m16] = await post({ parts: many });
  check('server refuses a model that expands past the cap',
    s16 === 400 && /expands to 320 parts/.test(m16));

  // --- the material picker, driven by a REAL pointer -----------------------
  // Deliberately real presses rather than a dispatched click. The picker's
  // veil closed on any pointerdown inside it, so a swatch was torn out of the
  // DOM before its own click could fire and picking silently did nothing — and
  // a synthetic click, which skips pointerdown, sails straight past that.
  const mat0 = await q(`JSON.stringify(window.sdftool.state.mats[0])`);
  // scrollIntoView first: the side panels scroll, so an element that exists
  // can still be below the fold, and clicking its rect would land on whatever
  // is actually there.
  const at = sel => q(`(()=>{const b=document.querySelector(${JSON.stringify(sel)});
    if (!b) return 'null';
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });})()`);

  // A plain click PAINTS the selected part — the thing you do constantly.
  await p.evaluate(`(()=>{window.sdftool.pushUndo();
    window.sdftool.addMat([0.1, 0.9, 0.2]);
    window.sdftool.state.sel = 0; window.sdftool.emit();})()`);
  await sleep(300);
  const second = await at('#mats .swatch:nth-child(2)');
  await p.click(second.x, second.y);
  await sleep(300);
  const assigned = await q(`JSON.stringify({
    mat: window.sdftool.get(0, window.sdftool.COL.mat),
    on: [...document.querySelectorAll('#mats .swatch')].findIndex(b => b.classList.contains('on')),
    veil: !!document.querySelector('.picker-veil') })`);
  check('clicking a swatch paints the selected part', assigned.mat === 1);
  check('the swatch in use is marked', assigned.on === 1);
  check('and a plain click does not open the picker', !assigned.veil);

  // Editing what the colour IS is the double-click.
  await p.evaluate(`(()=>{window.sdftool.set(0, window.sdftool.COL.mat, 0);
    window.sdftool.emit();})()`);
  await sleep(200);
  const swatch = await at('#mats .swatch');
  await p.click(swatch.x, swatch.y);
  await p.click(swatch.x, swatch.y, { clickCount: 2 });
  await sleep(300);
  // The picker is the BROWSER's, in full RGB. Its dialog is native and cannot
  // be driven from CDP, so the gesture is checked as far as the tool owns it:
  // the double-click arms the input, and a change on it writes the material.
  const armed = await q(`JSON.stringify({
    input: !!document.getElementById('rgbpick'),
    type: (document.getElementById('rgbpick') || {}).type,
    armed: !!(document.getElementById('rgbpick') || {}).oninput })`);
  check('a double-click arms an rgb colour input', armed.input && armed.type === 'color'
    && armed.armed);

  // A colour the palette does NOT contain, on purpose: the material is a true
  // colour and only the rendered pixel has to be a palette entry.
  await p.evaluate(`(()=>{const i = document.getElementById('rgbpick');
    i.value = '#ff0080'; i.dispatchEvent(new Event('input'));})()`);
  await sleep(400);
  const picked = await q('JSON.stringify(window.sdftool.state.mats[0])');
  check(`picking writes the material (${picked.map(v => v.toFixed(2))})`,
    picked.join() !== mat0.join());
  check('exactly, without snapping it onto the palette',
    Math.abs(picked[0] - 1) < 1e-9 && Math.abs(picked[1]) < 1e-9
    && Math.abs(picked[2] - 128 / 255) < 1e-9);
  const inPal = await q(`(()=>{const m = window.sdftool.state.mats[0],
    p = window.sdftool.canvas.view.pal;
    for (let i = 0; i < 256; i++)
      if (Math.abs(p[i*3]/255 - m[0]) < 1e-9 && Math.abs(p[i*3+1]/255 - m[1]) < 1e-9
        && Math.abs(p[i*3+2]/255 - m[2]) < 1e-9) return JSON.stringify(i);
    return JSON.stringify(-1);})()`);
  check('and that colour is one the palette does not have', inPal < 0);
  // It still renders: shading is true colour and the quantiser catches it at
  // the end, so an out-of-gamut material draws rather than dropping out.
  const drew = await q(`(()=>{const rb = window.sdftool.canvas.view.rb;
    let n = 0; for (let i = 0; i < rb.col.length; i++) if (rb.col[i]) n++;
    return JSON.stringify(n);})()`);
  check(`and the model still draws with it (${drew} px)`, drew > 100);

  // --- the inlined font, baked to a real canvas ----------------------------
  // glyphBits is checked in Node; this checks the other half — that bakeFont
  // paints those bits the right way round on a canvas. A mirrored row order
  // would pass every Node assertion and render every letter backwards.
  const font = await q(`(async () => {
    const { bakeFont, FONT_CHARS, GLYPH_W, GLYPH_H } = await import('/src/js/core/font.js');
    const f = bakeFont('#fff');
    const g = f.canvas.getContext('2d');
    const i = FONT_CHARS.indexOf('A');
    const d = g.getImageData(i * GLYPH_W, 0, GLYPH_W, GLYPH_H).data;
    let art = '';
    for (let y = 0; y < GLYPH_H; y++) {
      for (let x = 0; x < GLYPH_W; x++) art += d[(y * GLYPH_W + x) * 4 + 3] ? '#' : '.';
      art += '\\n';
    }
    // and that it draws: text onto a scratch canvas must put ink down
    const c = document.createElement('canvas');
    c.width = 80; c.height = 12;
    const cc = c.getContext('2d');
    f.draw(cc, 'AB', 0, 0);
    const px = cc.getImageData(0, 0, 80, 12).data;
    let lit = 0;
    for (let k = 3; k < px.length; k += 4) if (px[k]) lit++;
    return JSON.stringify({ art, lit, w: f.canvas.width, h: f.canvas.height });
  })()`);
  check(`the baked strip is one row of glyphs (${font.w}x${font.h})`,
    font.w === 69 * 5 && font.h === 9);
  check('A bakes the right way round',
    font.art === '.....\n.##..\n#..#.\n#..#.\n####.\n#..#.\n#..#.\n.....\n.....\n');
  check(`drawing text puts ink down (${font.lit} px)`, font.lit > 20);

  await p.screenshot(artifact('sdftool.png'));
} finally {
  try { unlinkSync(MODELS + PROBE + '.js'); } catch {}
  console.log('console:', p.consoleMsgs.length ? p.consoleMsgs.join('\n') : '(clean)');
  if (p.consoleMsgs.length) fail++;
  await p.close();
}

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
