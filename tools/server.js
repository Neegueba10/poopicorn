// Dev server for the sdftool, stagetool and Voxby editors -- `npm run tools`.
// Zero dependencies; never shipped. It serves the landing page at /, the tool
// pages one path each, the repo's src/ tree (so the pages import core/sdf.js
// and core/stage.js as native ES modules), and the save/list APIs for SDF
// models, sheets, clips and stages.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PORT = process.env.PORT || 8787;
const ROOT = path.resolve(__dirname, '..');
const TOOLS_DIR = path.join(ROOT, 'tools');
const SDFTOOL_DIR = path.join(ROOT, 'tools', 'sdftool');
const STAGETOOL_DIR = path.join(ROOT, 'tools', 'stagetool');
const SOUNDBOXTOOL_DIR = path.join(ROOT, 'tools', 'soundbox');
const MODELS_DIR = path.join(ROOT, 'src', 'js', 'models');
const SHEETS_DIR = path.join(ROOT, 'src', 'js', 'sheets');
const CLIPS_DIR = path.join(ROOT, 'src', 'js', 'clips');
const STAGES_DIR = path.join(ROOT, 'src', 'js', 'stages');

// The list of view dials a sprite -- or a clip's channel -- may override, read
// from the very module the editor reads it from. Duplicating the names here
// would work until one of them gained a dial. The catch matters: an unhandled
// rejection here would take down the whole dev server over one missing file.
const dialsMod = import(pathToFileURL(path.join(SDFTOOL_DIR, 'dials.mjs')).href)
  .catch(e => { console.error('sdftool dial list unavailable:', e.message); return null; });

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.aseprite': 'application/octet-stream',
};

function send(res, status, body, type = 'text/plain') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveStatic(res, root, rel) {
  const file = path.resolve(root, rel);
  if (!file.startsWith(root + path.sep) && file !== root) return send(res, 404, 'not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'not found');
    send(res, 200, data, MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  });
}

const validName = n => typeof n === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(n);

// Local import aliases for a list of asset names. A name is only constrained
// to be a safe FILE name, so `poppy-dead` is legal on disk but is not a legal
// JS identifier — a generated `import poppy-dead from …` fails to parse. Maps
// each name to a usable alias, keeping names that sanitise alike apart.
function importIdents(names) {
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

// List the .js basenames in a directory ([] if it doesn't exist).
function listNames(dir) {
  try {
    return fs.readdirSync(dir).filter(f => f.endsWith('.js')).map(f => f.slice(0, -3));
  } catch {
    return [];
  }
}

// Confine-and-write a generated module, then answer with its byte count.
function writeModule(res, dir, name, text) {
  const file = path.resolve(dir, name + '.js');
  if (!file.startsWith(dir + path.sep)) return send(res, 400, 'invalid path');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, text);
  return send(res, 200, JSON.stringify({ bytes: Buffer.byteLength(text) }), 'application/json');
}


// POST /api/save-model {name, parts, mats, view} — save an SDF model.
//
// A model is DATA, not source: a stride-10 numeric table plus a material
// table and a default view (see src/js/core/sdf.js). So unlike a noodle
// picture — which is authored source and is checked for what it may BE — this
// is checked for what it must CONTAIN, the way every other generated format
// here is.
//
// The bounds are deliberately loose. A part outside the view or a blend of 40
// is legal, just useless, and an editor that refuses experiments is worse than
// one that lets you make something ugly. What is refused is data that would
// break the renderer or the file: a wrong stride, a kind it cannot dispatch, a
// material index with no material.
// The primitive lives in the low 5 bits; +32 subtracts, +64 paints, +128
// mirrors across x = 0, +256 marks a SCATTER header. See src/js/core/sdf.js.
//
// A scatter header is not a shape: it copies the row after it `count` times
// with jittered numbers, at render time. So the file stores two rows where the
// render has forty, and what is checked here is what would break that — a
// header with no template, a count that would take the bake to a standstill, a
// material spread reaching past the material table.
const MODEL_PRIMS = 14;
const MODEL_KIND_MAX = 511;
const MODEL_SCATTER = 256;
const MODEL_MAX_COUNT = 64;
const MODEL_MAX_EXPANDED = 256;

