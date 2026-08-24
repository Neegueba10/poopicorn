/**
 * The clip document: one model, a frame count, and a dense table of numbers.
 *
 * A CHANNEL IS A FIELD OVER TIME. Its target is either a flat index into the
 * model's parts array — `part * 13 + column`, the same arithmetic the runtime
 * reads — or the NAME of a view dial. Its values are one per frame, with no
 * keys and no interpolation: the tool samples whatever curve you author and
 * writes the samples, so easing costs the game nothing.
 *
 * A CLIP IS A SHEET ROW PLUS TIME. `[model, view, w, h]` means exactly what it
 * means in a sheet, which is why `fit`, the view merge and the bake all carry
 * over unchanged — and why `src/js/core/sdfanim.js` can hand its frames
 * straight to `sheetBaker`.
 *
 * WHAT A CHANNEL MAY NOT TARGET, and why:
 *   - column 0 (`kind`). A part cannot change primitive, gain a mirror or
 *     become a cut part-way through a clip, and column 0 also carries the
 *     SCATTER flag, so animating it would break the header/template pairing.
 *   - any column of a scatter HEADER row. The seed, the count and the spreads
 *     decide the arrangement; move one and the mass reshuffles every frame,
 *     which reads as confetti rather than as motion. The TEMPLATE under it is
 *     fair game, and animating it moves the whole mass coherently.
 *
 * The model itself is never written. Posing copies, so a clip and a static
 * sheet row can share one model and an edit to the model reaches both.
 */
import { models, importIdents } from './sheet.js';
import { STRIDE, COL, SCATTER, MIRROR } from './state.js';
import { axisMatrix, transformGroup, translateGroup, centroid } from './rig.js';
import { frameFor, projectedBounds } from './fit.js';

/** How the game plays the frames. The numbering is core/Animation.js's. */
export const MODES = ['loop', 'pingpong', 'once'];

/** Onion skin: what is drawn behind the frame under the playhead. */
export const ONION = ['off', 'prev', 'prev+next'];

export const MAX_FRAMES = 64;

export const clip = {
  name: 'untitled',
  model: '',                 // a model NAME; the array lives in sheet.js's cache
  view: {},                  // the clip's own overrides, on top of the model's
  w: 40,
  h: 40,
  frames: 6,
  fps: 10,
  mode: 0,
  channels: [],              // { target: number | string, values: number[] }
  // The rig: groups with pivots. Saved as a NAMED export, which the game never
  // imports, so it costs the zip nothing.
  groups: [],                // { name, pivot: [x, y, z], parts: number[] }
  // --- editor only, never saved -------------------------------------------
  frame: 0,                  // the playhead
  sel: 0,                    // the selected part, for the gizmo
  group: -1,                 // the selected group, or -1
  playing: false,
  onion: 0,
  dirty: false,
};

/** The model array, or null while none is chosen. */
export const modelOf = () => models.get(clip.model) || null;
export const baseParts = () => (modelOf() ? modelOf()[0] : []);
export const partCount = () => baseParts().length / STRIDE;

/** The view a frame renders at: the model's, the clip's, then the frame's own
 * dial channels — the same merge order `sheetBaker` performs at bake time. */
export function effectiveView(f = clip.frame) {
  const m = modelOf();
  const v = { ...(m ? m[2] : {}), ...clip.view };
  for (const ch of clip.channels) if (typeof ch.target == 'string') v[ch.target] = ch.values[f];
  return v;
}

// --- what may be animated ------------------------------------------------------

/** True while row `i` of the model is a scatter header. */
export const isHeader = i => !!(baseParts()[i * STRIDE] & SCATTER);
export const isMirrored = i => !!(baseParts()[i * STRIDE] & MIRROR);

/**
 * Why `target` may not be animated, or '' when it may be. One function, so the
 * panel, the auto-key and the save all refuse the same things.
 */
