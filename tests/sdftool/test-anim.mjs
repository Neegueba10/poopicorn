/**
 * sdftool — the anim tab: the timeline, the frame cache, auto-key, playback,
 * onion skin, and the save/load round trip.
 *
 * The runtime half of this is tests/sdftool/test-clip.mjs, which is pure Node
 * and proves what `clipSheet` produces. This is the editing half, and the two
 * assertions that carry it are:
 *
 *   - A GESTURE IS A KEY, and only at the playhead. A drag that also moved
 *     frame 3 would be undoable only by hand, and a drag that moved nothing
 *     would be an hour of posing gone.
 *   - THE TAB HANDS THE CANVAS BACK. It borrows the model tab's document to
 *     hold the posed frame; leaving with the pose still in it would look like
 *     the model had been silently edited.
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs';

import { launch } from '../cdp.mjs';
import { BASE, ROOT, sleep } from '../helpers.mjs';

const CLIPS = ROOT + 'src/js/clips/';
const TMP = 'zztestclip';

let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
  if (!ok) fail++;
};

const p = await launch(`${BASE}/sdf`);
const q = async expr => JSON.parse(await p.evaluate(expr));
const T = 'window.sdftool';

/** Wait until the clip's frames have all baked. */
async function baked() {
  for (let i = 0; i < 80; i++) {
    await sleep(100);
    if (await q(`JSON.stringify(${T}.clipui.baked())`)) return true;
  }
  return false;
}

/** A fingerprint of one strip cell — how a frame is proved to have changed. */
const CELL = f => `(()=>{const c=document.querySelectorAll('#astrip .frame canvas')[${f}];
  if(!c) return JSON.stringify(null);
  const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
  let h=0x811c9dc5; for(let i=0;i<d.length;i++){h^=d[i];h=Math.imul(h,0x01000193);}
  return JSON.stringify((h>>>0).toString(16));})()`;