function saveModel(res, { name, parts, mats, view = {} }) {
  if (!validName(name)) return send(res, 400, 'invalid name');
  if (!Array.isArray(parts) || !parts.length || parts.length % 13)
    return send(res, 400, 'parts must be a non-empty multiple of 13 (stride 13)');
  if (!parts.every(Number.isFinite)) return send(res, 400, 'parts must all be numbers');
  if (parts.length > 4000) return send(res, 400, 'too many parts');
  if (!Array.isArray(mats) || !mats.length || mats.length > 64
    || !mats.every(m => Array.isArray(m) && m.length === 3
      && m.every(v => Number.isFinite(v) && v >= 0 && v <= 1)))
    return send(res, 400, 'mats must be 1..64 [r, g, b] triples in 0..1');
  // How many rows the renderer will actually march. A template row does not
  // count: it is replaced by its instances rather than drawn beside them.
  let expanded = 0, wasHeader = false;
  for (let i = 0; i < parts.length; i += 13) {
    const kind = parts[i];
    const id = i / 13;
    if (!Number.isInteger(kind) || kind < 0 || kind > MODEL_KIND_MAX)
      return send(res, 400, `part ${id}: kind ${kind} is out of range`);

    if (kind & MODEL_SCATTER) {
      if (kind !== MODEL_SCATTER)
        return send(res, 400, `part ${id}: a scatter header carries no other flag — `
          + 'subtract, paint and mirror belong on its template, where they reach every instance');
      const [seed, count, smat] = [parts[i + 1], parts[i + 2], parts[i + 12]];
      if (!Number.isInteger(seed) || seed < 1 || seed > 2147483646)
        return send(res, 400, `part ${id}: scatter seed must be a whole number in 1..2147483646`);
      if (!Number.isInteger(count) || !count || Math.abs(count) > MODEL_MAX_COUNT)
        return send(res, 400, `part ${id}: scatter count must be a whole number, `
          + `1..${MODEL_MAX_COUNT} in either sign (negative is an ellipsoid)`);
      if (!Number.isInteger(smat) || smat < 0 || smat >= mats.length)
        return send(res, 400, `part ${id}: scatter material spread must be a whole number, `
          + `0..${mats.length - 1}`);
      const t = i + 13;
      if (t >= parts.length || (parts[t] & MODEL_SCATTER))
        return send(res, 400, `part ${id}: a scatter header must be followed by its template part`);
      if (!Number.isInteger(parts[t + 12]) || parts[t + 12] + smat >= mats.length)
        return send(res, 400, `part ${id}: the scatter reaches material `
          + `${parts[t + 12] + smat}, which does not exist`);
      expanded += Math.abs(count);
      wasHeader = true;
      continue;
    }

    if ((kind & 31) >= MODEL_PRIMS)
      return send(res, 400, `part ${id}: kind ${kind} is not a primitive `
        + `(0..${MODEL_PRIMS - 1}, +32 subtract, +64 paint, +128 mirror, +256 scatter)`);
    const mat = parts[i + 12];
    if (!Number.isInteger(mat) || mat < 0 || mat >= mats.length)
      return send(res, 400, `part ${id}: material ${mat} does not exist`);
    if (!wasHeader) expanded++;
    wasHeader = false;
  }
  // March cost is linear in part count, so this is a bake-time guard and not a
  // file-size one.
  if (expanded > MODEL_MAX_EXPANDED)
    return send(res, 400, `this model expands to ${expanded} parts; the cap is ${MODEL_MAX_EXPANDED}`);
  if (typeof view !== 'object' || view === null || Array.isArray(view))
    return send(res, 400, 'invalid view');
  for (const [k, v] of Object.entries(view))
    if (!Number.isFinite(v)) return send(res, 400, `view.${k} must be a number`);

  // TWO DECIMAL PLACES. A model bakes at roughly 35 px per world unit, so a
  // third digit is a byte in the zip and a thirtieth of a pixel on screen —
  // rounding the models poppy.js ships took 139 B out of it. The editor
  // quantises on every write (`q2` in tools/sdftool/state.js); this is the
  // authority, so a stale client or a hand-rolled POST lands on 2 dp too.
  const q2 = v => Math.round(v * 100) / 100;

  // One row per part, because a model is read by rows and a single long line
  // is unreadable in a diff. Whitespace costs nothing after minification.
  const rows = [];
  for (let i = 0; i < parts.length; i += 13) rows.push('  ' + parts.slice(i, i + 13).map(q2).join(', ') + ',');
  const num = v => (Number.isInteger(v) ? v : +v.toFixed(2));
  const text = `// generated by tools/sdftool — [parts, mats, view]; stride 13, see src/js/core/sdf.js\n`
    + `export default [[\n${rows.join('\n')}\n], [\n`
    + mats.map(m => `  [${m.map(num).join(', ')}],`).join('\n')
    + `\n], {${Object.entries(view).map(([k, v]) => `${k}: ${num(v)}`).join(', ')}}];\n`;
  return writeModule(res, MODELS_DIR, name, text);
}

