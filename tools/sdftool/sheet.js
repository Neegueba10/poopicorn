/**
 * The sheet document: which models bake, at which view, at which size.
 *
 * A slot is NOT pixels, and it is not a copy of a model either — it is the
 * model's NAME plus the view overrides that make this sprite different from
 * that model's default. So eight facings of a character are eight slots
 * holding one number each, and editing the model updates all eight.
 *
 * SPRITE IDS ARE PERMANENT, the atlastool's contract (tools/atlastool/state.js)
 * and the noodletool's. The slot's index IS its id; deleting leaves a
 * tombstone — a `null` here, a `0` in the file — which renders nothing and
 * emits a zero rect, so a game referencing sprite 17 keeps meaning what it
 * meant.
 *
 * THE LAYOUT IS NOT PART OF THE DOCUMENT. Both bakers shelf-pack from the
 * sizes at boot (src/js/core/sdfsheet.js), so there is no x/y to author, to
 * store, or to keep in sync. That is the smallest thing that can work and it
 * is only possible because a baked sheet is private to the game: nothing
 * outside it needs to know where sprite 7 landed.
 */
import { fitFrame, frameFor, projectedBounds } from './fit.js';
import { toWorld, toCam } from './lightwidget.js';

/**
 * The dials a slot may override. Everything else comes from the model.
 *
 * They live in `dials.mjs` because the dev server validates against the same
 * list and imports it rather than keeping a copy; see the note there. Re-
 * exported here so nothing in the browser has to know that.
 */
export { POV_DIALS, LIGHT_DIALS, VIEW_DIALS } from './dials.mjs';

/** True while this sprite's second light still faces its key. The renderer's
 * own rule: unset means "follow", and writing any one of the three unlinks. */
export const fillLinked = eff =>
  eff.l2x == null && eff.l2y == null && eff.l2z == null;

/**
 * A sprite's two light directions as the RENDERER resolves them — which is not
 * what the view object holds, because an unset fill is the key negated rather
 * than a zero vector, and because `lcam` reads both against the camera. The
 * widget and the inspector both need the resolved answer or the fill's sun sits
 * at the origin.
 */
export function lightDirs(eff) {
  const key = [eff.lx ?? 0.6, eff.ly ?? 0.7, eff.lz ?? -0.4];
  return [key, fillLinked(eff)
    ? [-key[0], -key[1], -key[2]]
    : [eff.l2x ?? 0, eff.l2y ?? 0, eff.l2z ?? 0]].map(d => toWorld(d, eff));
}

/** A new slot's size. Small, because a sheet holds many and cost is per pixel. */
export const DEFAULT_SIZE = 48;

export const sheet = {
  name: 'untitled',
  slots: [],       // index IS the sprite id; { model, view, w, h } or null
  sel: -1,
  width: 256,      // preview packing width only — the GAME passes its own
  dirty: false,
};

export const models = new Map();   // name -> [parts, mats, view], as imported

export const slotAt = id => sheet.slots[id] || null;
export const selSlot = () => slotAt(sheet.sel);
export const liveCount = () => sheet.slots.filter(Boolean).length;

/** The view a slot actually renders at: the model's, with its overrides on
 * top — the same merge src/js/core/sdfsheet.js does at bake time. */
export function effectiveView(slot) {
  const m = slot && models.get(slot.model);
  return { ...(m ? m[2] : {}), ...(slot ? slot.view : {}) };
}

/** Append a slot and select it. Returns its id. */
export function addSlot(model, over = {}) {
  sheet.slots.push({ model, view: {}, w: DEFAULT_SIZE, h: DEFAULT_SIZE, ...over });
  sheet.sel = sheet.slots.length - 1;
  sheet.dirty = true;
  return sheet.sel;
}

/**
 * Append `n` slots of one model at evenly spaced yaws — the whole reason a
 * sheet is a list of views rather than a list of sprites. Returns the first id.
 */
export function addFacings(model, n = 8, size = DEFAULT_SIZE) {
  const first = sheet.slots.length;
  for (let i = 0; i < n; i++) addSlot(model, { view: { yaw: i / n }, w: size, h: size });
  sheet.sel = first;
  return first;
}

/** Tombstone a slot: the id survives, and renders nothing. */
export function deleteSlot(id) {
  if (!sheet.slots[id]) return;
  sheet.slots[id] = null;
  if (sheet.sel === id) sheet.sel = -1;
  sheet.dirty = true;
}

/** Re-point a tombstoned id at a model instead of appending — keeps ids dense
 * without ever moving a live one. */
export function reuseSlot(id, model) {
  if (id < 0 || id >= sheet.slots.length || sheet.slots[id]) return;
  sheet.slots[id] = { model, view: {}, w: DEFAULT_SIZE, h: DEFAULT_SIZE };
  sheet.sel = id;
  sheet.dirty = true;
}

