// Advisory visual comparison (DESIGN.md §11 "visual" row): SSIM and a per-region map between the
// screenshots the agent captured and the design's image. A number to track, never a verdict.
import type { Row } from '../store/design-store.js';
import type { DesignRow } from '../tools/design-tools.js';
import { decodePng, ssim } from './ssim.js';
import type { Finding } from './static.js';

export interface Shot { story: string; theme: string; data?: string }

export function compareScreens(ref: Row<DesignRow>, refPng: Buffer, shots: Shot[], findings: Finding[], version: string): Record<string, unknown> {
  let reference;
  try { reference = decodePng(refPng); } catch { return { reference: ref.id, error: 'reference is not a PNG' }; }
  const out: Array<Record<string, unknown>> = [];
  for (const s of shots) {
    let img;
    try { img = decodePng(Buffer.from(s.data!, 'base64')); } catch { out.push({ story: s.story, theme: s.theme, error: 'screenshot is not a PNG' }); continue; }
    const r = ssim(reference, img);
    const low = r.map.flatMap((row, y) => row.map((v, x) => ({ v, x, y }))).filter((c) => c.v < 0.7);
    const verdict = r.score >= 0.85 && !low.length ? 'similar' : 'review';
    out.push({ story: s.story, theme: s.theme, ssim: r.score, regions: r.map, comparedAt: `${r.width}×${r.height}`, verdict, lowRegions: low.map((c) => `row ${c.y + 1} col ${c.x + 1} (${c.v})`) });
    if (verdict === 'review') findings.push({ check: 'visual', rule: 'visual/ssim', severity: 'info', message: `${s.story} [${s.theme}] SSIM ${r.score} vs the design${low.length ? `; regions below 0.7: ${low.map((c) => `r${c.y + 1}c${c.x + 1}`).join(', ')}` : ''}`, fix: { hint: 'advisory: look at both images side by side; the design screenshot is design://…/screenshot.png', resource: `design://${ref.id}/screenshot.png` }, id: `visual|ssim|${s.story}|${s.theme}` });
  }
  return { reference: `design://${ref.id}/screenshot.png`, dsVersion: version, screenshots: out, note: 'SSIM is a number to track; whether a difference matters is your call' };
}