// POST /api/save-sheet {name, sprites} — save an SDF sprite sheet.
//
// A sprite is {model, view, w, h}; a null is a TOMBSTONE, which is how a
// deleted sprite keeps its id from being handed to the next one. The file it
// writes imports the models by name, so the sheet is a list of references and
// never a copy — edit a model and every sheet that uses it follows.
//
// THE LAYOUT IS NOT SAVED, because it is not data: the bakers shelf-pack from
// the sizes at boot (src/js/core/sdfsheet.js). What is checked here is what
// would break the bake — a model that does not exist, a size that cannot be
// rendered, a view value that is not a number.
const MAX_SPRITE = 512;

function saveSheet(res, { name, sprites }) {
  if (!validName(name)) return send(res, 400, 'invalid name');
  if (!Array.isArray(sprites) || !sprites.length) return send(res, 400, 'sprites must be a non-empty array');
  if (sprites.length > 512) return send(res, 400, 'too many sprites');

  const models = new Set();
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i];
    if (!s) continue;                              // tombstone: legal, renders nothing
    if (!validName(s.model) || !fs.existsSync(path.join(MODELS_DIR, s.model + '.js')))
      return send(res, 400, `sprite ${i}: no model named ${s.model}`);
    if (!Number.isInteger(s.w) || !Number.isInteger(s.h)
      || s.w < 1 || s.h < 1 || s.w > MAX_SPRITE || s.h > MAX_SPRITE)
      return send(res, 400, `sprite ${i}: size must be whole numbers in 1..${MAX_SPRITE}`);
    if (s.view != null && (typeof s.view !== 'object' || Array.isArray(s.view)))
      return send(res, 400, `sprite ${i}: invalid view`);
    for (const [k, v] of Object.entries(s.view || {}))
      if (!Number.isFinite(v)) return send(res, 400, `sprite ${i}: view.${k} must be a number`);
    models.add(s.model);
  }

  const num = v => (Number.isInteger(v) ? v : +v.toFixed(4));
  const sorted = [...models].sort();
  const ident = importIdents(sorted);
  const rows = sprites.map(s => (s
    ? `  [${ident.get(s.model)}, {${Object.entries(s.view || {}).map(([k, v]) => `${k}: ${num(v)}`).join(', ')}}, ${s.w}, ${s.h}],`
    : '  0,'));
  const text = '// generated by tools/sdftool — [model, view, w, h] per sprite id; a 0 is a tombstone\n'
    + sorted.map(m => `import ${ident.get(m)} from '../models/${m}.js';`).join('\n')
    + `\n\nexport default [\n${rows.join('\n')}\n];\n`;
  return writeModule(res, SHEETS_DIR, name, text);
}

