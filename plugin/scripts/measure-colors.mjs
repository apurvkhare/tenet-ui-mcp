#!/usr/bin/env node
// Measure a layout's colours from the screenshot, on the agent's machine, so the screenshot never
// has to leave it. The agent's model describes the screenshot as a layout tree for ingest_design;
// its hex values are read by eye and land ΔE 3 to 20 off the real pixels, enough to pick the
// neighbouring token. This script re-measures every colour the layout reports from the pixels
// inside the region's bounds and writes the layout back. No model, no network, no dependencies.
//
//   node measure-colors.mjs <screenshot.png> <layout.json> [--out <file>]
//
// <layout.json> is the object you pass as source.layout. The corrected layout goes to --out
// (default: back into <layout.json>); the corrections are printed to stdout as JSON.
// Skip this for a design from Figma: its values are exact already.
//
// A port of src/design/pixels.ts in tenet-ui-mcp (the server runs the same measurement when an
// agent sends the screenshot instead). src/design/pixels.test.ts checks the two give identical
// corrections; change both together.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

/** A sampled colour further than this from the estimate is probably a different element; keep the estimate. */
const MAX_CORRECTION = 30;
const PROPERTIES = ['background', 'borderColor', 'color'];

/**
 * Measure every colour `layout` reports from `png`. Returns the layout with those colours replaced
 * and the list of changes. Only reported properties are corrected; nothing is added.
 */
export function measureColors(layout, png) {
  const img = decodePng(png);
  // Bounds are in the viewport's space; scale to the image's pixels. Same default as the server.
  const viewport = layout.viewport ?? { width: 1280, height: 800 };
  const sx = viewport.width > 0 ? img.width / viewport.width : 1;
  const sy = viewport.height > 0 ? img.height / viewport.height : 1;
  const colorCorrections = [];
  const regions = (layout.regions ?? []).map((r) => {
    const box = r.bounds ? scaleBox(r.bounds, sx, sy, img) : undefined;
    if (!box) return r;
    const reportedStyle = r.style ?? {};
    const style = { ...reportedStyle };
    const measure = {
      background: () => sampleBackground(img, box),
      borderColor: () => sampleBorder(img, box),
      color: () => sampleText(img, box, Boolean(reportedStyle.borderColor)),
    };
    for (const property of PROPERTIES) {
      const reported = style[property];
      const estimate = reported ? parseHex(reported) : undefined;
      if (!reported || !estimate) continue;
      const rgb = measure[property]();
      if (!rgb) continue;
      const d = round(deltaE(estimate, rgb));
      if (d === 0 || d > MAX_CORRECTION) continue;
      const sampled = hex(rgb);
      style[property] = sampled;
      colorCorrections.push({ regionId: r.id, property, model: reported, sampled, deltaE: d });
    }
    return { ...r, style };
  });
  const palette = colorCorrections.length ? [...new Set(regions.flatMap((r) => [r.style?.background, r.style?.color, r.style?.borderColor]).filter(Boolean))] : layout.palette;
  return { layout: { ...layout, regions, ...(palette ? { palette } : {}) }, colorCorrections };
}

// ---- sampling (as src/design/pixels.ts) ------------------------------------------------------------
function scaleBox(b, sx, sy, img) {
  const x0 = Math.max(0, Math.round(b.x * sx));
  const y0 = Math.max(0, Math.round(b.y * sy));
  const x1 = Math.min(img.width, Math.round((b.x + b.width) * sx));
  const y1 = Math.min(img.height, Math.round((b.y + b.height) * sy));
  return x1 - x0 >= 2 && y1 - y0 >= 2 ? { x0, y0, x1, y1 } : undefined;
}

const px = (img, x, y) => { const i = (img.width * y + x) * 4; return [img.data[i], img.data[i + 1], img.data[i + 2]]; };
const key = (c) => (c[0] << 16) | (c[1] << 8) | c[2];
const fromKey = (k) => [(k >> 16) & 255, (k >> 8) & 255, k & 255];

