/**
 * sdftool — the widgets that are drawn OUTSIDE the picture, pressed for real.
 *
 * THIS SUITE EXISTS BECAUSE THE OTHERS CANNOT CATCH THIS. They drive the tool
 * with `cv.dispatchEvent(new PointerEvent(...))`, which skips hit-testing
 * entirely: the event fires on the canvas whatever its coordinates say. So a
 * widget drawn somewhere no press can reach passed every test and did nothing
 * in a browser.
 *
 * It could reach a lot of them. The overlay covers the PANE, not the picture —
 * deliberately, so the camera cross stays in the corner of the window you are
 * working in — while the gestures listened on the picture. The cross was
 * therefore never grabbable at all, and a light's sun orbits at 1.45 bounding
 * radii, which leaves the frame for any model whose bounds are more than about
 * a third of `scale`. Both suns of `creature` sit outside it.
 *
 * Everything here presses through real CDP input, so the browser decides what
 * was hit. That is the only kind of check that can see this class of fault.
 */
import { launch } from '../cdp.mjs';
import { BASE, sleep } from '../helpers.mjs';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const p = await launch(`${BASE}/sdf`);
const q = async expr => JSON.parse(await p.evaluate(expr));

const RECT = `JSON.stringify(document.getElementById('display').getBoundingClientRect())`;
const inside = (r, x, y) => x > r.left && x < r.right && y > r.top && y < r.bottom;

/** A real press-move-release, not a dispatched event. */
async function realDrag(x, y, dx, dy, opts = {}) {
  await p.press(x, y, opts);
  await p.move(x + dx, y + dy, opts);
  await p.release(x + dx, y + dy, opts);
  await sleep(250);
}

try {
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (await p.evaluate('!!(window.sdftool && window.sdftool.ready)')) break;
  }

  // --- the camera cross ------------------------------------------------------
  const rect = await q(RECT);
  const w = await q('JSON.stringify(window.sdftool.canvas.debugViewWidget())');
  check(`the camera cross is outside the picture (${Math.round(w.rim.x)},`
    + `${Math.round(w.rim.y)} vs ${rect.left}..${rect.right})`,
    !inside(rect, w.rim.x, w.rim.y));

  const yaw0 = await q('JSON.stringify(window.sdftool.state.view.yaw)');
  await realDrag(w.rim.x, w.rim.y, 60, 0);
  const yaw1 = await q('JSON.stringify(window.sdftool.state.view.yaw)');
  check(`and a real drag on it still orbits (${yaw0} -> ${yaw1})`, yaw1 !== yaw0);

  const pan0 = await q('JSON.stringify(window.sdftool.state.view.vx ?? 0)');
  await realDrag(w.pan.x, w.pan.y, 25, 0);
  const pan1 = await q('JSON.stringify(window.sdftool.state.view.vx ?? 0)');
  check(`its middle still pans (vx ${pan0} -> ${pan1})`, pan1 !== pan0);

  // --- a light whose sun is off the picture ---------------------------------
  await p.evaluate(`[...document.querySelectorAll('#files .file-row')]
    .find(r => r.dataset.name === 'creature').click()`);
  await sleep(1200);
  await p.evaluate(`document.getElementById('mode-lights').click()`);
  await sleep(400);
  // The suns ride a sphere of `lightRadius() / scale`, so what pushes one off
  // the picture is the model's bounds against its zoom — not the art. Set the
  // zoom here instead of hoping the shipped creature still has it: this suite
  // is about the widget, and the model behind it gets reworked.
  await p.evaluate(`(()=>{window.sdftool.setDial('scale', 1.3);
    window.sdftool.emit();})()`);
  await sleep(400);

  const rect2 = await q(RECT);
  const suns = await q('JSON.stringify(window.sdftool.canvas.debugLights())');
  const out = suns.filter(s => !inside(rect2, s.x, s.y));
  check(`this model puts ${out.length} of 2 suns outside the picture`, out.length > 0);

  const s = out[0];
  // Inward, toward the model: outside the silhouette the gesture rides the rim
  // by design, which is a different thing from not working at all.
  const dx = s.cx - s.x, dy = s.cy - s.y, d = Math.hypot(dx, dy) || 1;
  const [mx, my] = [dx / d * 70, dy / d * 70];
  const before = await q('JSON.stringify(window.sdftool.state.view)');
  await realDrag(s.x, s.y, mx, my);
  const after = await q('JSON.stringify(window.sdftool.state.view)');
  const keys = s.which ? ['l2x', 'l2y', 'l2z'] : ['lx', 'ly', 'lz'];
  check('a real drag on a sun outside the picture aims the light',
    keys.some(k => after[k] !== before[k]));

  const moved = await q('JSON.stringify(window.sdftool.canvas.debugLights())');
  const g = moved.find(o => o.which === s.which);
  check(`and it stays under the pointer (${Math.round(g.x - s.x)},`
    + `${Math.round(g.y - s.y)} for ${Math.round(mx)},${Math.round(my)})`,
    Math.hypot(g.x - s.x - mx, g.y - s.y - my) < 4);

  // --- the ordinary path still works ----------------------------------------
  // Moving the listener from the picture to the pane must not have cost the
  // gesture that was already working.
  await p.evaluate(`document.getElementById('mode-lights').click()`);
  await sleep(200);
  const cx = (rect2.left + rect2.right) / 2, cy = (rect2.top + rect2.bottom) / 2;
  const sel0 = await q('JSON.stringify(window.sdftool.state.sel)');
  const p0 = await q('JSON.stringify([1,2,3].map(k => window.sdftool.get(window.sdftool.state.sel, k)))');
  await realDrag(cx, cy, 30, 0);
  const p1 = await q('JSON.stringify([1,2,3].map(k => window.sdftool.get(window.sdftool.state.sel, k)))');
  check(`a real drag on the model still moves a part (sel ${sel0} -> `
    + `${await q('JSON.stringify(window.sdftool.state.sel)')})`,
    p0.join() !== p1.join());

  // --- the viewport keeps its own gestures ----------------------------------
  // Both listeners now live on the pane, and the viewport's capture-phase
  // stopPropagation cannot stop a sibling listener on the same element once the
  // pane is the target. So the editor guards the two pan gestures itself.
  const yawA = await q('JSON.stringify(window.sdftool.state.view.yaw)');
  await realDrag(cx, cy, 40, 20, { button: 'middle', buttons: 4 });
  check('a middle-drag pans the viewport and does not orbit',
    await q('JSON.stringify(window.sdftool.state.view.yaw)') === yawA);

  await p.evaluate(`dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }))`);
  await realDrag(cx, cy, 40, 20);
  await p.evaluate(`dispatchEvent(new KeyboardEvent('keyup', { key: ' ', bubbles: true }))`);
  check('and neither does a space-drag',
    await q('JSON.stringify(window.sdftool.state.view.yaw)') === yawA);
} finally {
  await p.close();
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
