/**
 * sdftool — the sheet tab's widgets, pressed for real.
 *
 * The sheet tab could always edit a sprite's view by typing numbers into it.
 * What it could not do was aim: turning a sprite meant scrubbing `yaw`, and
 * lighting one meant guessing three components of a direction. These are the
 * model tab's own widgets, over a sprite's own rect — the same arcball, the
 * same camera cross, the same rules about which side a light is on.
 *
 * REAL CDP INPUT, for the reason `test-widgets.mjs` states at length: a
 * dispatched event fires on the element whatever its coordinates say, so a
 * widget drawn where no press can land would pass. Both of these widgets are
 * routinely outside the picture — the cross lives in the pane's corner, and a
 * sun orbits at 1.45 bounding radii — so that is the only check worth making.
 *
 * The fixture is BUILT IN MEMORY and never saved, so the suite leaves no files
 * behind. It is not the game's sheet on purpose: these assertions need a
 * facing set at ids 0-7 and a different model at 8, and `src/js/sheets/props.js`
 * is free to stop being that shape the moment the game wants other art.
 */
import { launch } from '../cdp.mjs';
import { BASE, sleep } from '../helpers.mjs';
import { waitFor } from './boot.mjs';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const p = await launch(`${BASE}/sdf`);
const q = async expr => JSON.parse(await p.evaluate(expr));

const slots = () => q('JSON.stringify(window.sdftool.sheet.sheet.slots)');
const sel = () => p.evaluate('window.sdftool.sheet.sheet.sel');
/** The view a sprite actually renders at — the model's, with the slot's
 * overrides on top. A dial with no override still has a value, so an assertion
 * about turning has to read this and not the override alone. */
const eff = id => q(`JSON.stringify(window.sdftool.sheet.effectiveView(
  window.sdftool.sheet.sheet.slots[${id}]))`);

/** Select a sprite the way the list does. A gesture that lands on the sheet
 * picks whatever is under it, so anything asserting about sprite N has to put
 * the selection back first. */
const select = async id => {
  await p.evaluate(`window.sdftool.sheet.sheet.sel = ${id}; window.sdftool.sheetui.render()`);
  await sleep(1500);
};
const lights = () => q('JSON.stringify(window.sdftool.sheetwidgets.debugLights())');
const widget = () => q('JSON.stringify(window.sdftool.sheetwidgets.debugViewWidget())');
const spriteAt = id => q(`JSON.stringify(window.sdftool.sheetwidgets.debugSpriteAt(${id}))`);

async function realDrag(x, y, dx, dy, opts = {}) {
  await p.press(x, y, opts);
  await p.move(x + dx, y + dy, opts);
  await p.release(x + dx, y + dy, opts);
  await sleep(300);
}

/** FNV-1a over one sprite's rect in the baked sheet — so "did only the sprite
 * I dragged change?" is a question with an answer. */
const rectHash = id => p.evaluate(`(() => {
  const s = window.sdftool.sheetui;
  const r = s.rects(), i = ${id} * 4;
  if (!r[i + 2]) return '';
  const cv = document.getElementById('sheetdisplay');
  const d = cv.getContext('2d').getImageData(r[i], r[i + 1], r[i + 2], r[i + 3]).data;
  let h = 0x811c9dc5;
  for (let k = 0; k < d.length; k++) { h ^= d[k]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16);
})()`);

