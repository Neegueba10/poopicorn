// Convert old sonant/sonant-x JS audio assets into SoundBox songs, from the
// command line:
//
//   npm run convert-song -- old.js                 -> old.soundbox.js
//   npm run convert-song -- old.js new.js          -> new.js
//   npm run convert-song -- a.js b.js c.js -d out  -> out/{a,b,c}.js (see below)
//
// This is mostly a headless front end for tools/soundbox/engine.js's own
// importer (normalizeSong, which dispatches to sonantXToSong for named-property
// songs) and exporter (songToJS) -- the same code path the editor runs when you
// drop a file on it, so the output is byte-identical to loading the file in
// soundbox and hitting Export JS, and the conversion rules live in one place.
// Dropping the file on the editor is still the better move when you want to
// hear it first; this is for batches.
//
// Three input shapes, because that's what the old assets actually look like:
//
//   * `export default {...}` -- one song, one output file.
//   * a module with named exports, or a classic script full of `var name = {}`
//     globals (the sonant-x editor's "save all" style: a couple of songs plus a
//     pile of one-shot sound effects in one file). Every song-shaped value gets
//     its own `<file>.<name>.soundbox.js`; anything else in the file (level
//     data, helper arrays) is ignored.
//   * a bare *instrument* (named properties, no songData) -- wrapped in a
//     one-note single-channel song so it can be opened, auditioned and tweaked
//     in the editor at all.
//   * a hand-minified SoundBox module (`export const song_instruments` +
//     `song_patterns`), unpacked per the long comment further down.
//
// Already-SoundBox songs pass through unchanged (the conversion is a fixed
// point), so it's safe to re-run over a directory of mixed exports. Binary .snd
// songs are not handled here -- open those in the editor.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

const SOUNDBOX = new URL('../tools/soundbox/', import.meta.url);

const args = process.argv.slice(2);
const dirIdx = Math.max(args.indexOf('-d'), args.indexOf('--out-dir'));
let outDir = null;
if (dirIdx >= 0) {
  outDir = args[dirIdx + 1];
  args.splice(dirIdx, 2);
}
if (!args.length) {
  console.error('usage: node scripts/convert-song.mjs <song.js> [out.js]');
  console.error('       node scripts/convert-song.mjs <song.js...> [-d <out-dir>]');
  process.exit(1);
}

// engine.js reads gInstrumentPresets off the global scope -- in the browser
// presets.js is a classic <script> that puts it there; here we run that same
// file and hand the result over before importing the module.
globalThis.gInstrumentPresets = new Function(
  fs.readFileSync(new URL('presets.js', SOUNDBOX), 'utf8') + ';return gInstrumentPresets'
)();
const engine = await import(new URL('engine.js', SOUNDBOX));

const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
const isSong = v => isObj(v) && Array.isArray(v.songData) && v.songData.length > 0;
// A sonant-x instrument on its own: the same named properties a channel has,
// minus the sequencer data.
const isInstrument = v => isObj(v) && typeof v.osc1_waveform === 'number' && !v.songData;

// Minimal sonant-x song around a single instrument: one channel, one pattern,
// one note (C-4) on row 0, at the sonant editor's own default tempo.
const songAroundInstrument = instr => ({
  rowLen: 5513,
  songData: [{ ...instr, p: [1], c: [{ n: [engine.NOTE_OFFSET + 48] }] }]
});

