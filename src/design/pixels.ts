// Colour correction from the pixels. The vision model reads hex values off a screenshot by eye, and
// a live run showed those estimates landing ΔE 3 to 20 from the real pixels: enough to pick the
// neighbouring token or turn an exact token into a false exception. The server has the image and
// the region bounds, so it measures the colours the model reported instead of trusting the guess.
// Only properties the model reported are corrected; nothing is added. PNG only.
import { decodePngRgba } from './png.js';
import { deltaE } from '../catalog/resolve.js';
import type { Layout, Region } from './layout.js';

type RGB = [number, number, number];
type Property = 'background' | 'color' | 'borderColor';

export interface ColorCorrection {
  regionId: string;
  property: Property;
  /** What the model reported. */
  model: string;
  /** What the pixels say. */
  sampled: string;
  deltaE: number;
}

/** A sampled colour further than this from the model's estimate is probably a different element; keep the estimate. */
const MAX_CORRECTION = 30;

interface Img { width: number; height: number; data: Uint8Array }

export function correctColorsFromPixels(layout: Layout, png: Buffer): { layout: Layout; corrections: ColorCorrection[] } {
  let img: Img;
  try { img = decodePngRgba(png); } catch { return { layout, corrections: [] }; }
  // Bounds are relative to the image; scale when the model's viewport differs from the pixel size.
  const sx = layout.viewport.width > 0 ? img.width / layout.viewport.width : 1;
  const sy = layout.viewport.height > 0 ? img.height / layout.viewport.height : 1;
  const corrections: ColorCorrection[] = [];
  const regions = layout.regions.map((r) => {
    const box = scaleBox(r.bounds, sx, sy, img);
    if (!box) return r;
    const style = { ...r.style };
    const measure: Record<Property, () => RGB | undefined> = {
      background: () => sampleBackground(img, box),
      borderColor: () => sampleBorder(img, box),
      color: () => sampleText(img, box, Boolean(r.style.borderColor)),
    };
    for (const property of ['background', 'borderColor', 'color'] as const) {
      const reported = style[property];
      const estimate = reported ? parseHex(reported) : undefined;
      if (!reported || !estimate) continue;
      const rgb = measure[property]();
      if (!rgb) continue;
      const d = round(deltaE(estimate, rgb));
      if (d === 0 || d > MAX_CORRECTION) continue;
      const sampled = hex(rgb);
      style[property] = sampled;
      corrections.push({ regionId: r.id, property, model: reported, sampled, deltaE: d });
    }
    return { ...r, style } satisfies Region;
  });
  const palette = corrections.length ? [...new Set(regions.flatMap((r) => [r.style.background, r.style.color, r.style.borderColor]).filter((c): c is string => Boolean(c)))] : layout.palette;
  return { layout: { ...layout, regions, palette }, corrections };
}

// ---- sampling ----------------------------------------------------------------------------------
interface Box { x0: number; y0: number; x1: number; y1: number }

function scaleBox(b: Region['bounds'], sx: number, sy: number, img: Img): Box | undefined {
  const x0 = Math.max(0, Math.round(b.x * sx));
  const y0 = Math.max(0, Math.round(b.y * sy));
  const x1 = Math.min(img.width, Math.round((b.x + b.width) * sx));
  const y1 = Math.min(img.height, Math.round((b.y + b.height) * sy));
  return x1 - x0 >= 2 && y1 - y0 >= 2 ? { x0, y0, x1, y1 } : undefined;
}

const px = (img: Img, x: number, y: number): RGB => { const i = (img.width * y + x) * 4; return [img.data[i]!, img.data[i + 1]!, img.data[i + 2]!]; };
const key = (c: RGB): number => (c[0] << 16) | (c[1] << 8) | c[2];
const fromKey = (k: number): RGB => [(k >> 16) & 255, (k >> 8) & 255, k & 255];

function mode(pixels: RGB[]): { color: RGB; share: number; count: number } | undefined {
  if (!pixels.length) return undefined;
  const counts = new Map<number, number>();
  for (const p of pixels) counts.set(key(p), (counts.get(key(p)) ?? 0) + 1);
  let best = 0;
  let bestN = 0;
  for (const [k, n] of counts) if (n > bestN) { best = k; bestN = n; }
  return { color: fromKey(best), share: bestN / pixels.length, count: bestN };
}

function pixelsIn(img: Img, b: Box): RGB[] {
  const out: RGB[] = [];
  for (let y = b.y0; y < b.y1; y++) for (let x = b.x0; x < b.x1; x++) out.push(px(img, x, y));
  return out;
}