try {
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (await p.evaluate('!!(window.sdftool && window.sdftool.ready)')) break;
  }
  await p.evaluate(`(async () => {
    window.sdftool.setMode('sheet');
    const S = window.sdftool.sheet;
    await S.loadModels(['creature', 'crate']);
    S.sheet.name = 'widgetfixture';
    S.sheet.slots = [
      ...Array.from({ length: 8 }, (_, i) => ({ model: 'creature', view: { yaw: i / 8 }, w: 48, h: 48 })),
      { model: 'crate', view: {}, w: 48, h: 48 },
    ];
    S.sheet.sel = 0;
    S.sheet.dirty = false;
    window.sdftool.sheetui.render();
  })()`);
  // Poll rather than sleep: a full sheet bake is a few hundred milliseconds on
  // an idle machine and several times that under a full suite run, so a fixed
  // wait fails only when everything else is running too.
  check('the sheet baked', await waitFor(p, 'window.sdftool.sheetui.done()', 30000));
  check('sprite 0 is selected', (await sel()) === 0);

  // --- the camera cross is reachable, and outside the sprite ------------------
  const w0 = await widget();
  const s0 = await spriteAt(0);
  check('the camera cross is drawn away from the sprite it aims',
    Math.hypot(w0.rim.x - s0.x, w0.rim.y - s0.y) > 40);

  // --- orbit, through the cross ----------------------------------------------
  let before = await slots(), beforeEff = await eff(0);
  await realDrag(w0.rim.x, w0.rim.y, 60, 40);
  let after = await slots(), afterEff = await eff(0);
  check('dragging the cross turns the selected sprite',
    after[0].view.yaw !== before[0].view.yaw && after[0].view.pitch != null);
  // The rest of the facing set must NOT follow. That is the whole point of a
  // per-sprite view, and the reason `apply to set` exists as a separate act.
  check('it turns that sprite only',
    JSON.stringify(after[1].view) === JSON.stringify(before[1].view));
  // Measured against the EFFECTIVE view: `pitch` had no override before this
  // drag, so the slot alone cannot say which way it moved.
  check('both axes push the near face (rightward is +yaw, downward is +pitch)',
    afterEff.yaw > beforeEff.yaw && afterEff.pitch > beforeEff.pitch);

  // --- pan, through the middle of the cross ----------------------------------
  before = await slots();
  const w1 = await widget();
  await realDrag(w1.pan.x, w1.pan.y, 12, 9);
  after = await slots();
  check('dragging the middle of the cross pans the sprite',
    after[0].view.vx !== (before[0].view.vx ?? 0)
    && after[0].view.vy !== (before[0].view.vy ?? 0));

  // --- dragging a sprite selects it and turns it -----------------------------
  const s8 = await spriteAt(8);            // the crate — a different model
  before = await slots();
  await realDrag(s8.x, s8.y, 50, 0);
  after = await slots();
  check('pressing a sprite selects it', (await sel()) === 8);
  check('and dragging from there turns it',
    after[8].view.yaw !== (before[8].view.yaw ?? undefined));

  // --- a hidden sun cannot be grabbed ----------------------------------------
  await select(0);
  check('the lights start hidden', !(await p.evaluate('window.sdftool.canvas.view.lights')));
  const hidden = await lights();
  await realDrag(hidden[0].x, hidden[0].y, 30, 20);
  after = await slots();
  check('a hidden sun is not grabbable — the press falls through to the sheet',
    after[0].view.lx == null);

  // --- aiming the key --------------------------------------------------------
  // That press fell through to the sheet, so it may well have picked a
  // different sprite. Put the selection back before asserting about sprite 0.
  await select(0);
  await p.evaluate("document.getElementById('slights').click()");
  await sleep(400);
  check('the lights switch turns them on in this tab',
    await p.evaluate('window.sdftool.canvas.view.lights'));
  check('and it is the SAME switch the model tab uses',
    await p.evaluate("document.getElementById('mode-lights').classList.contains('on')"));

  let ls = await lights();
  before = await slots();
  // Drag INWARD: outside the silhouette there is no sphere point to track and
  // the gesture rides the rim by design (lightwidget.js).
  await realDrag(ls[0].x, ls[0].y, Math.sign(ls[0].cx - ls[0].x) * 30,
    Math.sign(ls[0].cy - ls[0].y) * 30);
  after = await slots();
  check('dragging the key sun writes this sprite\'s own light direction',
    after[0].view.lx != null && after[0].view.ly != null && after[0].view.lz != null);
  check('the key is still a unit direction',
    Math.abs(Math.hypot(after[0].view.lx, after[0].view.ly, after[0].view.lz) - 1) < 0.01);
  check('aiming one sprite\'s light leaves the rest of the set alone',
    after[1].view.lx == null);

  // --- the fill, and the unlink ----------------------------------------------
  check('the fill still follows the key',
    await p.evaluate('window.sdftool.sheetwidgets.isFillLinked()'));
  ls = await lights();
  await realDrag(ls[1].x, ls[1].y, Math.sign(ls[1].cx - ls[1].x) * 25,
    Math.sign(ls[1].cy - ls[1].y) * 25);
  after = await slots();
  check('dragging the fill unlinks it', after[0].view.l2x != null);
  check('and relink lets it follow again', await (async () => {
    await p.evaluate("document.getElementById('srelink').click()");
    await sleep(600);
    const s = await slots();
    return s[0].view.l2x == null && await p.evaluate('window.sdftool.sheetwidgets.isFillLinked()');
  })());

  // --- flip: same place on screen, other side of the model --------------------
  const pre = (await lights())[0];
  await p.evaluate("document.getElementById('sflip0').click()");
  await sleep(600);
  const post = (await lights())[0];
  check('flip leaves the sun where it was on screen',
    Math.hypot(post.x - pre.x, post.y - pre.y) < 2.5);
  check('and puts it on the other side', post.behind !== pre.behind);

  // --- one drag re-bakes one sprite -------------------------------------------
  const h0 = await rectHash(0), h1 = await rectHash(1);
  ls = await lights();
  await realDrag(ls[0].x, ls[0].y, Math.sign(ls[0].cx - ls[0].x) * 22,
    Math.sign(ls[0].cy - ls[0].y) * 22);
  check('the dragged sprite is re-baked', (await rectHash(0)) !== h0);
  check('and no other sprite is touched', (await rectHash(1)) === h1);

  // --- apply to set ------------------------------------------------------------
  await p.evaluate("document.getElementById('sapplyset').click()");
  await sleep(2000);
  after = await slots();
  check('apply to set copies the lights onto every sprite of that model',
    after[1].view.lx === after[0].view.lx && after[7].view.lx === after[0].view.lx);
  check('it does not reach a different model',
    after[8].view.lx == null);
  check('and it leaves each facing its own yaw', after[1].view.yaw === after[0].view.yaw);

  // --- the document still writes a legal file ---------------------------------
  const text = await p.evaluate('window.sdftool.sheet.fileText()');
  check('the generated file carries the new dials',
    /lx: -?[\d.]+/.test(text) && /l2i|yaw/.test(text));
  check('the tombstone convention survives', !/undefined|NaN/.test(text));
} finally {
  console.log('\nconsole:', p.consoleMsgs.length ? p.consoleMsgs.join('\n') : '(clean)');
  await p.close();
}

process.exitCode = fail ? 1 : 0;