function mode(pixels) {
  if (!pixels.length) return undefined;
  const counts = new Map();
  for (const p of pixels) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
  let best = 0;
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return { color: fromKey(best), share: bestN / pixels.length, count: bestN };
}

function pixelsIn(img, b) {
  const out = [];
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) out.push(px(img, x, y));
  return out;
}

/** The interior's dominant colour, inset past the border and rounded corners. */
function sampleBackground(img, b) {
  const inset = Math.min(6, Math.floor(Math.min(b.x1 - b.x0, b.y1 - b.y0) / 4));
  const m = mode(pixelsIn(img, { x0: b.x0 + inset, y0: b.y0 + inset, x1: b.x1 - inset, y1: b.y1 - inset }));
  return m && m.share >= 0.5 ? m.color : undefined;
}

/** The border: the near-uniform line, a few pixels either side of each edge, that differs from the interior. */
function sampleBorder(img, b) {
  const inside = sampleBackground(img, b);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const cx = Math.min(12, Math.floor(w / 4));
  const cy = Math.min(12, Math.floor(h / 4));
  const lines = [];
  for (let d = -3; d <= 3; d++) {
    const top = b.y0 + d;
    const bottom = b.y1 - 1 + d;
    const left = b.x0 + d;
    const right = b.x1 - 1 + d;
    const row = (y) => (y < 0 || y >= img.height ? [] : Array.from({ length: Math.max(0, w - 2 * cx) }, (_, i) => px(img, b.x0 + cx + i, y)));
    const col = (x) => (x < 0 || x >= img.width ? [] : Array.from({ length: Math.max(0, h - 2 * cy) }, (_, i) => px(img, x, b.y0 + cy + i)));
    lines.push(row(top), row(bottom), col(left), col(right));
  }
  const votes = new Map();
  for (const line of lines) {
    const m = mode(line);
    if (!m || m.share < 0.8 || line.length < 4) continue;
    if (inside && deltaE(m.color, inside) < 3) continue;
    votes.set(key(m.color), (votes.get(key(m.color)) ?? 0) + 1);
  }
  let best;
  let bestN = 0;
  for (const [k, n] of votes) if (n > bestN) { best = k; bestN = n; }
  return best === undefined ? undefined : fromKey(best);
}

/** Text: the glyphs' solid fill, or for small subpixel-rendered text the per-channel extreme. */
function sampleText(img, b, bordered) {
  const inset = bordered ? 3 : 0;
  const all = pixelsIn(img, { x0: b.x0 + inset, y0: b.y0 + inset, x1: b.x1 - inset, y1: b.y1 - inset });
  const bg = mode(all)?.color;
  if (!bg) return undefined;
  const far = all.map((p) => ({ p, d: deltaE(p, bg) })).filter((x) => x.d > 10);
  if (far.length < 4) return undefined;
  const max = Math.max(...far.map((x) => x.d));
  const core = mode(far.filter((x) => x.d >= max * 0.75).map((x) => x.p));
  if (core && core.count >= 8 && core.share >= 0.25) return core.color;
  const extreme = [0, 1, 2].map((c) => {
    const vs = far.map((x) => x.p[c]).sort((a, z) => Math.abs(z - bg[c]) - Math.abs(a - bg[c]));
    return vs[Math.min(2, vs.length - 1)];
  });
  const nearest = far.reduce((best, x) => { const d = deltaE(x.p, extreme); return d < best.d ? { p: x.p, d } : best; }, { p: extreme, d: Infinity });
  return nearest.d <= 3 ? nearest.p : extreme;
}