/**
 * Crop slot `id` to its art: the smallest frame that still holds the model at
 * this sprite's view, with the longest side `max` pixels.
 *
 * It writes `w`, `h` and three view overrides, because they are one decision —
 * `scale` means world units across the SHORT axis, so it moves when the aspect
 * does, and `vx`/`vy` are where the crop had to look to be tight.
 */
export function fitSlot(id, max) {
  const s = sheet.slots[id];
  const m = s && models.get(s.model);
  if (!m) return null;
  const f = fitFrame(m[0], effectiveView(s), { max: max ?? Math.max(s.w, s.h), pad: 1 });
  if (!f) return null;
  Object.assign(s, { w: f.w, h: f.h });
  s.view.scale = f.scale;
  s.view.vx = f.vx;
  s.view.vy = f.vy;
  sheet.dirty = true;
  return f;
}

/**
 * Crop several sprites to ONE shared frame — the union of what each of them
 * needs.
 *
 * THIS IS THE ONE TO USE ON A FACING SET, and the reason is an anchor. Fitting
 * eight facings one at a time gives eight different frames, each centred on
 * its own art, so the model's origin lands somewhere different in every rect
 * and the character shifts under itself as it turns. A shared frame is a pixel
 * or two looser and puts the origin in the same place in all eight.
 */
export function fitSlots(ids, max) {
  const live = ids.filter(id => sheet.slots[id] && models.get(sheet.slots[id].model));
  if (!live.length) return null;
  let b = null;
  for (const id of live) {
    const s = sheet.slots[id];
    const pb = projectedBounds(models.get(s.model)[0], effectiveView(s));
    if (!pb) continue;
    b = b ? [Math.min(b[0], pb[0]), Math.max(b[1], pb[1]),
      Math.min(b[2], pb[2]), Math.max(b[3], pb[3])] : pb;
  }
  if (!b) return null;
  const longest = max ?? Math.max(...live.map(id => Math.max(sheet.slots[id].w, sheet.slots[id].h)));
  const f = frameFor(b, { max: longest, pad: 1 });
  for (const id of live) {
    const s = sheet.slots[id];
    s.w = f.w;
    s.h = f.h;
    s.view.scale = f.scale;
    s.view.vx = f.vx;
    s.view.vy = f.vy;
  }
  sheet.dirty = true;
  return f;
}

/** Every id using the same model as `id` — an eight-facing set, in practice. */
export const sameModel = id => sheet.slots
  .map((s, i) => (s && sheet.slots[id] && s.model === sheet.slots[id].model ? i : -1))
  .filter(i => i >= 0);

export function setSlot(id, patch) {
  const s = sheet.slots[id];
  if (!s) return;
  Object.assign(s, patch);
  sheet.dirty = true;
}

/** Set one view dial, or clear the override when `v` is null. */
export function setDial(id, dial, v) {
  const s = sheet.slots[id];
  if (!s) return;
  if (v == null) delete s.view[dial];
  else s.view[dial] = v;
  sheet.dirty = true;
}

/** Several at once — one gesture is one edit, so the widgets write through
 * this rather than three calls that each mark the document dirty. */
export const setDials = (id, patch) =>
  Object.entries(patch).forEach(([k, v]) => setDial(id, k, v));

/**
 * Lock this sprite's lights to the camera, or let them go, WITHOUT MOVING THEM.
 * The aims are converted into the other space first, so the suns stay where
 * they are and only the next turn of the camera behaves differently. The model
 * tab's checkbox does the same thing to the model's own view.
 */
export function setLightCam(id, on) {
  const s = sheet.slots[id];
  if (!s) return;
  const was = effectiveView(s);
  const [key, fill] = lightDirs(was);
  const linked = fillLinked(was);
  setDial(id, 'lcam', on ? 1 : 0);
  const now = effectiveView(s);
  const put = (keys, d) => {
    const c = toCam(d, now);
    keys.forEach((k, i) => setDial(id, k, +c[i].toFixed(3)));
  };
  put(['lx', 'ly', 'lz'], key);
  if (!linked) put(['l2x', 'l2y', 'l2z'], fill);
}

/**
 * Copy this sprite's overrides for `dials` onto every sprite of the same model.
 *
 * THIS IS THE ANSWER TO THE FACING-SET WARNING on LIGHT_DIALS. Aim the light
 * once, then push it to all eight, and the set is lit from one side again — the
 * same shape of decision "fit set" makes about frames.
 */
export function copyDialsToSet(id, dials) {
  const src = sheet.slots[id];
  if (!src) return 0;
  const ids = sameModel(id).filter(i => i !== id);
  for (const i of ids) {
    for (const d of dials) {
      if (src.view[d] == null) delete sheet.slots[i].view[d];
      else sheet.slots[i].view[d] = src.view[d];
    }
  }
  sheet.dirty = true;
  return ids.length;
}

/** The bake input: what src/js/core/sdfsheet.js's sheetBaker takes. */
export const bakeSheet = () =>
  sheet.slots.map(s => (s && models.get(s.model)
    ? [models.get(s.model), s.view, s.w, s.h]
    : 0));