// POST /api/save-clip {name, model, view, w, h, frames, fps, mode, channels}
// — save an SDF clip: one model, posed over time.
//
// A clip is `[model, view, w, h, frames, fps, mode, channels]` — a SHEET ROW
// plus its timing and a dense table of numbers. A channel is
// `[target, one value per frame]`; a NUMBER target is a flat index into the
// model's parts, `part * 13 + column`, and a STRING target is a view dial. See
// src/js/core/sdfanim.js.
//
// What is refused is what would break the bake or the playback, and two rules
// are particular to time rather than to shape:
//   - `kind` and every column of a scatter HEADER are frozen. A part may not
//     change primitive or flag mid-clip, and a header's seed and spreads decide
//     the arrangement — move one and the mass reshuffles every frame.
//   - an `x` channel on a MIRRORED part may not go negative. The fold is
//     `x -> |x|`, so a negative frame has no half left to mirror and the part
//     vanishes for that frame only, which reads as a flicker rather than as a
//     mistake. The editor clamps it; this is the same clamp at the door.
const CLIP_MAX_FRAMES = 64;
const CLIP_MAX_PIXELS = 300000;
const CLIP_STRIDE = 13;
const CLIP_COLS = ['kind', 'x', 'y', 'z', 'rx', 'ry', 'rz', 'a', 'b', 'c',
  'round', 'blend', 'mat'];

/** A saved model's parts and material count, read back off the generated file.
 * Parsing rather than importing keeps this synchronous, and the file is
 * generated by saveModel above so its shape is known exactly. */
function modelInfo(name) {
  try {
    const src = fs.readFileSync(path.join(MODELS_DIR, name + '.js'), 'utf8');
    const a = src.indexOf('export default [[');
    const b = src.indexOf('\n], [', a);
    const c = src.indexOf('\n], {', b + 1);
    if (a < 0 || b < 0 || c < 0) return null;
    const parts = src.slice(a + 17, b).split(/[\s,]+/).filter(Boolean).map(Number);
    if (!parts.length || parts.length % CLIP_STRIDE || !parts.every(Number.isFinite)) return null;
    const mats = src.slice(b + 5, c).split('\n').filter(l => l.trim().startsWith('[')).length;
    return { parts, mats };
  } catch { return null; }
}

