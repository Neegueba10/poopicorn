/**
 * Node-side helpers shared by the noodletool's headless harnesses: read a
 * palette out of a PNG's top row, and write a PNG back out.
 *
 * Deliberately dependency-free and deliberately NOT part of the runtime — the
 * engine takes a plain RGB byte array and knows nothing about PNG.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { deflateSync, inflateSync } from 'node:zlib';

/** Palette RGB (3 bytes per entry) from the top row of a PNG. */
export function pngPalette(file) {
  const b = readFileSync(file);
  let o = 8, idat = [], w = 0;
  while (o < b.length) {
    const len = b.readUInt32BE(o);
    const type = b.slice(o + 4, o + 8).toString();
    const data = b.slice(o + 8, o + 8 + len);
    if (type === 'IHDR') w = data.readUInt32BE(0);
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * 4;
  // Row 0 only, and only filter 0 (none) or 1 (sub) — what this file uses.
  const f = raw[0];
  if (f > 1) throw new Error('unexpected PNG filter on row 0: ' + f);
  const row = Buffer.alloc(stride);
  for (let i = 0; i < stride; i++) {
    const a = i >= 4 ? row[i - 4] : 0;
    row[i] = f === 1 ? (raw[1 + i] + a) & 255 : raw[1 + i];
  }
  const pal = new Uint8Array(w * 3);
  for (let i = 0; i < w; i++) {
    pal[i * 3] = row[i * 4];
    pal[i * 3 + 1] = row[i * 4 + 1];
    pal[i * 3 + 2] = row[i * 4 + 2];
  }
  return pal;
}

const CRCT = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRCT[(c ^ buf[i]) & 255] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** Write RGBA bytes as a PNG. */
export function writePNG(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  const src = Buffer.from(rgba.buffer, rgba.byteOffset, w * h * 4);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    src.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

/** The ten example pictures, in the order the original cart lists them. */
export const PICTURES = [
  'spiral', 'tunnel', 'spiro', 'mandala', 'flower',
  'pipes', 'weave', 'kudzu', 'tree', 'shrooms',
];

/**
 * FNV-1a over the index buffer. The golden-hash suite's fingerprint: it has to
 * change when the pixels change and never otherwise.
 */
export function hashPixels(col) {
  let h = 0x811c9dc5;
  for (let i = 0; i < col.length; i++) {
    h ^= col[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
