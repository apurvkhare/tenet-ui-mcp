// Path one end to end with a host-supplied layout: ingest → match → resolve_tokens → plan, plus
// principal isolation. The server decides every close match and off-scale value and explains it;
// nothing in this path asks the user.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CatalogStore } from '../catalog/store.js';
import { readResource } from '../resources.js';
import { DesignStore } from '../store/design-store.js';
import type { ToolContext, ToolError } from '../tools/context.js';
import { ingestDesign, matchComponents, noVisionMessage, planComponent, resolveTokens } from '../tools/design-tools.js';
import { normalizeLayout } from './layout.js';
import { assignRegions, type Assignment } from './match.js';
import { resolveLayoutTokens } from './tokens.js';
import { visionFromEnv } from './vision.js';

const store = new CatalogStore('snapshots');
const designs = new DesignStore(mkdtempSync(join(tmpdir(), 'tenet-designs-')));
const ctxFor = (sub: string): ToolContext => ({ store, traceId: 't', publicUrl: 'http://127.0.0.1:3000', principal: { sub, scopes: ['ds:read', 'design:ingest'], clientId: sub }, designs });
const ctx = ctxFor('apurv');

const tokens = store.load('0.4.0').tokens;
const val = (name: string): string => { const t = tokens.find((x) => x.name === name)!; return String(t.themed ? t.light : t.value); };

const layout = {
  viewport: { width: 1280, height: 800 },
  theme: 'light' as const,
  regions: [
    { id: 'r1', role: 'page', label: 'Settings page', parent: null, bounds: { x: 0, y: 0, width: 1280, height: 800 }, style: { background: val('bgColor-default') } },
    { id: 'r2', role: 'section', label: 'Notification settings', parent: 'r1', bounds: { x: 240, y: 80, width: 800, height: 520 }, style: { background: val('bgColor-default'), borderColor: val('borderColor-default'), borderRadius: val('borderRadius-medium'), padding: '24px' } },
    { id: 'r3', role: 'heading', label: 'Section title', text: ['Notification settings'], parent: 'r2', bounds: { x: 264, y: 104, width: 500, height: 36 }, style: { fontSize: '28px', fontWeight: '600' } },
    { id: 'r4', role: 'text', label: 'Intro copy', text: ['Choose how we contact you.'], parent: 'r2', bounds: { x: 264, y: 148, width: 500, height: 20 }, style: { color: val('fgColor-muted'), fontSize: '14px' } },
    { id: 'r5', role: 'field', label: 'Email field', text: ['Email address'], parent: 'r2', bounds: { x: 264, y: 200, width: 400, height: 72 } },
    { id: 'r6', role: 'input', label: 'Email input', text: ['you@example.com'], parent: 'r5', bounds: { x: 264, y: 228, width: 400, height: 40 }, style: { borderColor: val('borderColor-default'), borderRadius: '5px' } },
    { id: 'r7', role: 'button', label: 'Primary action', text: ['Save changes'], parent: 'r2', states: ['primary'], bounds: { x: 264, y: 520, width: 140, height: 36 }, style: { background: val('bgColor-accent-emphasis'), color: '#ffffff', borderRadius: '5px' } },
    { id: 'r8', role: 'button', label: 'Delete', text: [], parent: 'r2', states: ['icon-only', 'danger'], bounds: { x: 1000, y: 104, width: 32, height: 32 } },
    { id: 'r9', role: 'badge', label: 'Unread count', text: ['3'], parent: 'r2', bounds: { x: 700, y: 104, width: 24, height: 20 } },
    { id: 'r10', role: 'container', label: 'Digest options', parent: 'r2', bounds: { x: 264, y: 300, width: 760, height: 180 }, style: { background: val('bgColor-muted') } },
    { id: 'r11', role: 'text', label: 'Off-brand note', text: ['Beta feature'], parent: 'r10', bounds: { x: 280, y: 320, width: 200, height: 18 }, style: { color: '#ff00ff' } },
  ],
};

let designId = '';
let matchId = '';