export function refuse(target) {
  if (typeof target == 'string') return '';
  const parts = baseParts();
  if (!Number.isInteger(target) || target < 0 || target >= parts.length)
    return 'that field is not in this model';
  const col = target % STRIDE, row = (target - col) / STRIDE;
  if (col === COL.kind)
    return 'kind cannot be animated — a part may not change primitive, '
      + 'flag or scatter-ness part-way through a clip';
  if (isHeader(row))
    return 'a scatter header cannot be animated — its seed and spreads decide '
      + 'the arrangement, and a mass that reshuffles per frame is confetti. '
      + 'Animate the template under it instead, and the whole mass moves';
  return '';
}

/** The value the clip holds for `target` at frame `f` — the channel's, or the
 * model's own when nothing animates it. */
export function valueAt(target, f = clip.frame) {
  const ch = chanFor(target);
  if (ch) return ch.values[f];
  return typeof target == 'string' ? effectiveView(f)[target] ?? 0 : baseParts()[target];
}

export const chanFor = target => clip.channels.find(c => c.target === target) || null;

/**
 * The x clamp, carried over from `state.set`. A mirrored part folds `x -> |x|`,
 * so a frame that puts one at a negative x has no half left to mirror and the
 * part vanishes for that frame only — which is worse than vanishing outright,
 * because it looks like a flicker rather than like a mistake.
 */
function clamp(target, v) {
  if (typeof target == 'string') return v;
  const col = target % STRIDE;
  return col === COL.x && v < 0 && isMirrored((target - col) / STRIDE) ? 0 : v;
}

/** Start animating `target`, flat at whatever the model already says. Returns
 * the channel, or null if the target is refused. */
export function addChannel(target) {
  if (refuse(target)) return null;
  let ch = chanFor(target);
  if (ch) return ch;
  const v = typeof target == 'string'
    ? effectiveView(0)[target] ?? 0 : baseParts()[target];
  ch = { target, values: Array(clip.frames).fill(v) };
  clip.channels.push(ch);
  clip.dirty = true;
  return ch;
}

export function removeChannel(target) {
  const i = clip.channels.findIndex(c => c.target === target);
  if (i < 0) return;
  clip.channels.splice(i, 1);
  clip.dirty = true;
}

/**
 * AUTO-KEY: write `v` for `target` at frame `f`, making the channel if this is
 * the first time that field has moved.
 *
 * There is no record button. Any edit in the anim tab is a key at the playhead,
 * because the alternative is a mode you forget you are not in, and an hour of
 * posing that went nowhere.
 */
export function key(target, v, f = clip.frame) {
  const ch = addChannel(target);
  if (!ch) return false;
  ch.values[f] = clamp(target, v);
  clip.dirty = true;
  return true;
}

/** True while `target` differs at frame `f` from what the model says — what
 * puts a dot on the timeline. */
export function keyed(target, f) {
  const ch = chanFor(target);
  if (!ch) return false;
  const base = typeof target == 'string'
    ? (modelOf()?.[2] ?? {})[target] ?? clip.view[target] : baseParts()[target];
  return ch.values[f] !== base;
}

/** Frames a channel is not flat over — for the timeline's per-frame dots. */
export function movingAt(f) {
  return clip.channels.some(ch => ch.values.some(v => v !== ch.values[f]));
}

/**
 * Change the frame count, holding the last value when the clip grows.
 *
 * Holding rather than looping is the conservative choice: a clip that gets
 * longer should keep the pose it ended on until you move it, not silently
 * repeat its middle.
 */
export function setFrames(n) {
  n = Math.max(2, Math.min(MAX_FRAMES, Math.round(n) || 2));
  if (n === clip.frames) return;
  for (const ch of clip.channels) {
    const last = ch.values[ch.values.length - 1];
    while (ch.values.length < n) ch.values.push(last);
    ch.values.length = n;
  }
  clip.frames = n;
  clip.frame = Math.min(clip.frame, n - 1);
  clip.dirty = true;
}

/** Point the clip at a model. Channels and groups are dropped: both name parts
 * by INDEX into the old parts array, and carrying them over would silently
 * animate whatever now happens to sit at row 4. */