async function saveClip(res, { name, model, view = {}, w, h, frames, fps, mode,
  channels, groups = [] }) {
  if (!validName(name)) return send(res, 400, 'invalid name');
  if (!validName(model)) return send(res, 400, 'invalid model');
  const info = modelInfo(model);
  if (!info) return send(res, 400, `no model named ${model}`);

  if (!Number.isInteger(frames) || frames < 2 || frames > CLIP_MAX_FRAMES)
    return send(res, 400, `frames must be a whole number in 2..${CLIP_MAX_FRAMES}`);
  if (!Number.isInteger(fps) || fps < 1 || fps > 60)
    return send(res, 400, 'fps must be a whole number in 1..60');
  if (!Number.isInteger(mode) || mode < 0 || mode > 2)
    return send(res, 400, 'mode must be 0 (loop), 1 (pingpong) or 2 (once)');
  if (!Number.isInteger(w) || !Number.isInteger(h)
    || w < 1 || h < 1 || w > MAX_SPRITE || h > MAX_SPRITE)
    return send(res, 400, `size must be whole numbers in 1..${MAX_SPRITE}`);
  // Every frame is a sprite and march cost is per pixel, so this is the bake
  // guard the model's expanded-part cap is.
  if (w * h * frames > CLIP_MAX_PIXELS)
    return send(res, 400, `${frames} frames of ${w}x${h} is ${w * h * frames} px; `
      + `the cap is ${CLIP_MAX_PIXELS}`);
  if (typeof view !== 'object' || view === null || Array.isArray(view))
    return send(res, 400, 'invalid view');
  for (const [k, v] of Object.entries(view))
    if (!Number.isFinite(v)) return send(res, 400, `view.${k} must be a number`);

  const dials = (await dialsMod)?.VIEW_DIALS;
  if (!dials) return send(res, 500, 'sdftool dial list unavailable (see server log)');

  if (!Array.isArray(channels)) return send(res, 400, 'channels must be an array');
  const seen = new Set();
  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    if (!Array.isArray(ch) || ch.length !== frames + 1)
      return send(res, 400, `channel ${i}: expected a target and ${frames} values`);
    const [target, ...vals] = ch;
    if (!vals.every(Number.isFinite))
      return send(res, 400, `channel ${i}: every value must be a number`);
    if (seen.has(target)) return send(res, 400, `channel ${i}: ${target} is animated twice`);
    seen.add(target);

    if (typeof target === 'string') {
      if (!dials.includes(target))
        return send(res, 400, `channel ${i}: ${target} is not a view dial`);
      continue;
    }
    if (!Number.isInteger(target) || target < 0 || target >= info.parts.length)
      return send(res, 400, `channel ${i}: ${target} is not a field of ${model}`);
    const col = target % CLIP_STRIDE, row = (target - col) / CLIP_STRIDE;
    const kind = info.parts[row * CLIP_STRIDE];
    if (col === 0)
      return send(res, 400, `channel ${i}: kind cannot be animated — a part may not `
        + 'change primitive, flag or scatter-ness part-way through a clip');
    if (kind & MODEL_SCATTER)
      return send(res, 400, `channel ${i}: part ${row} is a scatter header, whose seed and `
        + 'spreads decide the arrangement — animate the template under it instead, '
        + 'and the whole mass moves together');
    if (col === 12 && !vals.every(v => Number.isInteger(v) && v >= 0 && v < info.mats))
      return send(res, 400, `channel ${i}: a mat channel must be whole numbers in `
        + `0..${info.mats - 1}`);
    // 128 is MIRROR. See src/js/core/sdf.js.
    if (col === 1 && (kind & 128) && vals.some(v => v < 0))
      return send(res, 400, `channel ${i}: part ${row} is mirrored, so its x may not go `
        + 'negative — the fold leaves no half to mirror and the part vanishes for '
        + 'that frame');
  }

  // THE RIG IS EDITOR-ONLY AND IS STILL CHECKED. It ships in the file as a
  // named export the game never imports, so a bad one costs no bytes and
  // breaks no build — but it would break the tool that has to read it back,
  // and a file this server wrote is a file it promised was loadable.
  if (!Array.isArray(groups) || groups.length > 32)
    return send(res, 400, 'groups must be an array of at most 32');
  const partRows = info.parts.length / CLIP_STRIDE;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (!g || typeof g.name !== 'string' || !/^[\w \-]{1,32}$/.test(g.name))
      return send(res, 400, `group ${i}: name must be 1..32 word characters`);
    if (!Array.isArray(g.pivot) || g.pivot.length !== 3 || !g.pivot.every(Number.isFinite))
      return send(res, 400, `group ${i}: pivot must be three numbers`);
    if (!Array.isArray(g.parts) || new Set(g.parts).size !== g.parts.length)
      return send(res, 400, `group ${i}: parts must be a list with no repeats`);
    for (const id of g.parts) {
      if (!Number.isInteger(id) || id < 0 || id >= partRows)
        return send(res, 400, `group ${i}: part ${id} is not in ${model}`);
      if (info.parts[id * CLIP_STRIDE] & MODEL_SCATTER)
        return send(res, 400, `group ${i}: part ${id} is a scatter header, which has no `
          + 'centre to swing about');
    }
  }

  const num = v => (Number.isInteger(v) ? v : +v.toFixed(4));
  const ident = importIdents([model]).get(model);
  const label = t => {
    if (typeof t === 'string') return '';
    const col = t % CLIP_STRIDE;
    return `  // part ${(t - col) / CLIP_STRIDE}, col ${col} (${CLIP_COLS[col]})`;
  };
  const rows = channels.map(([t, ...vals]) =>
    `  [${typeof t === 'string' ? `'${t}'` : t}, ${vals.map(num).join(', ')}],${label(t)}`);
  const text = '// generated by tools/sdftool — [model, view, w, h, frames, fps, mode, channels]\n'
    + '// see src/js/core/sdfanim.js\n'
    + `import ${ident} from '../models/${model}.js';\n\n`
    + `export default [${ident}, `
    + `{${Object.entries(view).map(([k, v]) => `${k}: ${num(v)}`).join(', ')}}, `
    + `${w}, ${h}, ${frames}, ${fps}, ${mode}, [\n${rows.join('\n')}\n]];\n\n`
    + '/** The editor\'s copy: the groups and their pivots, which resolved into the\n'
    + ' * numbers above and are kept only so they can be grabbed again. A NAMED\n'
    + ' * export, so a game that imports the default only never pays for it —\n'
    + ' * verified at 0 B. */\n'
    + `export const rig = {groups: [\n${groups.map(g =>
      `  {name: '${g.name}', pivot: [${g.pivot.map(num).join(', ')}], `
      + `parts: [${g.parts.join(', ')}]},`).join('\n')}\n]};\n`;
  return writeModule(res, CLIPS_DIR, name, text);
}