test('ingest_design stores a host-supplied layout and summarises it', async () => {
  const r = await ingestDesign.run({ source: { type: 'layout', layout }, dsVersion: '0.4.0', hints: { name: 'Settings' } }, ctx);
  const s = r.structured as { designId: string; summary: { regions: number; roles: Record<string, number> }; dsVersion: string; resources: string[] };
  assert.match(s.designId, /^dsg_[0-9a-f]{24}$/);
  assert.equal(s.summary.regions, 11);
  assert.equal(s.summary.roles.button, 2);
  assert.equal(s.dsVersion, '0.4.0');
  assert.deepEqual(s.resources, [`design://${s.designId}/layout.json`]);
  assert.ok(!('colorCorrections' in s) || (s as Record<string, unknown>).colorCorrections === undefined, 'no image, nothing measured');
  assert.equal((s as Record<string, unknown>).vision, undefined, 'no model call');
  designId = s.designId;
});

test('ingest_design with an image alone needs vision, which is off by default: the error tells the agent to send a layout with the image', async () => {
  await assert.rejects(async () => ingestDesign.run({ source: { type: 'image', data: Buffer.from('not an image at all').toString('base64') }, dsVersion: 'latest' }, ctx), /not PNG, JPEG/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  await assert.rejects(async () => ingestDesign.run({ source: { type: 'image', data: png.toString('base64') }, dsVersion: '0.4.0' }, ctx), (err: ToolError) => {
    assert.equal(err.code, 'vision_unavailable');
    assert.equal(err.message, noVisionMessage('0.4.0'));
    assert.match(err.message, /Describe the screenshot yourself as a layout tree/);
    assert.match(err.message, /measure its colours locally with the tenet-ui plugin's scripts\/measure-colors\.mjs/);
    assert.match(err.message, /source \{type: "layout", layout\}/);
    assert.match(err.message, /add this image as image\.data/, 'the server-side fallback');
    assert.match(err.message, /ds:\/\/0\.4\.0\/layout-schema/);
    return true;
  });
});

test('vision is opt-in: a model key alone does not turn it on', () => {
  assert.equal(visionFromEnv({}).vision, undefined);
  const keyOnly = visionFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' });
  assert.equal(keyOnly.vision, undefined);
  assert.match(keyOnly.status, /VISION=on is not/);
  assert.equal(visionFromEnv({ ANTHROPIC_AUTH_TOKEN: 'x', VISION: 'off' }).vision, undefined);
});

test('ds://{v}/layout-schema gives the agent the rules, roles, component ids, a JSON Schema and an example that ingests', async () => {
  const r = JSON.parse(readResource(store, 'ds://0.4.0/layout-schema').text!) as { dsVersion: string; rules: string[]; roles: string[]; components: string[]; schema: { properties: Record<string, unknown> }; example: unknown };
  assert.equal(r.dsVersion, '0.4.0');
  assert.ok(r.roles.includes('button') && r.roles.includes('card'));
  assert.ok(r.components.includes('card') && r.components.includes('icon-button'));
  assert.ok(r.rules.some((x) => /candidates/.test(x)) && r.rules.some((x) => /measure script/.test(x)) && r.rules.some((x) => /Figma/.test(x)));
  assert.match((r as unknown as { measure: string }).measure, /measure-colors\.mjs <screenshot\.png> <layout\.json>/);
  assert.ok('regions' in r.schema.properties);
  const ing = await ingestDesign.run({ source: { type: 'layout', layout: r.example }, dsVersion: '0.4.0' } as never, ctx);
  assert.equal((ing.structured.summary as { regions: number }).regions, 4);
  for (const id of (r.example as { regions: Array<{ candidates: string[] }> }).regions.flatMap((x) => x.candidates)) assert.ok(r.components.includes(id), `example candidate ${id} is a real id`);
});

test('match_components decides the Card-vs-Stack close call from the layout guideline and never asks', async () => {
  const r = await matchComponents.run({ designId }, ctx);
  const s = r.structured as Record<string, unknown> & { matchId: string; decisions: number; assignments: Assignment[] };
  for (const k of ['resultType', 'inputRequests', 'requestState', 'unresolved', 'questions']) assert.ok(!(k in s), `no ${k} in the result`);
  assert.match(s.matchId, /^mtc_/);
  const by = Object.fromEntries(s.assignments.map((a) => [a.regionId, a]));
  const r10 = by.r10!;
  assert.equal(r10.component, 'stack');
  assert.equal(r10.source, 'decided');
  assert.equal(r10.decision!.basis, 'guideline');
  assert.equal(r10.decision!.runnerUp.component, 'card');
  assert.match(r10.decision!.reason, /inside r2, which is a Card; a Card never contains another Card/);
  assert.ok(r10.decision!.cites.includes('ds://0.4.0/guidelines/layout'));
  assert.ok(r10.confidence >= 0.85);
  assert.equal(by.r1!.component, 'stack', 'the page root is a Stack');
  assert.equal(by.r2!.component, 'card');
  assert.equal(by.r3!.component, 'heading');
  assert.equal(by.r7!.component, 'button');
  assert.equal(by.r8!.component, 'icon-button');
  assert.equal(by.r9!.component, 'badge');
  assert.equal(by.r6!.component, 'text-input');
  assert.equal(by.r5!.component, 'form-control');
  assert.equal(s.decisions, s.assignments.filter((a) => a.source === 'decided').length);
  assert.match(r.text, /r10 → stack over card/);
  matchId = s.matchId;

  const again = (await matchComponents.run({ designId }, ctx)).structured as { assignments: Assignment[] };
  assert.deepEqual(again.assignments.map((a) => [a.component, a.decision?.reason]), s.assignments.map((a) => [a.component, a.decision?.reason]), 'decisions are deterministic');
  await assert.rejects(async () => matchComponents.run({ designId }, ctxFor('someone-else')), /not found/);
});

// One region per rule family, so each decision path is exercised on its own.
const decided = (regions: unknown[], viewport = { width: 1280, height: 800 }): Record<string, Assignment> =>
  Object.fromEntries(assignRegions(store.load('0.4.0'), normalizeLayout({ viewport, theme: 'light', regions } as never)).map((a) => [a.regionId, a]));
const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

test('Card or plain section: self-contained groups, repeated tiles and plain flow are decided by the layout test', () => {
  const muted = val('bgColor-muted');
  const by = decided([
    { id: 'p', role: 'page', parent: null, bounds: box(0, 0, 1280, 800) },
    // A tinted group with its own heading and action: self-contained, so a Card.
    { id: 'g', role: 'container', label: 'Billing', parent: 'p', bounds: box(40, 40, 600, 200), style: { background: muted } },
    { id: 'gh', role: 'heading', text: ['Billing'], parent: 'g', bounds: box(56, 56, 300, 28) },
    { id: 'gb', role: 'button', text: ['Update card'], parent: 'g', bounds: box(56, 180, 120, 36) },
    // A tinted block with only copy: it flows with the page, so a plain section.
    { id: 'f', role: 'container', label: 'Intro', parent: 'p', bounds: box(40, 260, 600, 80), style: { background: muted } },
    { id: 'ft', role: 'text', text: ['Welcome back.'], parent: 'f', bounds: box(56, 276, 300, 20) },
    // Two tinted tiles of the same size in a row: summary tiles are Cards.
    { id: 't1', role: 'container', label: 'Revenue', parent: 'p', bounds: box(700, 40, 240, 120), style: { background: muted } },
    { id: 't2', role: 'container', label: 'Orders', parent: 'p', bounds: box(960, 40, 240, 120), style: { background: muted } },
  ]);
  for (const [id, component, reason] of [['g', 'card', /own heading and action/], ['f', 'stack', /flows with the page/], ['t1', 'card', /repeated tiles/], ['t2', 'card', /repeated tiles/]] as const) {
    const a = by[id]!;
    assert.equal(a.component, component, `${id}: ${a.decision?.reason ?? a.candidates.map((c) => c.component).join(',')}`);
    if (a.decision) { assert.match(a.decision.reason, reason); assert.equal(a.decision.basis, 'guideline'); assert.ok(a.decision.runnerUp.component); }
  }
});

test('other close pairs follow their guideline: count vs word, actions vs a value, sortable rows', () => {
  const pick = (region: Record<string, unknown>): Assignment => decided([{ parent: null, bounds: box(0, 0, 120, 36), ...region }])[region.id as string]!;
  for (const [region, component, runnerUp, reason] of [
    [{ id: 's', role: 'status', text: ['Passing'] }, 'tag', 'badge', /labelled status word is a Tag/],
    [{ id: 'c', role: 'status', text: ['12'] }, 'badge', 'tag', /"12" is a count/],
    [{ id: 'd', role: 'dropdown', label: 'Row actions', text: ['More actions'] }, 'menu', 'select', /a list of actions is a Menu/],
    [{ id: 't', role: 'table', label: 'Orders', states: ['sortable'] }, 'data-table', 'table', /sorts, filters or selects rows/],
  ] as const) {
    const a = pick(region);
    assert.equal(a.source, 'decided', `${region.id} should be a close call`);
    assert.equal(a.component, component);
    assert.equal(a.decision!.runnerUp.component, runnerUp);
    assert.equal(a.decision!.basis, 'guideline');
    assert.match(a.decision!.reason, reason);
    assert.ok(a.decision!.cites.length > 0);
  }
});

test('resolve_tokens decides every value: exact, snapped with its delta and rule, or a documented exception; never asks', async () => {
  const r = await resolveTokens.run({ matchId, theme: 'light', tolerance: 'normal' }, ctx);
  const d = r.structured as Record<string, unknown> & { tokenMap: Array<{ regionId: string; property: string; token?: string; status: string; delta?: number; decision?: { rule: string; reason: string; cites: string[] } }>; exceptions: number };
  for (const k of ['resultType', 'inputRequests', 'requestState', 'questions']) assert.ok(!(k in d), `no ${k} in the result`);
  assert.equal(d.exceptions, 1);
  const accent = d.tokenMap.find((t) => t.regionId === 'r7' && t.property === 'background')!;
  assert.equal(accent.token, 'bgColor-accent-emphasis');
  assert.equal(accent.status, 'exact');
  const magenta = d.tokenMap.find((t) => t.regionId === 'r11')!;
  assert.equal(magenta.status, 'exception');
  assert.ok(magenta.delta! > 8);
  assert.match(magenta.decision!.reason, /visibly different colour; snapping would change what it means/);
  assert.ok(magenta.decision!.cites.includes('ds://0.4.0/guidelines/color'));
  assert.match(r.text, /#ff00ff/);
});

test('off-scale rules: dimensions snap to the scale, near colours snap, far colours and strict stay exceptions', () => {
  const data = store.load('0.4.0');
  const accent = val('bgColor-accent-emphasis'); // #c2502e
  const layout = normalizeLayout({ viewport: { width: 400, height: 200 }, theme: 'light', regions: [
    { id: 'a', role: 'container', parent: null, bounds: box(0, 0, 400, 200), style: { padding: '19px', borderRadius: '9px', background: '#c5532f' } },
    { id: 'b', role: 'text', parent: 'a', bounds: box(0, 0, 100, 20), style: { color: '#00ff00', fontSize: '15px' } },
  ] } as never);
  assert.notEqual(accent, '#c5532f');
  const normal = Object.fromEntries(resolveLayoutTokens(data, layout, 'light', 'normal').entries.map((e) => [`${e.regionId}.${e.property}`, e]));
  const pad = normal['a.padding']!;
  assert.equal(pad.status, 'snapped');
  assert.ok(pad.delta! > 2, 'beyond the space tolerance');
  assert.match(pad.decision!.reason, /contract allows only scale steps/);
  assert.ok(pad.decision!.cites.includes('ds://0.4.0/guidelines/layout'));
  assert.equal(normal['a.background']!.status, 'snapped', 'ΔE within 2× tolerance snaps');
  assert.equal(normal['a.background']!.token, 'bgColor-accent-emphasis');
  assert.equal(normal['b.color']!.status, 'exception');
  const white = resolveLayoutTokens(data, normalizeLayout({ viewport: { width: 400, height: 200 }, theme: 'light', regions: [
    { id: 'w', role: 'container', parent: null, bounds: box(0, 0, 400, 200), style: { background: '#ffffff', color: '#ffffff' } },
  ] } as never), 'light', 'normal').entries;
  assert.deepEqual(white.map((e) => [e.property, e.token]), [['background', 'bgColor-default'], ['color', 'fgColor-onEmphasis']], 'the role picks the token group');
  assert.ok(normal['b.color']!.decision!.reason.length > 20);
  const strict = resolveLayoutTokens(data, layout, 'light', 'strict').entries;
  assert.ok(strict.filter((e) => e.status !== 'exact').every((e) => e.status === 'exception' && e.decision?.rule === 'tolerance strict'));
  const loose = resolveLayoutTokens(data, layout, 'light', 'loose').entries;
  assert.ok(loose.every((e) => e.status !== 'exception'), 'loose snaps everything that has a nearest token');
});

test('plan_component: tree, imports, prop mapping, files, exceptions, catalog excerpts', async () => {
  const r = await planComponent.run({ matchId, name: 'NotificationSettings' }, ctx);
  type Node = { regionId: string; component: string | null; props: Record<string, unknown>; children: Node[] };
  const s = r.structured as { planId: string; plan: { imports: string[]; tree: Node[]; files: Array<{ path: string }>; exceptions: unknown[]; catalog: Array<{ component: string }>; stories: string[]; tests: string[] } };
  assert.match(s.planId, /^pln_/);
  const p = s.plan;
  assert.ok(p.imports.some((l) => /import \{ .*Button.*Heading.* \} from 'tenet-ui'/.test(l)), p.imports.join('\n'));
  assert.equal(p.tree[0]!.regionId, 'r1');
  const section = p.tree[0]!.children.find((c) => c.regionId === 'r2')!;
  const save = section.children.find((c) => c.regionId === 'r7')!;
  assert.equal(save.component, 'button');
  assert.equal(save.props.variant, 'primary');
  assert.equal(save.props.children, 'Save changes');
  const heading = section.children.find((c) => c.regionId === 'r3')!;
  assert.equal(heading.props.level, 2);
  assert.equal(p.files.length, 5);
  assert.equal(p.exceptions.length, 1);
  const plan = s.plan as unknown as { decisions: Array<{ regionId: string; picked: string; runnerUp: string; reason: string }>; notes: string[] };
  const r10 = plan.decisions.find((x) => x.regionId === 'r10')!;
  assert.deepEqual([r10.picked, r10.runnerUp], ['stack', 'card']);
  assert.ok(!('unresolved' in p));
  assert.ok(plan.notes.some((n) => /do not ask anyone to choose/.test(n)));
  assert.ok(p.catalog.some((c) => c.component === 'button'));
  assert.ok(p.stories.includes('Default'));
  assert.ok(p.tests.some((t) => /axe/.test(t)));
  assert.ok(r.links?.some((l) => l.uri === `design://${designId}/plans/${s.planId}.md`));
});

test('design:// resources are private to the principal', () => {
  const mine = readResource(store, `design://${designId}/layout.json`, { designs, sub: 'apurv' });
  assert.equal(JSON.parse(mine.text!).layout.regions.length, 11);
  const plan = readResource(store, `design://${designId}/plan.md`, { designs, sub: 'apurv' });
  assert.match(plan.text!, /^# Plan: NotificationSettings/);
  assert.match(plan.text!, /## Decisions \(close matches the server settled\)/);
  assert.match(plan.text!, /## Documented exceptions/);
  const match = readResource(store, `design://${designId}/match.json`, { designs, sub: 'apurv' });
  assert.ok(JSON.parse(match.text!).assignments.length === 11);
  assert.throws(() => readResource(store, `design://${designId}/layout.json`, { designs, sub: 'someone-else' }), /no resource/);
  assert.throws(() => readResource(store, `design://${designId}/screenshot.png`, { designs, sub: 'apurv' }), /no screenshot/);
});