export function setModel(name) {
  if (clip.model === name) return;
  clip.model = name;
  clip.channels = [];
  clip.groups = [];
  clip.sel = 0;
  clip.group = -1;
  clip.dirty = true;
}

export function setDial(dial, v) {
  if (v == null) delete clip.view[dial];
  else clip.view[dial] = v;
  clip.dirty = true;
}

// --- groups --------------------------------------------------------------------

export const selGroup = () => clip.groups[clip.group] || null;

/**
 * A group holding one part, with its pivot at that part's centre.
 *
 * The centre rather than the origin, because a pivot at the origin is a pivot
 * you must move before the group does anything useful, and a group of one part
 * turning about its own centre is at least what the part gizmo already does.
 */
export function addGroup(ids = [clip.sel]) {
  const parts = posedParts();
  const live = ids.filter(i => i >= 0 && i < partCount() && !isHeader(i));
  clip.groups.push({
    name: `group ${clip.groups.length + 1}`,
    pivot: centroid(parts, live.length ? live : [0]),
    parts: live,
  });
  clip.group = clip.groups.length - 1;
  clip.dirty = true;
  return clip.group;
}

export function removeGroup(i) {
  if (!clip.groups[i]) return;
  clip.groups.splice(i, 1);
  clip.group = Math.min(clip.group, clip.groups.length - 1);
  clip.dirty = true;
}

/** Add or drop a part. A scatter HEADER may never join: it has no centre to
 * swing about and no column a channel may write. */
export function toggleMember(i, id) {
  const g = clip.groups[i];
  if (!g || id < 0 || id >= partCount() || isHeader(id)) return;
  const at = g.parts.indexOf(id);
  if (at < 0) g.parts.push(id);
  else g.parts.splice(at, 1);
  g.parts.sort((a, b) => a - b);
  clip.dirty = true;
}

export function setPivot(i, p) {
  const g = clip.groups[i];
  if (!g) return;
  g.pivot = p.map(v => +(+v).toFixed(3));
  clip.dirty = true;
}

/**
 * Resolve a group gesture into keys at the playhead.
 *
 * THIS IS THE WHOLE OF THE HIERARCHY. The writes are ordinary part numbers, so
 * once they land the group has left no trace in anything the renderer or the
 * game will read — the group survives only in the rig, to be grabbed again.
 *
 * `from` is the pose the drag started at, not the current one. Re-reading the
 * pose each move would compose the rotation with itself and run away.
 *
 * @returns {{keyed: number, gimbal: boolean}}
 */
export function applyGroup(i, from, kind, arg) {
  const g = clip.groups[i];
  if (!g || !g.parts.length) return { keyed: 0, gimbal: false };
  const r = kind === 'turn'
    ? transformGroup(from, g.pivot, g.parts, axisMatrix(arg[0], arg[1]))
    : translateGroup(from, g.parts, arg);
  let n = 0;
  for (const [target, v] of r.writes) if (key(target, v)) n++;
  return { keyed: n, gimbal: r.gimbal };
}

// --- fit -----------------------------------------------------------------------

/**
 * Crop the clip to ONE frame that holds every pose.
 *
 * `fit set` over time, and it exists for the same reason. Fitting each frame to
 * its own art centres each pose on itself, so the model's origin lands
 * somewhere different in every sprite and the character shifts under itself as
 * it plays. One shared frame is a pixel or two looser and puts the origin in
 * the same place in all of them. There is deliberately no per-frame fit: it
 * would be a bug generator with no use case.
 *
 * AN ANIMATED `vx`/`vy` DOES NOT DEFEAT IT. `projectedBounds` measures the art
 * in world units and never reads those dials, so each frame's bounds are taken
 * RELATIVE to where that frame is already looking, unioned, and the correction
 * folded back — into the channel when there is one, into the clip's own view
 * when there is not. A body that bobs still fits, and keeps its bob.
 *
 * An animated `scale` is the one case it cannot own: the fitted density would
 * be overridden every frame. It fits the box and says so.
 *
 * @returns {{w, h, scale, vx, vy, warn: string} | null}
 */