// Sprite count of a saved SDF sheet, or null if it cannot be read. The file
// is generated (saveSheet above), so its rows are one per line: a bracket row
// per sprite and a bare `0,` per tombstone. Counting them rather than
// importing keeps this sync — and a stage only needs the id RANGE, since a
// tombstoned id is legal and simply draws nothing.
function sheetSprites(name) {
  try {
    const src = fs.readFileSync(path.join(SHEETS_DIR, name + '.js'), 'utf8');
    const body = src.slice(src.indexOf('export default ['));
    let n = 0;
    for (const line of body.split('\n').slice(1)) {
      const t = line.trim();
      if (t.startsWith(']')) break;
      if (t) n++;
    }
    return n;
  } catch {
    return null;
  }
}

// A (kind, id) sprite source for a STAGE: kind 0..N-1 indexes the stage's
// sheets and id is a sprite id in that sheet; -2 (objects only) means no
// visual at all. There is no raw-drawing kind here — a canvas has no
// drawShape (see src/js/core/stage.js).
function validStageSource(k, id, sprites) {
  if (!Number.isInteger(k) || !Number.isInteger(id)) return false;
  if (k === -2) return true;             // marker; callers reject it for stamps
  return k >= 0 && k < sprites.length && id >= 0 && id < sprites[k];
}

function validStageObjects(o, sprites) {
  if (!Array.isArray(o)) return false;
  for (let i = 0; i < o.length;) {
    const [x, y, k, id, fx, n] = o.slice(i, i + 6);
    if (!Number.isInteger(x) || !Number.isInteger(y) || !validStageSource(k, id, sprites)
      || (fx !== 0 && fx !== 1) || !Number.isInteger(n) || n < 0 || n > 64) return false;
    i += 6;
    for (let j = 0; j < n; j++, i += 2)
      if (typeof o[i] !== 'string' || o[i].length > 32 || !Number.isFinite(o[i + 1])) return false;
  }
  return true;
}

// POST /api/save-stage {name, sheets, layers, aabbs, objects} — save a stage:
// `sheets` are src/js/sheets names (one baked canvas each), `layers` is an
// array of parallax layers in DRAW ORDER, each [rate, ...stamps] with stamps
// flat stride 5 [k,i,x,y,fx], `aabbs` flat stride 5 [type,x0,y0,x1,y1] with
// x1/y1 exclusive, and `objects` the variable-stride list above. See
// src/js/core/stage.js.
//
// The rate and the draw order belong to the LAYER, so there is no sort to
// validate any more: layers draw in list order and stamps draw in list order
// within one.
//
// There is no cap on the sheet count: 8 atlases was 10 RAM pages minus the
// palette page, and a canvas has no page budget.
function saveStage(res, { name, sheets = [], layers = [], aabbs = [], objects = [] }) {
  if (!validName(name)) return send(res, 400, 'invalid name');
  if (!Array.isArray(sheets) || sheets.length > 32 || !sheets.every(validName))
    return send(res, 400, 'invalid sheets');
  const sprites = [];
  for (const s of sheets) {
    const n = sheetSprites(s);
    if (n === null) return send(res, 400, `missing sheet: ${s}`);
    sprites.push(n);
  }
  if (!Array.isArray(layers) || layers.length > 64)
    return send(res, 400, 'invalid layers');
  for (let n = 0; n < layers.length; n++) {
    const L = layers[n];
    if (!Array.isArray(L) || L.length < 1 || (L.length - 1) % 5 !== 0)
      return send(res, 400, `invalid layer ${n}`);
    const rate = L[0];
    if (!Number.isFinite(rate) || rate < 0 || rate > 8)
      return send(res, 400, `invalid rate on layer ${n}`);
    for (let i = 1; i < L.length; i += 5) {
      const [k, id, x, y, fx] = L.slice(i, i + 5);
      const at = `layer ${n} stamp ${(i - 1) / 5}`;
      if (!validStageSource(k, id, sprites) || k === -2)
        return send(res, 400, `invalid stamp source at ${at}`);
      if (!Number.isInteger(x) || !Number.isInteger(y))
        return send(res, 400, `invalid stamp position at ${at}`);
      if (fx !== 0 && fx !== 1) return send(res, 400, `invalid stamp flip at ${at}`);
    }
  }
  if (!Array.isArray(aabbs) || aabbs.length % 5 !== 0 || !aabbs.every(Number.isInteger))
    return send(res, 400, 'invalid aabbs');
  for (let i = 0; i < aabbs.length; i += 5) {
    if (aabbs[i + 3] <= aabbs[i + 1] || aabbs[i + 4] <= aabbs[i + 2])
      return send(res, 400, `empty aabb at ${i / 5}`);
  }
  if (!validStageObjects(objects, sprites))
    return send(res, 400, 'invalid objects');
  // must match fileText() in tools/stagetool/state.js (byte counter)
  const lit = v => typeof v === 'string' ? JSON.stringify(v) : v;
  const text = sheets.map((n, i) => `import _${i} from '../sheets/${n}.js';\n`).join('')
    + `const S=[${sheets.map((_, i) => '_' + i).join(',')}];\n`
    + `export default [S,[${layers.map(L => `[${L.join(',')}]`).join(',')}],[${aabbs.join(',')}]`
    + `${objects.length ? `,[${objects.map(lit).join(',')}]` : ''}];\n`;
  return writeModule(res, STAGES_DIR, name, text);
}

