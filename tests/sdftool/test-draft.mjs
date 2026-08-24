/**
 * sdftool — the draft preview, and the frame it holds.
 *
 * The preview runs on two rules (tools/sdftool/canvas.js):
 *
 *   1. WHILE CHANGES ARE STILL ARRIVING, render a draft.
 *   2. NEVER PAINT A PARTIAL FRAME WHEN A FINISHED ONE EXISTS.
 *
 * THE ASSERTION THAT MATTERS MOST is that the draft path changes NO FINAL
 * PIXEL. A preview that settles on something slightly different after a drag
 * than after a typed number is worse than a slow one, because then you cannot
 * trust what you are looking at.
 *
 * The second is that the pane is never mostly empty while you drag. Before
 * this, a restart cleared the frame and refilled it from the top at 8 ms a
 * slice, so at 160 a drag showed the top fifth of the model and at 240 the top
 * twelfth. That is the fault the whole thing exists to fix, and the only honest
 * way to see it is to sample the canvas MID-DRAG.
 *
 * Real CDP input throughout: the drag ends at a window-level `pointerup`, and a
 * dispatched event would not exercise that the way a hand does.
 *
 * IT RUNS ON THE CPU RENDERER, and it has to: the draft is a workaround for a
 * slow full frame, so the GPU back end skips it entirely and every check here
 * would pass by describing a feature that never ran. See boot.mjs.
 */
import { launch } from '../cdp.mjs';
import { BASE, sleep } from '../helpers.mjs';
import { bootCPU } from './boot.mjs';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const p = await launch(`${BASE}/sdf`);
const q = async expr => JSON.parse(await p.evaluate(expr));

/** Covered pixels and a fingerprint of what is ON SCREEN — the display canvas,
 * not the renderer's buffer, because holding a frame is a painting decision and
 * the buffer cannot show it. */
const SHOT = `(() => {
  const c = document.getElementById('display');
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let n = 0, h = 0x811c9dc5;
  for (let i = 0; i < d.length; i += 4) if (d[i + 3]) n++;
  for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 0x01000193); }
  return JSON.stringify({ n, h: (h >>> 0).toString(16), w: c.width });
})()`;

/** Wait for a finished FULL frame. */
async function settled(tries = 120) {
  for (let i = 0; i < tries; i++) {
    await sleep(50);
    if (await p.evaluate('window.sdftool.canvas.view.settled()')) return true;
  }
  return false;
}

