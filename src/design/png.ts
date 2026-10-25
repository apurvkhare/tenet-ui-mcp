// PNG decoding to 8-bit RGBA, the shape pngjs's PNG.sync.read returns. Written against zlib.inflateSync
// because pngjs's sync reader subclasses zlib.Inflate the pre-class way, which Cloudflare Workers'
// node:zlib rejects. Handles every non-interlaced PNG: grey, RGB, palette, grey+alpha, RGBA at
// bit depths 1 to 16 (16-bit rescaled to 8 the way pngjs does). Throws on anything else.
import { inflateSync } from 'node:zlib';

export interface RgbaImage { width: number; height: number; data: Uint8Array }

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

export function decodePngRgba(buf: Uint8Array): RgbaImage {
  if (buf.length < 8 || SIGNATURE.some((b, i) => buf[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | undefined;
  let trns: Uint8Array | undefined;
  const idat: Uint8Array[] = [];
  for (let off = 8; off + 8 <= buf.length; ) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(buf[off + 4]!, buf[off + 5]!, buf[off + 6]!, buf[off + 7]!);
    const body = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(off + 8);
      height = view.getUint32(off + 12);
      depth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
    } else if (type === 'PLTE') palette = body;
    else if (type === 'tRNS') trns = body;
    else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const channels = CHANNELS[colorType];
  if (!width || !height || !channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('unsupported PNG header');
  if (interlace) throw new Error('interlaced PNGs are not supported');
  if (colorType === 3 && !palette) throw new Error('palette PNG without PLTE');

  const raw = inflateSync(concat(idat));
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3); // bytes per complete pixel, for the filters
  if (raw.length < height * (stride + 1)) throw new Error('truncated PNG data');

  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    unfilter(filter, src, line, prev, bpp);
    writeRow(line, out, y, width, depth, colorType, palette, trns);
    [prev, line] = [line, prev];
  }
  return { width, height, data: out };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function unfilter(filter: number, src: Uint8Array, line: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = src.length;
  switch (filter) {
    case 0: line.set(src); return;
    case 1: for (let i = 0; i < n; i++) line[i] = (src[i]! + (i >= bpp ? line[i - bpp]! : 0)) & 255; return;
    case 2: for (let i = 0; i < n; i++) line[i] = (src[i]! + prev[i]!) & 255; return;
    case 3: for (let i = 0; i < n; i++) line[i] = (src[i]! + (((i >= bpp ? line[i - bpp]! : 0) + prev[i]!) >> 1)) & 255; return;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        line[i] = (src[i]! + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      }
      return;
    default: throw new Error(`bad PNG filter ${filter}`);
  }
}

/** Sample `i` of a row as an 8-bit value (sub-byte depths scaled up, 16-bit rescaled like pngjs). */
function sample(line: Uint8Array, i: number, depth: number, scale: boolean): number {
  if (depth === 8) return line[i]!;
  if (depth === 16) return Math.round((((line[i * 2]! << 8) | line[i * 2 + 1]!) * 255) / 65535);
  const perByte = 8 / depth;
  const v = (line[Math.floor(i / perByte)]! >> (8 - depth * ((i % perByte) + 1))) & ((1 << depth) - 1);
  return scale ? Math.round((v * 255) / ((1 << depth) - 1)) : v;
}

function writeRow(line: Uint8Array, out: Uint8Array, y: number, width: number, depth: number, colorType: number, palette: Uint8Array | undefined, trns: Uint8Array | undefined): void {
  for (let x = 0, o = y * width * 4; x < width; x++, o += 4) {
    if (colorType === 3) {
      const idx = sample(line, x, depth, false);
      out[o] = palette![idx * 3]!; out[o + 1] = palette![idx * 3 + 1]!; out[o + 2] = palette![idx * 3 + 2]!;
      out[o + 3] = trns && idx < trns.length ? trns[idx]! : 255;
    } else if (colorType === 0 || colorType === 4) {
      const g = sample(line, x * (colorType === 4 ? 2 : 1), depth, true);
      out[o] = out[o + 1] = out[o + 2] = g;
      out[o + 3] = colorType === 4 ? sample(line, x * 2 + 1, depth, true) : 255;
    } else {
      const c = colorType === 6 ? 4 : 3;
      out[o] = sample(line, x * c, depth, true); out[o + 1] = sample(line, x * c + 1, depth, true); out[o + 2] = sample(line, x * c + 2, depth, true);
      out[o + 3] = c === 4 ? sample(line, x * c + 3, depth, true) : 255;
    }
  }
}