const POSTS = {
  '/api/save-model': saveModel, '/api/save-sheet': saveSheet,
  '/api/save-clip': saveClip, '/api/save-stage': saveStage,
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (req.method === 'GET') {
    // The landing page: one link per editor, so the bare host is somewhere to
    // start rather than whichever tool happened to be mounted at the root.
    if (p === '/') return serveStatic(res, TOOLS_DIR, 'index.html');
    if (p === '/sdf') return serveStatic(res, SDFTOOL_DIR, 'index.html');
    if (p === '/stage') return serveStatic(res, STAGETOOL_DIR, 'index.html');
    // soundbox's own HTML/JS use paths relative to its own directory (e.g.
    // `gui/logo.png`), so unlike the other tools it's mounted as a root at
    // /soundbox/ rather than served at a bare path with a /soundboxtool/
    // asset prefix — a bare /soundbox (no trailing slash) would resolve
    // those relative paths against / and 404 every asset.
    if (p === '/soundbox') {
      res.writeHead(302, { Location: '/soundbox/' });
      return res.end();
    }
    if (p === '/soundbox/') return serveStatic(res, SOUNDBOXTOOL_DIR, 'index.html');
    if (p.startsWith('/soundbox/')) return serveStatic(res, SOUNDBOXTOOL_DIR, p.slice(10));
    if (p.startsWith('/sdftool/')) return serveStatic(res, SDFTOOL_DIR, p.slice(9));
    if (p.startsWith('/stagetool/')) return serveStatic(res, STAGETOOL_DIR, p.slice(11));
    if (p.startsWith('/src/')) return serveStatic(res, path.join(ROOT, 'src'), p.slice(5));
    if (p === '/api/models')
      return send(res, 200, JSON.stringify(listNames(MODELS_DIR)), 'application/json');
    if (p === '/api/sheets')
      return send(res, 200, JSON.stringify(listNames(SHEETS_DIR)), 'application/json');
    if (p === '/api/clips')
      return send(res, 200, JSON.stringify(listNames(CLIPS_DIR)), 'application/json');
    if (p === '/api/stages')
      return send(res, 200, JSON.stringify(listNames(STAGES_DIR)), 'application/json');
    return send(res, 404, 'not found');
  }

  if (req.method === 'POST' && POSTS[p]) {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return send(res, 400, 'invalid JSON');
      }
      return POSTS[p](res, parsed);
    });
    return;
  }

  send(res, 404, 'not found');
});

server.listen(PORT, () => {
  console.log(`tools: http://localhost:${PORT}`);
});