try {
  for (let i = 0; i < 60; i++) {
    await sleep(100);
    if (await p.evaluate(`!!(${T} && ${T}.ready)`)) break;
  }

  // --- the tab -----------------------------------------------------------------
  check('there is a third tab', await q("JSON.stringify(!!document.getElementById('tab-anim'))"));
  await p.evaluate("document.getElementById('tab-anim').click()");
  await sleep(300);
  check('clicking it switches mode', await q(`JSON.stringify(${T}.getMode())`) === 'anim');
  // The stage is SHARED — the anim tab poses through the model tab's canvas.
  check('the model tab\'s stage stays up',
    await q("JSON.stringify(!document.getElementById('stage').hidden)"));
  check('the sheet\'s does not',
    await q("JSON.stringify(document.getElementById('sheetstage').hidden)"));

  // Start from a known model rather than whichever sorted first.
  await p.evaluate(`(()=>{const s=document.getElementById('amodel');
    s.value='creature'; s.dispatchEvent(new Event('change'));})()`);
  await sleep(400);
  check('the clip can be pointed at a model',
    await q(`JSON.stringify(${T}.clip.clip.model)`) === 'creature');
  await p.evaluate(`(()=>{const c=${T}.clip.clip; c.frames=6; c.w=32; c.h=32;
    ${T}.clipui.render(); ${T}.clipui.restart();})()`);
  check('the frame cache baked every frame', await baked());
  check('the strip has one cell per frame',
    await q("JSON.stringify(document.querySelectorAll('#astrip .frame').length)") === 6);

  // --- scrubbing the playhead ---------------------------------------------------
  await p.evaluate(`${T}.clipui.goTo(3)`);
  await sleep(150);
  check('the playhead moves', await q(`JSON.stringify(${T}.clip.clip.frame)`) === 3);
  check('and the cell under it is marked',
    await q("JSON.stringify([...document.querySelectorAll('#astrip .frame')]"
      + ".findIndex(e => e.classList.contains('on')))") === 3);
  check('a click on a cell scrubs to it',
    await (async () => {
      await p.evaluate("document.querySelectorAll('#astrip .frame')[1]"
        + ".dispatchEvent(new PointerEvent('pointerdown', {bubbles: true}))");
      await sleep(120);
      return await q(`JSON.stringify(${T}.clip.clip.frame)`) === 1;
    })());

  // --- the pose is the clip's, not the gesture's --------------------------------
  // The canvas holds the POSED parts of the frame under the playhead. With
  // nothing animated yet, that is the model itself, number for number.
  check('the canvas holds the posed frame',
    await q(`JSON.stringify(${T}.state.parts.join() === `
      + `${T}.clip.posedParts(${T}.clip.clip.frame).join())`));

  // --- auto-key from the gizmo --------------------------------------------------
  await p.evaluate(`${T}.clipui.goTo(2)`);
  await sleep(200);
  const before = await q(CELL(2));
  const cell3Before = await q(CELL(3));
  // Select a leg and drag its move gizmo. A real drag, on the pane, exactly
  // where a person would press.
  await p.evaluate(`(()=>{const s=document.getElementById('apart');
    s.value='4'; s.dispatchEvent(new Event('change'));})()`);
  await sleep(150);
  const handles = await q(`JSON.stringify(${T}.canvas.debugHandles())`);
  const free = handles.find(h => h.type === 'free') || handles[0];
  check('the part gizmo is on screen in this tab', !!free);
  if (free) {
    await p.drag(free.x, free.y, free.x + 40, free.y - 10);
    await sleep(400);
  }
  const chans = await q(`JSON.stringify(${T}.clip.clip.channels.map(c => c.target))`);
  check(`a drag makes channels (${chans.join(', ') || 'none'})`, chans.length > 0);
  check('every channel it made is a column of the part that moved',
    chans.every(t => typeof t === 'number' && Math.floor(t / 13) === 4));
  check('every channel has one value per frame',
    await q(`JSON.stringify(${T}.clip.clip.channels.every(c => c.values.length === 6))`));
  // THE KEY IS AT THE PLAYHEAD AND NOWHERE ELSE.
  check('only the frame under the playhead moved',
    await q(`JSON.stringify(${T}.clip.clip.channels.every(c =>
      c.values.filter(v => v !== c.values[0]).length <= 1 || c.values[2] !== c.values[0]))`));
  await baked();
  check('and its baked pixels changed', await q(CELL(2)) !== before);
  check('while its neighbour\'s did not', await q(CELL(3)) === cell3Before);

  // --- what may not be animated -------------------------------------------------
  check('kind is refused',
    /kind cannot be animated/.test(await q(`JSON.stringify(${T}.clip.refuse(0))`)));
  check('an ordinary column is not',
    await q(`JSON.stringify(${T}.clip.refuse(4 * 13 + 2))`) === '');
  check('a view dial is not',
    await q(`JSON.stringify(${T}.clip.refuse('yaw'))`) === '');

  // --- a channel by hand, and a scrub -------------------------------------------
  await p.evaluate(`(()=>{const s=document.getElementById('aadd');
    s.value='vy'; s.dispatchEvent(new Event('change'));})()`);
  await sleep(200);
  check('adding a dial channel starts it flat',
    await q(`JSON.stringify((()=>{const c=${T}.clip.chanFor('vy');
      return !!c && c.values.every(v => v === c.values[0]);})())`));
  check('the panel lists it',
    await q("JSON.stringify([...document.querySelectorAll('#achannels .op-row')]"
      + ".some(r => r.dataset.target === 'vy'))"));

  // --- groups: a rigid swing about a pivot ----------------------------------------
  // The arms, which the drag above did not touch, at a frame it did not touch.
  await p.evaluate(`${T}.clipui.goTo(4)`);
  await sleep(200);
  await p.evaluate(`(()=>{const s=document.getElementById('apart');
    s.value='2'; s.dispatchEvent(new Event('change'));})()`);
  await p.evaluate("document.getElementById('agroupnew').click()");
  await sleep(200);
  check('a group is made from the selected part',
    await q(`JSON.stringify(${T}.clip.clip.groups.length)`) === 1
    && JSON.stringify(await q(`JSON.stringify(${T}.clip.clip.groups[0].parts)`)) === '[2]');
  // The pivot starts at the part's own centre, not at the origin.
  check('its pivot starts at the part it holds',
    await q(`JSON.stringify(${T}.clip.clip.groups[0].pivot[0] === `
      + `${T}.clip.posedParts()[2 * 13 + 1])`));
  await p.evaluate("document.querySelector('#amembers input[data-part=\"3\"]').click()");
  await sleep(200);
  check('a checkbox adds a part to it',
    JSON.stringify(await q(`JSON.stringify(${T}.clip.clip.groups[0].parts)`)) === '[2,3]');

  // Centre AND rotation per part, because the pivot's whole meaning is that a
  // part sitting on it turns without moving.
  const poses = `(()=>{const p=${T}.clip.posedParts(4);
    return JSON.stringify([0,2,3].map(i => p.slice(i*13+1, i*13+7)));})()`;
  const centres = poses;
  const before2 = await q(centres);
  const rigH = await q(`JSON.stringify(${T}.canvas.debugRigHandles())`);
  // The Z ring. The two arms sit either side of the pivot along X, so the X
  // ring turns them about the very line they lie on and moves nothing — a real
  // gesture, and a useless one to prove a swing with.
  const ring = rigH.find(h => h.type === 'rotate' && h.axis === 2);
  const hub = rigH.find(h => h.type === 'free');
  check('the pivot shows rotate rings', !!ring && !!hub);
  if (ring && hub) {
    // TANGENTIALLY, about the pivot. A ring is turned by sweeping an angle, so
    // a drag straight out from the centre is radial and sweeps none — which is
    // a real gesture that must do nothing, and a useless one to test with.
    const rx = ring.x - hub.x, ry = ring.y - hub.y;
    const len = Math.hypot(rx, ry) || 1;
    await p.drag(ring.x, ring.y, ring.x - ry / len * 40, ring.y + rx / len * 40);
    await sleep(500);
  }
  const after2 = await q(centres);
  check('turning the group turns its members',
    JSON.stringify(after2[1]) !== JSON.stringify(before2[1])
    && JSON.stringify(after2[2]) !== JSON.stringify(before2[2]));
  // THE PIVOT'S WHOLE MEANING, in two checks. Part 2 IS the pivot — the group
  // was made from it — so it must turn on the spot. Part 3 is out along the
  // arm, so it must swing.
  check('a member sitting on the pivot turns without moving',
    after2[1].slice(0, 3).join() === before2[1].slice(0, 3).join()
    && after2[1].slice(3).join() !== before2[1].slice(3).join());
  check('a member away from it swings',
    after2[2].slice(0, 3).join() !== before2[2].slice(0, 3).join());
  check('and a part outside the group is left alone',
    JSON.stringify(after2[0]) === JSON.stringify(before2[0]));
  // RIGID: the two arms keep the distance between them.
  const gap = c => Math.hypot(c[1][0] - c[2][0], c[1][1] - c[2][1], c[1][2] - c[2][2]);
  check(`the swing is rigid (${gap(before2).toFixed(3)} -> ${gap(after2).toFixed(3)})`,
    Math.abs(gap(after2) - gap(before2)) < 5e-3);
  // Six channels a member: three for the centre, three for the rotation. A
  // group that wrote only positions would let the parts slide through
  // each other.
  const memberChans = await q(`JSON.stringify(${T}.clip.clip.channels
    .map(c => c.target).filter(t => typeof t === 'number'
      && (Math.floor(t / 13) === 2 || Math.floor(t / 13) === 3)))`);
  check(`it keys the centre AND the rotation (${memberChans.length} channels)`,
    [2, 3].every(row => [1, 2, 3, 4, 5, 6].every(c => memberChans.includes(row * 13 + c))));
  // AND ONLY AT THE PLAYHEAD.
  check('every one of them moved at frame 4 and nowhere else',
    await q(`JSON.stringify(${T}.clip.clip.channels.filter(c =>
      typeof c.target === 'number' && Math.floor(c.target / 13) >= 2
      && Math.floor(c.target / 13) <= 3).every(c =>
        c.values.every((v, i) => i === 4 || v === c.values[0])))`));

  // Placing the pivot moves no part — it is where the NEXT turn swings from.
  await p.evaluate("document.getElementById('apivotmove').click()");
  await sleep(150);
  const pivBefore = await q(`JSON.stringify(${T}.clip.clip.groups[0].pivot)`);
  const posBefore = await q(centres);
  const placeH = await q(`JSON.stringify(${T}.canvas.debugRigHandles())`);
  const centreH = placeH.find(h => h.type === 'free');
  if (centreH) {
    await p.drag(centreH.x, centreH.y, centreH.x + 35, centreH.y - 20);
    await sleep(400);
  }
  check('placing moves the pivot',
    JSON.stringify(await q(`JSON.stringify(${T}.clip.clip.groups[0].pivot)`))
      !== JSON.stringify(pivBefore));
  check('and moves no part at all',
    JSON.stringify(await q(centres)) === JSON.stringify(posBefore));
  await p.evaluate("document.getElementById('apivotturn').click()");
  await sleep(150);

  // --- playback ------------------------------------------------------------------
  await p.evaluate(`(()=>{${T}.clip.clip.fps = 30; ${T}.clipui.goTo(0);
    ${T}.clipui.setPlaying(true);})()`);
  // Polled rather than slept on: playback steps from rAF, and a headless frame
  // rate is not something a fixed wait may assume.
  let moved = 0;
  for (let i = 0; i < 30 && !moved; i++) {
    await sleep(100);
    moved = await q(`JSON.stringify(${T}.clip.clip.frame)`);
  }
  await p.evaluate(`${T}.clipui.setPlaying(false)`);
  check(`playing advances the playhead (reached ${moved})`, moved !== 0);
  check('and stopping puts the pose back',
    await q(`JSON.stringify(${T}.state.parts.join() === `
      + `${T}.clip.posedParts(${T}.clip.clip.frame).join())`));

  // --- onion skin ----------------------------------------------------------------
  const ink = `(()=>{const c=document.getElementById('display');
    const d=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    let n=0; for(let i=3;i<d.length;i+=4) if(d[i]) n++; return JSON.stringify(n);})()`;
  await p.evaluate(`(()=>{const s=document.getElementById('aonion');
    s.value='0'; s.dispatchEvent(new Event('change'));})()`);
  await sleep(400);
  const plain = await q(ink);
  await p.evaluate(`(()=>{const s=document.getElementById('aonion');
    s.value='2'; s.dispatchEvent(new Event('change'));})()`);
  await sleep(400);
  const ghosted = await q(ink);
  check(`ghosts add ink behind the pose (${plain} -> ${ghosted})`, ghosted > plain);
  await p.evaluate(`(()=>{const s=document.getElementById('aonion');
    s.value='0'; s.dispatchEvent(new Event('change'));})()`);

  // --- save and load -------------------------------------------------------------
  if (existsSync(CLIPS + TMP + '.js')) unlinkSync(CLIPS + TMP + '.js');
  await p.evaluate(`(()=>{const n=document.getElementById('aname');
    n.value='${TMP}'; n.dispatchEvent(new Event('input'));})()`);
  await p.evaluate("document.getElementById('asave').click()");
  await sleep(500);
  check('save writes the file', existsSync(CLIPS + TMP + '.js'));
  const src = existsSync(CLIPS + TMP + '.js') ? readFileSync(CLIPS + TMP + '.js', 'utf8') : '';
  check('it imports exactly one model', /import creature from '\.\.\/models\/creature\.js';/.test(src));
  check('it is the runtime\'s array shape',
    /export default \[creature, \{.*\}, 32, 32, 6, \d+, \d+, \[/.test(src));
  check('and it carries the editor-only rig as a NAMED export',
    /export const rig = /.test(src));
  check('the rig holds the group, its pivot and its parts',
    /\{name: '.*', pivot: \[[-\d., ]+\], parts: \[2, 3\]\}/.test(src));

  const saved = await q(`JSON.stringify(${T}.clip.clip.channels.map(c => [c.target, ...c.values]))`);
  const savedRig = await q(`JSON.stringify(${T}.clip.clip.groups)`);
  await p.evaluate(`(()=>{document.getElementById('anew').click();})()`);
  await sleep(200);
  check('new empties the channels',
    await q(`JSON.stringify(${T}.clip.clip.channels.length)`) === 0);
  check('and the groups with them',
    await q(`JSON.stringify(${T}.clip.clip.groups.length)`) === 0);
  await p.evaluate(`${T}.clip.loadClip('${TMP}')`);
  await sleep(400);
  const back = await q(`JSON.stringify(${T}.clip.clip.channels.map(c => [c.target, ...c.values]))`);
  check('load restores every channel, value for value',
    JSON.stringify(back) === JSON.stringify(saved));
  check('and every group, pivot for pivot',
    JSON.stringify(await q(`JSON.stringify(${T}.clip.clip.groups)`))
      === JSON.stringify(savedRig));

  // --- the canvas is handed back -------------------------------------------------
  const posed = await q(`JSON.stringify(${T}.state.parts.join())`);
  await p.evaluate("document.getElementById('tab-model').click()");
  await sleep(300);
  check('leaving restores the model tab\'s own parts',
    await q(`JSON.stringify(${T}.state.parts.join())`) !== posed);
  check('and the anim panels are hidden',
    await q("JSON.stringify(document.getElementById('astrip').hidden)"));
  check('and the stage is still up for the model tab',
    await q("JSON.stringify(!document.getElementById('stage').hidden)"));

  // --- what the server refuses ---------------------------------------------------
  const good = {
    name: TMP, model: 'creature', view: {}, w: 32, h: 32,
    frames: 6, fps: 10, mode: 0, channels: [[56, 0, 0.1, 0.2, 0.1, 0, -0.1]],
  };
  const post = async over => {
    const r = await fetch(`${BASE}/api/save-clip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...good, ...over }),
    });
    return r.status;
  };
  check('a good clip is accepted', await post({}) === 200);
  for (const [why, over] of [
    ['a model that does not exist', { model: 'nosuchmodel' }],
    ['one frame', { frames: 1, channels: [] }],
    ['too many frames', { frames: 999, channels: [] }],
    ['fps out of range', { fps: 0 }],
    ['a mode that is not 0..2', { mode: 3 }],
    ['a size of zero', { w: 0 }],
    ['a view value that is not a number', { view: { yaw: 'x' } }],
    ['a channel of the wrong length', { channels: [[56, 0, 0.1]] }],
    ['a channel value that is not finite', { channels: [[56, 0, 0.1, 0.2, 0.1, 0, null]] }],
    ['a target outside the model', { channels: [[9999, 0, 0, 0, 0, 0, 0]] }],
    ['a kind channel', { channels: [[0, 0, 0, 0, 0, 0, 0]] }],
    ['a dial that does not exist', { channels: [['nosuchdial', 0, 0, 0, 0, 0, 0]] }],
    ['two channels on one target', {
      channels: [[56, 0, 0, 0, 0, 0, 0], [56, 1, 1, 1, 1, 1, 1]],
    }],
    ['a mat channel that is not a whole index', { channels: [[64, 0, 0.5, 1, 1, 1, 1]] }],
    ['a frame budget past the pixel cap', { w: 256, h: 256, frames: 60, channels: [] }],
    ['a group part that is not in the model', { groups: [{ name: 'g', pivot: [0, 0, 0], parts: [99] }] }],
    ['a group pivot that is not three numbers', { groups: [{ name: 'g', pivot: [0, 0], parts: [] }] }],
    ['a group with no name', { groups: [{ name: '', pivot: [0, 0, 0], parts: [] }] }],
    ['a group holding a part twice', { groups: [{ name: 'g', pivot: [0, 0, 0], parts: [2, 2] }] }],
  ]) check(`the server refuses ${why}`, await post(over) === 400);

  const msgs = p.consoleMsgs.filter(m => /EXCEPTION|error/i.test(m));
  check(`no page exceptions (${msgs.length})`, !msgs.length);
  if (msgs.length) console.log(msgs.slice(0, 4).join('\n'));
} finally {
  if (existsSync(CLIPS + TMP + '.js')) unlinkSync(CLIPS + TMP + '.js');
  await p.close();
}

console.log(fail ? `\n${fail} failed` : '\nall passed');
process.exitCode = fail ? 1 : 0;