// --- file ---------------------------------------------------------------------

const num = v => (Number.isInteger(v) ? v : +(+v).toFixed(4));

/**
 * Local import aliases for a list of model names — the mirror of
 * `importIdents` in tools/drawtool/server.js; keep the two in sync.
 *
 * A model name is only constrained to be a safe FILE name, so `poppy-dead` is
 * legal on disk and is not a legal JS identifier. The alias is what a row
 * names; the PATH is what names the file, which is why the readers below map
 * back through the import lines rather than trusting the identifier.
 */
export function importIdents(names) {
  const used = new Set(), out = new Map();
  for (const n of names) {
    let id = n.replace(/-/g, '_');
    try { new Function(`var ${id}`); } catch { id = '_' + id; }  // digit start, reserved word
    while (used.has(id)) id += '_';
    used.add(id);
    out.set(n, id);
  }
  return out;
}

/** Mirrors the server's generated file (saveSheet in tools/drawtool/server.js)
 * so the byte counter is honest; keep the two in sync. */
export function fileText() {
  const used = [...new Set(sheet.slots.filter(Boolean).map(s => s.model))].sort();
  const ident = importIdents(used);
  const rows = sheet.slots.map(s => (s
    ? `  [${ident.get(s.model)}, {${Object.entries(s.view).map(([k, v]) => `${k}: ${num(v)}`).join(', ')}}, ${s.w}, ${s.h}],`
    : '  0,'));
  return '// generated by tools/sdftool — [model, view, w, h] per sprite id; a 0 is a tombstone\n'
    + used.map(m => `import ${ident.get(m)} from '../models/${m}.js';`).join('\n')
    + `\n\nexport default [\n${rows.join('\n')}\n];\n`;
}

export async function listSheets() {
  const r = await fetch('/api/sheets');
  return r.ok ? r.json() : [];
}

export async function listModels() {
  const r = await fetch('/api/models');
  return r.ok ? r.json() : [];
}

/**
 * Import a model by name and cache it.
 *
 * `?v=` because a module is cached by its resolved URL for the life of the
 * page: without it, a sheet baked after a save in the model tab renders the
 * OLD model. `force` is what the model tab passes when it has just saved.
 */
export async function loadModel(name, force = false) {
  if (!force && models.has(name)) return models.get(name);
  const mod = await import(`/src/js/models/${name}.js?v=${force ? Date.now() : 0}`);
  const m = mod.default;
  if (!Array.isArray(m) || !Array.isArray(m[0]))
    throw new Error(`${name} is not a model — expected [parts, mats, view]`);
  models.set(name, m);
  return m;
}

export const loadModels = names => Promise.all(names.map(n => loadModel(n)));

/**
 * Read a sheet file back into slots.
 *
 * It parses the SOURCE rather than importing it, because importing gives back
 * model arrays and the document needs model NAMES. The file is generated, so
 * the shapes it may take are known exactly; a hand-edited sheet that does not
 * match is reported rather than silently half-loaded.
 */
export function parseSheet(src) {
  const slots = [];
  // A row names the import ALIAS, which is not always the file name. The
  // import lines are the map back, so any aliasing scheme reads correctly.
  const files = new Map();
  for (const im of src.matchAll(/^import\s+(\w+)\s+from\s+'\.\.\/models\/(.+)\.js';$/gm))
    files.set(im[1], im[2]);
  const body = src.slice(src.indexOf('export default ['));
  const re = /^\s*(?:0,|\[\s*(\w+)\s*,\s*\{([^}]*)\}\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\],)\s*$/;
  for (const line of body.split('\n').slice(1)) {
    if (line.startsWith(']')) break;
    if (!line.trim()) continue;
    const m = re.exec(line);
    if (!m) throw new Error(`cannot read sprite line: ${line.trim()}`);
    if (!m[1]) { slots.push(null); continue; }
    const view = {};
    for (const pair of m[2].split(',')) {
      const kv = pair.split(':');
      if (kv.length === 2) view[kv[0].trim()] = +kv[1];
    }
    slots.push({ model: files.get(m[1]) || m[1], view, w: +m[3], h: +m[4] });
  }
  return slots;
}

export async function loadSheet(name) {
  const r = await fetch(`/src/js/sheets/${name}.js`, { cache: 'reload' });
  if (!r.ok) throw new Error(`no sheet named ${name}`);
  const slots = parseSheet(await r.text());
  await loadModels([...new Set(slots.filter(Boolean).map(s => s.model))]);
  sheet.name = name;
  sheet.slots = slots;
  sheet.sel = slots.findIndex(Boolean);
  sheet.dirty = false;
  return slots;
}

export async function saveSheet() {
  const r = await fetch('/api/save-sheet', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: sheet.name, sprites: sheet.slots }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  sheet.dirty = false;
  return JSON.parse(text);
}