export function fitClip(max) {
  const m = modelOf();
  if (!m) return null;
  let b = null;
  for (let f = 0; f < clip.frames; f++) {
    const v = effectiveView(f);
    const pb = projectedBounds(posedParts(f), v);
    if (!pb) continue;
    // Relative to what THIS frame already looks at, so the union is a shape
    // rather than a smear of the offsets.
    const rel = [pb[0] - (v.vx ?? 0), pb[1] - (v.vx ?? 0),
      pb[2] - (v.vy ?? 0), pb[3] - (v.vy ?? 0)];
    b = b ? [Math.min(b[0], rel[0]), Math.max(b[1], rel[1]),
      Math.min(b[2], rel[2]), Math.max(b[3], rel[3])] : rel;
  }
  if (!b) return null;
  const fr = frameFor(b, { max: max ?? Math.max(clip.w, clip.h), pad: 1 });
  clip.w = fr.w;
  clip.h = fr.h;

  let warn = '';
  if (chanFor('scale')) warn = 'scale is animated, so the fitted density is overridden '
    + 'every frame — the frame fits the poses, the zoom is yours';
  else clip.view.scale = fr.scale;

  // The correction is a DELTA, so it lands wherever the offset actually lives.
  for (const [dial, d] of [['vx', fr.vx], ['vy', fr.vy]]) {
    const ch = chanFor(dial);
    if (ch) ch.values = ch.values.map(v => +(v + d).toFixed(4));
    else clip.view[dial] = +(((clip.view[dial] ?? m[2][dial]) ?? 0) + d).toFixed(4);
  }
  clip.dirty = true;
  return { ...fr, warn };
}

// --- the bake input ------------------------------------------------------------

/**
 * The array `clipSheet` takes — which is the array the FILE holds. The tab
 * previews by handing this to src/js/core/sdfanim.js and the result to
 * src/js/core/sdfsheet.js, so the frames on screen are the game's frames and a
 * bug in either can only be a bug in both.
 */
export function clipArray() {
  const m = modelOf();
  if (!m) return null;
  return [m, { ...clip.view }, clip.w, clip.h, clip.frames, clip.fps, clip.mode,
    clip.channels.map(ch => [ch.target, ...ch.values])];
}

/** The model's parts, posed for frame `f`. What the gizmo edits. */
export function posedParts(f = clip.frame) {
  const parts = baseParts().slice();
  for (const ch of clip.channels) {
    if (typeof ch.target == 'number') parts[ch.target] = ch.values[f];
  }
  return parts;
}

// --- file ---------------------------------------------------------------------

const num = v => (Number.isInteger(v) ? v : +(+v).toFixed(4));
const targetText = t => (typeof t == 'string' ? `'${t}'` : t);

/** A comment naming what a numeric target is, so the file reads without a
 * calculator: `part 4, col 4 (rx)`. */
const COLNAME = Object.keys(COL);
function label(t) {
  if (typeof t == 'string') return '';
  const col = t % STRIDE;
  return `  // part ${(t - col) / STRIDE}, col ${col} (${COLNAME[col]})`;
}

const clipIdent = () => importIdents([clip.model]).get(clip.model);

/** Mirrors the server's generated file (saveClip in tools/drawtool/server.js)
 * so the byte counter is honest; keep the two in sync. */
