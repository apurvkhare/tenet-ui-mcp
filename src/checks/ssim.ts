// Visual similarity (DESIGN.md §11 "visual", rev 3): SSIM over grayscale with a per-region map,
// between the agent's screenshot and a reference (the design's screenshot, or a story baseline).
// A number the dashboard can track; the judgment of whether a difference matters is the agent's.
import { PNG } from 'pngjs';

export interface Gray { width: number; height: number; data: Float32Array }

export function decodePng(buf: Buffer): Gray {
  const png = PNG.sync.read(buf);
  const data = new Float32Array(png.width * png.height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    const a = png.data[p + 3]! / 255;
    // Composite on white so transparent areas compare like a page background.
    const r = png.data[p]! * a + 255 * (1 - a);
    const g = png.data[p + 1]! * a + 255 * (1 - a);
    const b = png.data[p + 2]! * a + 255 * (1 - a);
    data[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { width: png.width, height: png.height, data };
}

/** Nearest-neighbour resize so two images can be compared at one size. */
export function resize(img: Gray, width: number, height: number): Gray {
  if (img.width === width && img.height === height) return img;
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y * img.height) / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x * img.width) / width));
      out[y * width + x] = img.data[sy * img.width + sx]!;
    }
  }
  return { width, height, data: out };
}

/** Mean SSIM over 8×8 windows (Wang et al. constants), plus a coarse per-region map. */
export function ssim(a: Gray, b: Gray, regions = 4): { score: number; map: number[][]; width: number; height: number } {
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const A = resize(a, width, height);
  const B = resize(b, width, height);
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const win = 8;
  const sums: number[][] = Array.from({ length: regions }, () => Array(regions).fill(0));
  const counts: number[][] = Array.from({ length: regions }, () => Array(regions).fill(0));
  let total = 0;
  let n = 0;
  for (let y = 0; y + win <= height; y += win) {
    for (let x = 0; x + win <= width; x += win) {
      let ma = 0, mb = 0;
      for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) { ma += A.data[(y + j) * width + x + i]!; mb += B.data[(y + j) * width + x + i]!; }
      ma /= win * win; mb /= win * win;
      let va = 0, vb = 0, cov = 0;
      for (let j = 0; j < win; j++) for (let i = 0; i < win; i++) { const da = A.data[(y + j) * width + x + i]! - ma; const db = B.data[(y + j) * width + x + i]! - mb; va += da * da; vb += db * db; cov += da * db; }
      va /= win * win - 1; vb /= win * win - 1; cov /= win * win - 1;
      const s = ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      total += s; n++;
      const ry = Math.min(regions - 1, Math.floor((y / height) * regions));
      const rx = Math.min(regions - 1, Math.floor((x / width) * regions));
      sums[ry]![rx]! += s; counts[ry]![rx]! += 1;
    }
  }
  const map = sums.map((row, ry) => row.map((v, rx) => (counts[ry]![rx]! ? Math.round((v / counts[ry]![rx]!) * 1000) / 1000 : 1)));
  return { score: n ? Math.round((total / n) * 1000) / 1000 : 1, map, width, height };
}
