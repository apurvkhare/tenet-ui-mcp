// Colour correction from the pixels, against tenet-ui's own story baselines: every colour on those
// screens is a real token, so a correct sample lands on the token's exact value. The "model" values
// are what a live vision run (claude-opus-5, 2026-10-16) reported for the same screenshots.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CatalogStore } from '../catalog/store.js';
import { DesignStore } from '../store/design-store.js';
import type { ToolContext } from '../tools/context.js';
import { ingestDesign, matchComponents, resolveTokens } from '../tools/design-tools.js';
import { normalizeLayout, type Layout } from './layout.js';
import { correctColorsFromPixels } from './pixels.js';

const baseline = (id: string): Buffer => readFileSync(`snapshots/0.4.0/baselines/${id}.light.png`);
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const layoutOf = (regions: unknown[]): Layout => normalizeLayout({ viewport: { width: 1280, height: 800 }, theme: 'light', regions } as never);

const STAT_CARDS = layoutOf([
  { id: 'r1', role: 'page', parent: null, bounds: box(0, 0, 1280, 800), style: { background: '#ffffff', color: '#1a1008' } },
  { id: 'r3', role: 'card', parent: 'r1', bounds: box(16, 16, 299, 86), style: { background: '#ffffff', borderColor: '#e3d9cb' } },
  { id: 'r4', role: 'label', parent: 'r3', bounds: box(32, 35, 60, 14), text: ['Published'], style: { color: '#6d6054', fontSize: '12px' } },
  { id: 'r5', role: 'text', parent: 'r3', bounds: box(32, 55, 44, 28), text: ['128'], style: { color: '#1a1008', fontSize: '26px' } },
  { id: 'r7', role: 'label', parent: 'r1', bounds: box(348, 35, 50, 14), text: ['In review'], style: { color: '#6d6054' } },
]);

test('vision colour estimates are re-measured to the exact token values on the page', () => {
  const { layout, corrections } = correctColorsFromPixels(STAT_CARDS, baseline('components-grid--stat-cards'));
  const style = (id: string) => layout.regions.find((r) => r.id === id)!.style;
  assert.equal(style('r3').borderColor, '#ddd2bf', 'borderColor-default, not borderColor-muted');
  assert.equal(style('r5').color, '#2a241b', 'fgColor-default (large text)');
  assert.equal(style('r4').color, '#6e6049', 'fgColor-muted (12px text with subpixel fringes)');
  assert.equal(style('r7').color, '#6e6049');
  assert.equal(style('r1').color, '#2a241b', 'a container takes its text colour from the text inside it');
  assert.equal(style('r3').background, '#ffffff', 'a correct estimate is left alone');
  assert.ok(!corrections.some((c) => c.property === 'background'));
  assert.ok(corrections.every((c) => c.deltaE > 0 && c.deltaE <= 30 && c.model !== c.sampled));
  assert.ok(layout.palette.includes('#ddd2bf') && !layout.palette.includes('#e3d9cb'), 'the palette follows the corrections');
});

test('error state: the danger border and text are measured; nothing is added that the model did not report', () => {
  const field = layoutOf([
    { id: 'r3', role: 'label', parent: null, bounds: box(16, 15, 48, 18), text: ['Email', '*'], style: { color: '#1f1f1f' } },
    { id: 'r4', role: 'input', parent: null, bounds: box(16, 36, 1248, 32), text: ['not-an-email'], style: { background: '#ffffff', color: '#1f1f1f', borderColor: '#8b1a10' } },
    { id: 'r5', role: 'caption', parent: null, bounds: box(16, 71, 149, 15), text: ['Enter a valid email address.'], style: { color: '#8b1a10' } },
    { id: 'r6', role: 'text', parent: null, bounds: box(400, 400, 100, 20), style: {} },
  ]);
  const { layout } = correctColorsFromPixels(field, baseline('components-formcontrol--with-error'));
  const style = (id: string) => layout.regions.find((r) => r.id === id)!.style;
  assert.equal(style('r4').borderColor, '#8a2817', 'fgColor-danger');
  assert.equal(style('r4').color, '#2a241b', 'the typed text, not the red border');
  assert.equal(style('r5').color, '#8a2817');
  assert.equal(style('r3').color, '#2a241b', 'the label, not its red asterisk');
  assert.deepEqual(style('r6'), field.regions[3]!.style, 'unreported properties stay null');
});

test('a non-PNG or undecodable image changes nothing', () => {
  const r = correctColorsFromPixels(STAT_CARDS, Buffer.from('not a png'));
  assert.equal(r.layout, STAT_CARDS);
  assert.deepEqual(r.corrections, []);
});

test('ingest_design corrects the model\'s colours before matching, and resolve_tokens then finds exact tokens', async () => {
  const designs = new DesignStore(mkdtempSync(join(tmpdir(), 'tenet-pixels-')));
  const image = baseline('components-grid--stat-cards');
  const ctx: ToolContext = {
    store: new CatalogStore('snapshots'), traceId: 't', publicUrl: 'http://127.0.0.1:3000', designs,
    principal: { sub: 'apurv', scopes: ['design:ingest'], clientId: 'apurv' },
    vision: async () => ({ layout: STAT_CARDS, model: 'stub', usage: { inputTokens: 1, outputTokens: 1 } }),
  };
  const ing = await ingestDesign.run({ source: { type: 'image', data: image.toString('base64') }, dsVersion: '0.4.0' } as never, ctx);
  assert.match(ing.text, /colour\(s\) the model estimated were re-measured from the pixels/);
  const cc = ing.structured.colorCorrections as { count: number; maxDeltaE: number };
  assert.ok(cc.count >= 5 && cc.maxDeltaE > 9);
  assert.deepEqual(Object.keys(ing.structured.vision as object).sort(), ['model', 'usage'], 'vision carries model and usage only, not a second copy of the layout');
  const m = await matchComponents.run({ designId: ing.structured.designId as string }, ctx);
  const t = await resolveTokens.run({ matchId: m.structured.matchId as string, theme: 'light', tolerance: 'normal' } as never, ctx);
  const map = t.structured.tokenMap as Array<{ regionId: string; property: string; token?: string; status: string }>;
  const entry = (id: string, property: string) => map.find((e) => e.regionId === id && e.property === property)!;
  assert.deepEqual([entry('r3', 'borderColor').token, entry('r3', 'borderColor').status], ['borderColor-default', 'exact']);
  assert.deepEqual([entry('r5', 'color').token, entry('r5', 'color').status], ['fgColor-default', 'exact']);
  assert.deepEqual([entry('r4', 'color').token, entry('r4', 'color').status], ['fgColor-muted', 'exact']);
  assert.equal(t.structured.exceptions, 0, 'no false exceptions');
});