export function fileText() {
  const rows = clip.channels.map(ch =>
    `  [${targetText(ch.target)}, ${ch.values.map(num).join(', ')}],${label(ch.target)}`);
  return '// generated by tools/sdftool — [model, view, w, h, frames, fps, mode, channels]\n'
    + '// see src/js/core/sdfanim.js\n'
    + `import ${clipIdent()} from '../models/${clip.model}.js';\n\n`
    + `export default [${clipIdent()}, `
    + `{${Object.entries(clip.view).map(([k, v]) => `${k}: ${num(v)}`).join(', ')}}, `
    + `${clip.w}, ${clip.h}, ${clip.frames}, ${clip.fps}, ${clip.mode}, [\n`
    + `${rows.join('\n')}\n]];\n\n`
    + '/** The editor\'s copy: the groups and their pivots, which resolved into the\n'
    + ' * numbers above and are kept only so they can be grabbed again. A NAMED\n'
    + ' * export, so a game that imports the default only never pays for it —\n'
    + ' * verified at 0 B. */\n'
    + `export const rig = {groups: [\n${clip.groups.map(g =>
      `  {name: '${g.name}', pivot: [${g.pivot.map(num).join(', ')}], `
      + `parts: [${g.parts.join(', ')}]},`).join('\n')}\n]};\n`;
}

export async function listClips() {
  const r = await fetch('/api/clips');
  return r.ok ? r.json() : [];
}

/**
 * Read a clip file back.
 *
 * It IMPORTS rather than parsing, unlike the sheet — a clip names exactly one
 * model, so the name can be read off the single import line and everything else
 * comes back as real numbers with no regular expression to keep in step.
 */
export function parseClip(src) {
  const im = /import\s+(\w+)\s+from\s+'\.\.\/models\/(.+)\.js'/.exec(src);
  if (!im) throw new Error('a clip must import exactly one model');
  return im[2];
}

export async function loadClip(name) {
  const r = await fetch(`/src/js/clips/${name}.js`, { cache: 'reload' });
  if (!r.ok) throw new Error(`no clip named ${name}`);
  const modelName = parseClip(await r.text());
  const mod = await import(`/src/js/clips/${name}.js?v=${Date.now()}`);
  const [, view, w, h, frames, fps, mode, channels] = mod.default;
  clip.name = name;
  clip.model = modelName;
  clip.view = { ...view };
  clip.w = w;
  clip.h = h;
  clip.frames = frames;
  clip.fps = fps;
  clip.mode = mode;
  clip.channels = channels.map(row => ({ target: row[0], values: row.slice(1) }));
  // A clip with no rig is not broken, it just has no groups: the dense table is
  // the document and the groups were only ever a way of writing it.
  clip.groups = (mod.rig?.groups ?? []).map(g => ({
    name: String(g.name ?? 'group'),
    pivot: (g.pivot ?? [0, 0, 0]).map(Number),
    parts: (g.parts ?? []).map(Number),
  }));
  clip.frame = 0;
  clip.sel = 0;
  clip.group = clip.groups.length ? 0 : -1;
  clip.dirty = false;
  clearUndo();
  return clip;
}

export async function saveClip() {
  const r = await fetch('/api/save-clip', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: clip.name, model: clip.model, view: clip.view, w: clip.w, h: clip.h,
      frames: clip.frames, fps: clip.fps, mode: clip.mode,
      channels: clip.channels.map(ch => [ch.target, ...ch.values]),
      groups: clip.groups,
    }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  clip.dirty = false;
  return JSON.parse(text);
}

// --- undo --- (JSON snapshots, cap 100, the same shape as the model tab's)
let undoStack = [];

export function pushUndo() {
  clip.dirty = true;
  // THE GROUPS ARE IN THE SNAPSHOT. Moving a pivot is an edit like any other,
  // and an undo that took back the pose but left the pivot where the drag put
  // it would make the next turn swing about the wrong point.
  undoStack.push(JSON.stringify({
    view: clip.view, w: clip.w, h: clip.h, frames: clip.frames,
    fps: clip.fps, mode: clip.mode, channels: clip.channels, groups: clip.groups,
  }));
  if (undoStack.length > 100) undoStack.shift();
}

export function undo() {
  if (!undoStack.length) return false;
  Object.assign(clip, JSON.parse(undoStack.pop()));
  clip.frame = Math.min(clip.frame, clip.frames - 1);
  clip.group = Math.min(clip.group, clip.groups.length - 1);
  return true;
}

export const clearUndo = () => { undoStack = []; };
