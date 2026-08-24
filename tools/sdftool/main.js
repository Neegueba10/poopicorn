// Boot: build the renderer, wire the UI, drive the progressive preview from
// rAF. The model that is up when a picture has finished rendering costs
// nothing, so the loop idles rather than re-rendering an unchanged image sixty
// times a second.
//
// TWO TABS, ONE LOOP. The model tab shapes one asset; the sheet tab decides
// which assets a game bakes and at which views. Only the visible one renders —
// they are the same renderer and would otherwise compete for the same frame.
import * as state from './state.js';
import * as canvas from './canvas.js';
import * as ui from './ui.js';
import * as sheet from './sheet.js';
import * as sheetui from './sheetui.js';
import * as sheetwidgets from './sheetwidgets.js';
import * as clip from './clip.js';
import * as clipui from './clipui.js';
import * as glr from './glrender.js';

let mode = 'model';

export function setMode(m) {
  // The anim tab BORROWS the model tab's document to hold the posed frame, so
  // leaving it has to give that back before anything else looks at `state`.
  if (mode === 'anim' && m !== 'anim') clipui.leave();
  mode = m;
  for (const t of ['model', 'sheet', 'anim']) {
    for (const e of document.querySelectorAll(`.${t}-only`)) e.hidden = m !== t;
    document.getElementById(`tab-${t}`).classList.toggle('on', m === t);
  }
  // One stage serves the model and anim tabs — same canvas, same gizmo, same
  // camera. Only the sheet has a picture of its own.
  document.getElementById('stage').hidden = m === 'sheet';
  // Coming back to the sheet after editing a model must show the EDITED model,
  // so the re-import happens on the switch rather than on a save the sheet tab
  // never saw. The anim tab needs the same for the model it poses.
  if (m === 'sheet') sheetui.refreshModels().then(sheetui.render);
  else if (m === 'anim') clipui.refreshModels().then(clipui.enter);
  else canvas.restart();
  // A hidden pane has no width, so whichever viewport was just revealed sized
  // itself against nothing. Re-fit now that the box is real.
  (m === 'sheet' ? sheetui.viewport : canvas.viewport)?.apply();
}

window.sdftool = {
  ...state, canvas, ui, sheet, sheetui, sheetwidgets, clip, clipui, glr, setMode,
  getMode: () => mode,
};

// EVERY SECTION'S HELP IS FOLDED AWAY and remembers whether you opened it.
// The hints are worth reading once and are in the way after that: unfolded,
// they push the part list and the "add part…" menu off the bottom of the pane.
for (const d of document.querySelectorAll('details.help')) {
  const k = 'sdftool.help.' + d.dataset.help;
  d.open = localStorage.getItem(k) === '1';
  d.addEventListener('toggle', () => localStorage.setItem(k, d.open ? '1' : '0'));
}

canvas.setup(document.getElementById('display'), document.getElementById('overlay'),
  document.getElementById('stage'));
ui.initUI();
await sheetui.initSheetUI();
await clipui.initClipUI();

// `f` fits whichever picture you are looking at. The viewport is per tab, so
// the binding has to be too — this is the one place that knows which tab is up.
addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.ctrlKey || e.metaKey) return;
  if (e.key === 'f') (mode === 'sheet' ? sheetui.viewport : canvas.viewport)?.fit();
});

for (const t of ['model', 'sheet', 'anim'])
  document.getElementById(`tab-${t}`).onclick = () => setMode(t);

// THE BACK END SWITCH, and it belongs to neither tab: both render through it.
// The CPU renderer stays the authority — it is what the game bakes with and
// what the Node suites test — and the two agree to within a dither step rather
// than exactly, so being able to put a render back on the CPU and compare is
// part of trusting the fast one. The choice is remembered because it is a
// preference about this machine, not about the model.
const gpuBtn = document.getElementById('gputoggle');
function setGpu(on) {
  canvas.view.gpu = on;
  localStorage.setItem('sdftool.gpu', on ? '1' : '0');
  gpuBtn.classList.toggle('on', on && !!canvas.view.gl);
  if (!canvas.view.gl) {
    gpuBtn.disabled = true;
    gpuBtn.title = 'no GPU renderer on this machine — ' + glr.unavailableReason();
  }
  canvas.restart();
  sheetui.restart();
}
gpuBtn.onclick = () => setGpu(!canvas.view.gpu);
setGpu(canvas.view.gpu);

setMode('model');
// The page boots asynchronously (the sheet tab imports its models), so there
// is a window where sdftool exists and its buttons do nothing. Anything
// driving the tool waits on this rather than on the object.
window.sdftool.ready = true;

const tick = () => {
  try {
    if (mode === 'sheet') sheetui.tick();
    else {
      canvas.tick();
      // The frame bake and the playback clock. Both are the anim tab's, and
      // both step from this one loop for the reason the others do: a bake that
      // blocked would make the frame count impossible to feel.
      if (mode === 'anim') clipui.tick();
    }
  } catch (e) {
    // A malformed part faults inside the march, frames after the edit that
    // made it. Report it rather than throwing once a frame forever.
    document.getElementById('status').textContent = 'render error: ' + (e.message || e);
  }
  requestAnimationFrame(tick);
};
requestAnimationFrame(tick);