// Older SoundBox builds exported `export default name = {...}` -- an
// assignment to an undeclared identifier, which is a ReferenceError in a
// module (modules are always strict), so such a file can't be imported at all
// until the stray name is dropped. Nothing ever read it.
const LEGACY_NAMED_DEFAULT = /(export\s+default\s+)[A-Za-z_$][\w$]*\s*=\s*(?=[{[])/;

// Import ESM source that had to be patched first. Modules are cached by URL
// and a data: URL has no base, so this only works for self-contained files --
// true of every song export, none of which import anything.
const importSource = src => import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

//------------------------------------------------------------------------------
// Hand-minified SoundBox modules (`export const song_instruments/song_patterns`)
//
// A SoundBox song rewritten by hand to compress better for a jam entry: the
// instrument array keeps only the parameters that actually varied, notes are
// packed one character per slot, and the sequencer is one flat digit string.
// The custom player it was written for is gone, so the constants below are
// recovered from the file itself -- each one is pinned by evidence, not taste:
//
//   * Note characters. '(' (40) is the rest, so the byte is `note - 66`.
//     Base 106 is fixed by two independent checks: it puts instrument 2's kick
//     (OSC1_SEMI 116, i.e. -12) at ~65 Hz, and it makes instrument 0's opening
//     run C#2-E2-G#2-C#3... -- the C# minor arpeggio this arrangement of the
//     Moonlight Sonata's 3rd movement actually opens with. Bases an octave up
//     put the top of the same run above 4 kHz and the kick at 261 Hz.
//   * Envelope. The file's own comments say attack/sustain are stored as
//     `value ** 2 * 4` (what the player consumes); every one of them is
//     exactly 4x a perfect square, and no release value is, so release and
//     exp-decay are stored raw.
//   * Omitted parameters. Instrument 3 is recognisably tmp/sounds/footstep.js
//     with tweaks, and there every dropped parameter is 0 -- except FX_FILTER,
//     which is 2. That also happens to be what a player that ignores the field
//     does anyway: musicplayer.js filters `fxFilter == 3 ? band : fxFilter ==
//     1 ? high : low`, so anything else is a lowpass.
//------------------------------------------------------------------------------

// Instrument parameters in the order the minified array lists them; the array's
// last element is the note-column list.
const MIN_PARAMS = [
  'OSC1_VOL', 'OSC1_SEMI', 'OSC1_XENV', 'OSC2_VOL', 'OSC2_SEMI', 'OSC2_XENV', 'NOISE_VOL',
  'ENV_ATTACK', 'ENV_SUSTAIN', 'ENV_RELEASE', 'ENV_EXP_DECAY', 'LFO_FREQ',
  'FX_FREQ', 'FX_RESONANCE', 'FX_DRIVE', 'FX_PAN_AMT', 'FX_PAN_FREQ',
  'FX_DELAY_AMT', 'FX_DELAY_TIME', 'LFO_AMT'
];
const MIN_REST = 40, MIN_NOTE_BASE = 106;

function songFromMinified(m) {
  const rows = m.song_endPattern + 1;
  // Several rowLens means the player replayed the same rows at changing tempo,
  // which a SoundBox song can't express (it has exactly one rowLen). Convert at
  // the first one and say so.
  const tempos = Object.keys(m).filter(k => /^song_rowLen\d/.test(k)).map(k => m[k]);
  if (tempos.length > 1)
    console.error(`  note: source plays these rows ${tempos.length}x at rowLen ` +
      `${tempos.join('/')}; converted at ${tempos[0]} only`);
  return {
    rowLen: m.song_rowLen0 ?? m.song_rowLen,
    patternLen: m.song_patternLen,
    endPattern: m.song_endPattern,
    numChannels: m.song_numChannels,
    songData: m.song_instruments.map((instr, ch) => {
      const i = new Array(engine.NUM_INSTR_PARAMS).fill(0);
      MIN_PARAMS.forEach((name, k) => { i[engine[name]] = instr[k]; });
      i[engine.ENV_ATTACK] = Math.round(Math.sqrt(instr[MIN_PARAMS.indexOf('ENV_ATTACK')]) / 2);
      i[engine.ENV_SUSTAIN] = Math.round(Math.sqrt(instr[MIN_PARAMS.indexOf('ENV_SUSTAIN')]) / 2);
      i[engine.FX_FILTER] = 2;
      return {
        i,
        // song_patterns is channel-major: each channel's `rows` digits in turn.
        // (Confirmed by column counts -- channel 2 only has two note columns,
        // which only its channel-major slice stays within.)
        p: [...m.song_patterns.slice(ch * rows, (ch + 1) * rows)].map(Number),
        // One character per note slot, straight across all four note columns
        // of the pattern (so a string may run to patternLen * 4).
        c: instr[MIN_PARAMS.length].map(s => ({
          n: [...s].map(c => c.charCodeAt(0) === MIN_REST ? 0 : c.charCodeAt(0) - MIN_REST + MIN_NOTE_BASE),
          f: []
        }))
      };
    })
  };
}

// Everything in a file worth trying to convert, as [name, value] pairs. `name`
// is null for a default export (its output keeps the input's basename).
async function candidates(file) {
  let src = fs.readFileSync(file, 'utf8');

  if (/export\s+const\s+song_instruments\b/.test(src)) {
    // TypeScript, but only superficially: drop `as const` and the trailing
    // typed helper exports (they compute buffer sizes, nothing we need) and
    // what's left is plain JS data.
    src = src.replace(/\bas const\b/g, '').replace(/export const \w+\s*=\s*\([^)]*:[\s\S]*$/, '');
    return [[null, songFromMinified(await importSource(src))]];
  }

  if (/^\s*export\s+default\b/m.test(src)) {
    const mod = LEGACY_NAMED_DEFAULT.test(src)
      ? await importSource(src.replace(LEGACY_NAMED_DEFAULT, '$1'))
      : await import(pathToFileURL(path.resolve(file)).href);
    return [[null, mod.default]];
  }
  if (/^\s*export\b/m.test(src)) {
    const mod = await import(pathToFileURL(path.resolve(file)).href);
    return Object.entries(mod);
  }
  // Classic script: run it in a throwaway context (no require, no fs, no
  // process) and read back what it declared. `var` puts its names on that
  // context's global object, but `let`/`const` are lexical and never show up
  // there, so the declared names are collected explicitly by appending an
  // expression that mentions them all.
  const sandbox = vm.createContext({});
  const declared = [...src.matchAll(/^\s*(?:var|let|const)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1]);
  vm.runInContext(`${src}\n;globalThis.__declared = {${declared.join(',')}};`, sandbox, { filename: file });
  const { __declared, ...vars } = sandbox;
  const globals = Object.entries({ ...__declared, ...vars });
  // A file holding exactly one song doesn't need its global's name in the
  // output filename (these are usually just `var song = {...}`).
  const songs = globals.filter(([, v]) => isSong(v) || isInstrument(v));
  return songs.length === 1 ? [[null, songs[0][1]]] : globals;
}

// A compilation -- one array holding several songs -- becomes one entry each,
// suffixed by position so the outputs stay distinguishable.
const expandCompilations = entries => entries.flatMap(([name, v]) =>
  Array.isArray(v) && v.some(isSong)
    ? v.map((song, k) => [`${name ?? 'song'}${k}`, song])
    : [[name, v]]);

let failed = 0, wrote = 0;
// Exactly two bare arguments and no -d: in, out. (Deliberately not "does the
// second file exist yet" -- re-running a conversion over its own output is the
// normal case, not a signal. Converting several files at once needs -d.)
const explicitOut = args.length === 2 && !outDir ? args.pop() : null;

for (const inFile of args) {
  let found;
  try {
    found = expandCompilations(await candidates(inFile))
      .filter(([, v]) => isSong(v) || isInstrument(v));
  } catch (e) {
    console.error(`${inFile}: could not evaluate (${e.message})`);
    failed++;
    continue;
  }
  if (!found.length) {
    console.error(`${inFile}: no sonant-x or SoundBox song found`);
    failed++;
    continue;
  }

  const base = path.basename(inFile).replace(/(\.soundbox)?\.(js|mjs|ts)$/i, '');
  for (const [name, value] of found) {
    const instrumentOnly = isInstrument(value);
    const song = engine.normalizeSong(instrumentOnly ? songAroundInstrument(value) : value);
    if (!song) {
      console.error(`${inFile}${name ? ` [${name}]` : ''}: song-shaped, but did not validate`);
      failed++;
      continue;
    }
    // Converting into a separate directory is the "give me a converted copy of
    // this folder" case, so keep the original filenames there -- they're
    // meant to be dropped straight into src/js/sounds/. Writing next to the
    // sources instead has to disambiguate, hence the .soundbox.js suffix.
    const intoOwnDir = outDir && path.resolve(outDir) !== path.resolve(path.dirname(inFile));
    const outFile = (found.length === 1 && explicitOut) || path.join(
      outDir ?? path.dirname(inFile),
      `${base}${name ? '.' + name : ''}${intoOwnDir ? '' : '.soundbox'}.js`
    );
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, engine.songToJS(song));
    wrote++;

    const rows = song.endPattern + 1;
    console.log(`${inFile}${name ? ` [${name}]` : ''} -> ${outFile}  ` +
      (instrumentOnly
        ? '(instrument, wrapped as a one-note song)'
        : `(${song.numChannels} channels, ${rows} rows, ` +
          `${(rows * song.patternLen * song.rowLen / 44100).toFixed(1)}s)`));
  }
}
process.exitCode = failed && !wrote ? 1 : 0;