/** The interior's dominant colour, inset past the border and rounded corners. */
function sampleBackground(img: Img, b: Box): RGB | undefined {
  const inset = Math.min(6, Math.floor(Math.min(b.x1 - b.x0, b.y1 - b.y0) / 4));
  const m = mode(pixelsIn(img, { x0: b.x0 + inset, y0: b.y0 + inset, x1: b.x1 - inset, y1: b.y1 - inset }));
  return m && m.share >= 0.5 ? m.color : undefined;
}

/**
 * The border: along each edge, scan a few lines either side of the reported bound (models are often
 * a pixel or two out) and keep the line whose colour is near-uniform and differs from the interior.
 * Corners are skipped so a radius does not dilute the line.
 */
function sampleBorder(img: Img, b: Box): RGB | undefined {
  const inside = sampleBackground(img, b);
  const w = b.x1 - b.x0;
  const h = b.y1 - b.y0;
  const cx = Math.min(12, Math.floor(w / 4));
  const cy = Math.min(12, Math.floor(h / 4));
  const lines: RGB[][] = [];
  for (let d = -3; d <= 3; d++) {
    const top = b.y0 + d;
    const bottom = b.y1 - 1 + d;
    const left = b.x0 + d;
    const right = b.x1 - 1 + d;
    const row = (y: number): RGB[] => (y < 0 || y >= img.height ? [] : Array.from({ length: Math.max(0, w - 2 * cx) }, (_, i) => px(img, b.x0 + cx + i, y)));
    const col = (x: number): RGB[] => (x < 0 || x >= img.width ? [] : Array.from({ length: Math.max(0, h - 2 * cy) }, (_, i) => px(img, x, b.y0 + cy + i)));
    lines.push(row(top), row(bottom), col(left), col(right));
  }
  const votes = new Map<number, number>();
  for (const line of lines) {
    const m = mode(line);
    if (!m || m.share < 0.8 || line.length < 4) continue;
    if (inside && deltaE(m.color, inside) < 3) continue;
    votes.set(key(m.color), (votes.get(key(m.color)) ?? 0) + 1);
  }
  let best: number | undefined;
  let bestN = 0;
  for (const [k, n] of votes) if (n > bestN) { best = k; bestN = n; }
  return best === undefined ? undefined : fromKey(best);
}

/**
 * Text: the glyphs' core colour. Large text has a solid fill, so the commonest of the pixels
 * furthest from the background is it. Small text is mostly anti-aliasing, and with subpixel
 * rendering each channel blends separately (blue and orange fringes), so the fill is the
 * per-channel extreme: the value each channel reaches where its subpixel is fully covered.
 */
function sampleText(img: Img, b: Box, bordered: boolean): RGB | undefined {
  const inset = bordered ? 3 : 0;
  const all = pixelsIn(img, { x0: b.x0 + inset, y0: b.y0 + inset, x1: b.x1 - inset, y1: b.y1 - inset });
  const bg = mode(all)?.color;
  if (!bg) return undefined;
  const far = all.map((p) => ({ p, d: deltaE(p, bg) })).filter((x) => x.d > 10);
  if (far.length < 4) return undefined;
  const max = Math.max(...far.map((x) => x.d));
  const core = mode(far.filter((x) => x.d >= max * 0.75).map((x) => x.p));
  if (core && core.count >= 8 && core.share >= 0.25) return core.color;
  // Per channel, the third-furthest value from the background (one stray pixel is not the fill).
  const extreme = ([0, 1, 2] as const).map((c) => {
    const vs = far.map((x) => x.p[c]).sort((a, z) => Math.abs(z - bg[c]) - Math.abs(a - bg[c]));
    return vs[Math.min(2, vs.length - 1)]!;
  }) as RGB;
  // Prefer a colour that is actually drawn: the nearest real pixel, when it is the same colour.
  const nearest = far.reduce((best, x) => { const d = deltaE(x.p, extreme); return d < best.d ? { p: x.p, d } : best; }, { p: extreme, d: Infinity });
  return nearest.d <= 3 ? nearest.p : extreme;
}

// ---- helpers -----------------------------------------------------------------------------------
function parseHex(v: string): RGB | undefined {
  const m = v.trim().toLowerCase().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return undefined;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const hex = (c: RGB): string => `#${c.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
const round = (n: number): number => Math.round(n * 100) / 100;