try {
  await bootCPU(p);

  // A model with enough in it that a full render is slow — this is the case
  // the feature is for, and the default sphere would hide every fault.
  await p.evaluate(`[...document.querySelectorAll('#files .file-row')]
    .find(r => r.dataset.name === 'creature').click()`);
  await sleep(600);
  await p.evaluate(`(()=>{const s=document.getElementById('size');
    s.value='240'; s.dispatchEvent(new Event('change'));})()`);
  check('a full frame arrives at 240', await settled());
  const base = await q(SHOT);
  check(`the settled frame is the full one (${base.w}x${base.w}, ${base.n} px)`,
    base.w === 240 && base.n > 2000);

  const rect = await q(
    `JSON.stringify(document.getElementById('display').getBoundingClientRect())`);
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;

  // --- rule 1: a drag renders drafts, and every frame of it is whole ---------
  const yaw0 = await q('JSON.stringify(window.sdftool.state.view.yaw ?? 0)');
  // Empty space, so this is an orbit rather than a part drag: it changes the
  // whole picture every frame, which is the worst case for the old behaviour.
  const sx = rect.left + 12, sy = rect.top + 12;
  await p.press(sx, sy);

  // A PRESS ALONE MUST NOT RE-RENDER. It selects, or takes hold of the camera;
  // it changes no pixel, and re-rendering threw away a finished picture to draw
  // the same one again.
  await sleep(120);
  const pressed = await q(SHOT);
  check(`a bare press changes nothing on screen (${pressed.h})`, pressed.h === base.h);

  const mid = [];
  let sawDraft = false;
  for (let i = 1; i <= 6; i++) {
    await p.move(sx + i * 14, sy + i * 5);
    await sleep(60);
    if (await p.evaluate('window.sdftool.canvas.view.drafting()')) sawDraft = true;
    mid.push(await q(SHOT));
  }
  check('a moving pointer puts the preview in draft', sawDraft);
  // THE HEADLINE. Every sample during the drag holds a picture, not the top
  // sliver of one.
  const worst = Math.min(...mid.map(m => m.n));
  check(`the pane never empties during a drag (worst ${worst} px of ${base.n})`,
    worst > base.n * 0.5);
  check('and the picture changes as the camera turns',
    new Set(mid.map(m => m.h)).size > 1);

  // --- rule 2: the held frame carries the swap ------------------------------
  await p.release(sx + 6 * 14, sy + 6 * 5);
  await sleep(60);
  const onRelease = await q(SHOT);
  // The full render at 240 is ~96 ms, so this lands mid-flight. What must be on
  // screen is the last DRAFT — the current pose, coarse — and never a blank.
  check(`nothing blanks on release (${onRelease.n} px)`, onRelease.n > base.n * 0.5);

  check('and a full frame follows', await settled());
  const after = await q(SHOT);
  const yaw1 = await q('JSON.stringify(window.sdftool.state.view.yaw ?? 0)');
  check(`the drag turned the camera (${yaw0} -> ${yaw1})`, yaw1 !== yaw0);
  check('the settled frame is not the draft that was held',
    after.h !== onRelease.h && after.w === 240);

  // --- the draft path changes no final pixel --------------------------------
  // Set the SAME yaw with no pointer anywhere near it, and the two must land on
  // the same bytes.
  await p.evaluate(`window.sdftool.state.view.yaw = 0;
    window.sdftool.canvas.restart(); window.sdftool.ui.render();`);
  await settled();
  await p.evaluate(`window.sdftool.state.view.yaw = ${yaw1};
    window.sdftool.canvas.restart(); window.sdftool.ui.render();`);
  await settled();
  const typed = await q(SHOT);
  check(`a dragged pose renders exactly what a typed one does (${after.h} vs ${typed.h})`,
    after.h === typed.h);

  // --- a scrubbed number takes the same path --------------------------------
  // Nothing in ui.js opted in: the rule is at the window, so a scrubber in the
  // inspector drafts for the same reason the canvas does.
  await p.evaluate(`window.sdftool.state.sel = 0; window.sdftool.emit();`);
  await settled();
  const box = await q(`(()=>{const i = document.querySelector('#inspector input[type=number]');
    const r = i.getBoundingClientRect();
    return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });})()`);
  await p.press(box.x, box.y);
  let scrubDraft = false, scrubWorst = Infinity;
  for (let i = 1; i <= 5; i++) {
    await p.move(box.x + i * 6, box.y);
    await sleep(60);
    if (await p.evaluate('window.sdftool.canvas.view.drafting()')) scrubDraft = true;
    scrubWorst = Math.min(scrubWorst, (await q(SHOT)).n);
  }
  await p.release(box.x + 30, box.y);
  check('scrubbing an inspector number drafts too, with no call site opting in',
    scrubDraft);
  check(`and that pane never empties either (worst ${scrubWorst} px)`,
    scrubWorst > base.n * 0.4);
  check('releasing anywhere settles it back to full', await settled());

  // --- the sheet holds its last bake ----------------------------------------
  await p.evaluate(`document.getElementById('tab-sheet').click()`);
  await sleep(400);
  await p.evaluate(`(()=>{const s=document.getElementById('addfacings');
    s.value='creature'; s.dispatchEvent(new Event('change'));})()`);
  for (let i = 0; i < 120; i++) {
    await sleep(100);
    if (await p.evaluate('window.sdftool.sheetui.done()')) break;
  }
  const SHEET = `(() => {
    const c = document.getElementById('sheetdisplay');
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3]) n++;
    return JSON.stringify(n);
  })()`;
  const baked = await q(SHEET);
  check(`the sheet bakes (${baked} px)`, baked > 2000);
  // Rebake, then look immediately: the previous sheet has to still be there
  // rather than eight sprites popping in one at a time.
  await p.evaluate(`document.getElementById('sbake').click()`);
  await sleep(80);
  const during = await q(SHEET);
  check(`and holds the last bake through the next one (${during} of ${baked} px)`,
    during > baked * 0.8);
} finally {
  await p.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