// ---- colour (as src/catalog/resolve.ts and src/design/pixels.ts) -----------------------------------
function toLab([r, g, b]) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const [R, G, B] = [lin(r), lin(g), lin(b)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = (R * 0.2126 + G * 0.7152 + B * 0.0722) / 1.0;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}
function deltaE(a, b) {
  const [l1, a1, b1] = toLab(a);
  const [l2, a2, b2] = toLab(b);
  return Math.sqrt((l1 - l2) ** 2 + (a1 - a2) ** 2 + (b1 - b2) ** 2);
}
function parseHex(v) {
  const m = String(v).trim().toLowerCase().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return undefined;
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const hex = (c) => `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
const round = (n) => Math.round(n * 100) / 100;

// ---- PNG decoding (RGBA 8-bit, normalised the way pngjs does) ---------------------------------------
export function decodePng(buf) {
  if (!buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new Error('not a PNG (colours can only be measured from a PNG)');
  let pos = 8;
  let ihdr;
  let palette;
  let trns;
  const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], colorType: data[9], interlace: data[12] };
    else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
  }
  if (!ihdr) throw new Error('PNG has no IHDR chunk');
  const { width, height, depth, colorType, interlace } = ihdr;
  if (interlace) throw new Error('interlaced PNGs are not supported; save the screenshot without interlacing');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const lines = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = lines.subarray(y * stride, (y + 1) * stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? out[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[i] = v & 255;
    }
    prev = out;
  }
  const sample = (y, i) => {
    const row = y * stride;
    if (depth === 8) return lines[row + i];
    if (depth === 16) return lines.readUInt16BE(row + i * 2);
    const bit = i * depth;
    return (lines[row + (bit >> 3)] >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
  };
  const max = 2 ** depth - 1;
  const scale = (v) => (colorType === 3 ? v : Math.floor((v * 255) / max + 0.5));
  const transColor = trns && colorType === 0 ? [trns.readUInt16BE(0)] : trns && colorType === 2 ? [trns.readUInt16BE(0), trns.readUInt16BE(2), trns.readUInt16BE(4)] : undefined;
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (k) => sample(y, x * channels + k);
      const o = (y * width + x) * 4;
      let rgba;
      if (colorType === 3) {
        const idx = s(0);
        if (!palette || idx * 3 + 2 >= palette.length) throw new Error(`index ${idx} not in palette`);
        rgba = [palette[idx * 3], palette[idx * 3 + 1], palette[idx * 3 + 2], trns && idx < trns.length ? trns[idx] : 255];
      } else {
        const v = colorType === 0 ? [s(0), s(0), s(0), max] : colorType === 4 ? [s(0), s(0), s(0), s(1)] : colorType === 2 ? [s(0), s(1), s(2), max] : [s(0), s(1), s(2), s(3)];
        const transparent = transColor && (transColor.length === 1 ? transColor[0] === v[0] : transColor[0] === v[0] && transColor[1] === v[1] && transColor[2] === v[2]);
        rgba = transparent ? [0, 0, 0, 0] : v.map(scale);
      }
      data[o] = rgba[0]; data[o + 1] = rgba[1]; data[o + 2] = rgba[2]; data[o + 3] = rgba[3];
    }
  }
  return { width, height, data };
}

// ---- CLI ----------------------------------------------------------------------------------------------
function main(argv) {
  const usage = 'usage: node measure-colors.mjs <screenshot.png> <layout.json> [--out <file>]';
  const args = [...argv];
  const outAt = args.indexOf('--out');
  const out = outAt >= 0 ? args.splice(outAt, 2)[1] : undefined;
  const [pngPath, layoutPath] = args;
  if (!pngPath || !layoutPath || (outAt >= 0 && !out)) { console.error(usage); process.exit(2); }
  try {
    const layout = JSON.parse(readFileSync(layoutPath, 'utf8'));
    const result = measureColors(layout, readFileSync(pngPath));
    const target = resolve(out ?? layoutPath);
    writeFileSync(target, JSON.stringify(result.layout, null, 2) + '\n');
    const maxDeltaE = Math.max(0, ...result.colorCorrections.map((c) => c.deltaE));
    process.stdout.write(JSON.stringify({ layout: target, count: result.colorCorrections.length, maxDeltaE, colorCorrections: result.colorCorrections }, null, 2) + '\n');
  } catch (err) {
    console.error(`measure-colors: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2));
