// The `?` overlay. One table, rendered on demand, so the hints can leave the
// panels — documentation that pushes the controls off the pane has cost more
// than it taught (the sdftool's rule, applied here).
const KEYS = [
  ['Tools', [
    ['1 … 5', 'select · stamp · aabb · object · tile'],
    ['Alt+click', 'eyedrop a stamp: sprite, rate, depth and flip'],
    ['X', 'flip the selection, or the armed stamp'],
    ['B', 'box the selected stamps (collision at their bounds)'],
    ['P', 'playtest from the cursor'],
  ]],
  ['Select', [
    ['drag', 'rubber-band stamps, boxes and objects'],
    ['Shift+drag / Shift+click', 'extend or toggle the selection'],
    ['Alt+drag', 'duplicate the selection'],
    ['Ctrl+C / Ctrl+V', 'copy · paste (each paste cascades further)'],
    ['Ctrl+D', 'repeat the selection along the last step'],
    ['[ / ]', 'send back / bring forward in the layer (Shift: all the way)'],
    ['arrows', 'nudge 1 px (Shift 8 px), or pan with nothing selected'],
    ['Delete', 'remove the selection'],
  ]],
  ['View', [
    ['space / middle drag', 'pan'],
    ['wheel', 'zoom on the cursor'],
    ['F', 'frame the selection'],
    ['Shift+F', 'fit the whole stage'],
    ['Home', 'camera to the world origin'],
    ['Ctrl+1 … 9', 'set a camera bookmark'],
    ['1 … 9 with a bookmark', 'jump to it (hold Alt)'],
    ['Tab', 'camera preview: one screen, no overlays'],
  ]],
  ['Document', [
    ['Ctrl+S', 'save'],
    ['Ctrl+Z', 'undo'],
    ['Ctrl+Shift+Z / Ctrl+Y', 'redo'],
    ['Esc', 'clear the selection, cancel a drag, leave the stamp tool'],
    ['?', 'this sheet'],
  ]],
];

let el = null;

export function toggleShortcuts() {
  if (el) {
    el.remove();
    el = null;
    return;
  }
  el = document.createElement('div');
  el.id = 'keysheet';
  const box = document.createElement('div');
  box.className = 'keysheet-box';
  for (const [title, rows] of KEYS) {
    const h = document.createElement('h3');
    h.textContent = title;
    box.append(h);
    for (const [k, what] of rows) {
      const r = document.createElement('div');
      r.className = 'keyrow';
      const kb = document.createElement('kbd');
      kb.textContent = k;
      const d = document.createElement('span');
      d.textContent = what;
      r.append(kb, d);
      box.append(r);
    }
  }
  el.append(box);
  el.onclick = () => toggleShortcuts();
  document.body.append(el);
}

export const shortcutsOpen = () => !!el;
