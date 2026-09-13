// Path one end to end with a host-supplied layout: ingest → match (elicitation) → resolve_tokens
// (elicitation) → plan, plus principal isolation and requestState tamper checks.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CatalogStore } from '../catalog/store.js';
import { readResource } from '../resources.js';
import { DesignStore } from '../store/design-store.js';
import type { ToolContext } from '../tools/context.js';
import { ingestDesign, matchComponents, planComponent, resolveTokens } from '../tools/design-tools.js';

const store = new CatalogStore('snapshots');
const designs = new DesignStore(mkdtempSync(join(tmpdir(), 'tenet-designs-')));
const sealKey = randomBytes(32);
const ctxFor = (sub: string): ToolContext => ({ store, traceId: 't', publicUrl: 'http://127.0.0.1:3000', principal: { sub, scopes: ['ds:read', 'design:ingest'], clientId: sub }, designs, sealKey });
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
let requestState = '';
let matchId = '';

test('ingest_design stores a host-supplied layout and summarises it', async () => {
  const r = await ingestDesign.run({ source: { type: 'layout', layout }, dsVersion: '0.4.0', hints: { name: 'Settings' } }, ctx);
  const s = r.structured as { designId: string; summary: { regions: number; roles: Record<string, number> }; dsVersion: string; resources: string[] };
  assert.match(s.designId, /^dsg_[0-9a-f]{24}$/);
  assert.equal(s.summary.regions, 11);
  assert.equal(s.summary.roles.button, 2);
  assert.equal(s.dsVersion, '0.4.0');
  assert.deepEqual(s.resources, [`design://${s.designId}/layout.json`]);
  designId = s.designId;
});

test('ingest_design with an image needs vision; bad bytes are rejected first', async () => {
  await assert.rejects(async () => ingestDesign.run({ source: { type: 'image', data: Buffer.from('not an image at all').toString('base64') }, dsVersion: 'latest' }, ctx), /not PNG, JPEG/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
  await assert.rejects(async () => ingestDesign.run({ source: { type: 'image', data: png.toString('base64') }, dsVersion: 'latest' }, ctx), /vision is not configured/);
});

test('match_components asks about the Card-vs-Stack region and assigns the rest', async () => {
  const r = await matchComponents.run({ designId, strategy: 'ask' }, ctx);
  const s = r.structured as { resultType: string; inputRequests: Record<string, { params: { message: string; requestedSchema: { properties: { choice: { oneOf: Array<{ const: string }>; default: string } } } } }>; requestState: string; assignments: Array<{ regionId: string; component: string; confidence: number }> };
  assert.equal(s.resultType, 'input_required');
  const keys = Object.keys(s.inputRequests);
  assert.ok(keys.includes('region_r10'), `expected a question about r10, got ${keys.join(', ')}`);
  const q = s.inputRequests.region_r10!;
  const options = q.params.requestedSchema.properties.choice.oneOf.map((o) => o.const);
  assert.ok(options.includes('card') && options.includes('stack') && options.includes('auto'));
  assert.ok(s.requestState.startsWith('v1.'));
  const by = Object.fromEntries(s.assignments.map((a) => [a.regionId, a]));
  assert.equal(by.r3!.component, 'heading');
  assert.equal(by.r7!.component, 'button');
  assert.equal(by.r8!.component, 'icon-button');
  assert.equal(by.r9!.component, 'badge');
  assert.equal(by.r6!.component, 'text-input');
  assert.equal(by.r5!.component, 'form-control');
  requestState = s.requestState;
});

test('requestState: tampering, another principal, and changed arguments are rejected', async () => {
  const answers = { region_r10: { action: 'accept' as const, content: { choice: 'card' } } };
  await assert.rejects(async () => matchComponents.run({ designId, strategy: 'ask', inputResponses: answers, requestState: requestState.slice(0, -4) + 'AAAA' }, ctx), /seal verification failed/);
  await assert.rejects(async () => matchComponents.run({ designId, strategy: 'ask', inputResponses: answers, requestState }, ctxFor('someone-else')), /not found/);
  await assert.rejects(async () => matchComponents.run({ designId, strategy: 'auto', inputResponses: answers, requestState }, ctx), /arguments changed/);
});

test('answering completes the match; decline auto-resolves into unresolved[]', async () => {
  const r = await matchComponents.run({ designId, strategy: 'ask', inputResponses: { region_r10: { action: 'accept', content: { choice: 'card' } } }, requestState }, ctx);
  const s = r.structured as { resultType: string; matchId: string; assignments: Array<{ regionId: string; component: string; source: string; confidence: number }>; unresolved: unknown[] };
  assert.equal(s.resultType, 'complete');
  assert.match(s.matchId, /^mtc_/);
  const r10 = s.assignments.find((a) => a.regionId === 'r10')!;
  assert.equal(r10.component, 'card');
  assert.equal(r10.source, 'answered');
  matchId = s.matchId;

  const auto = await matchComponents.run({ designId, strategy: 'auto' }, ctx);
  const a = auto.structured as { resultType: string; unresolved: Array<{ regionId: string; options: string[] }> };
  assert.equal(a.resultType, 'complete');
  assert.ok(a.unresolved.some((u) => u.regionId === 'r10' && u.options.includes('card')));
});

test('resolve_tokens: exact values snap silently, the off-brand colour becomes a question', async () => {
  const r = await resolveTokens.run({ matchId, theme: 'light', tolerance: 'normal' }, ctx);
  const s = r.structured as { resultType: string; inputRequests: Record<string, { params: { message: string } }>; requestState: string };
  assert.equal(s.resultType, 'input_required');
  const [key, q] = Object.entries(s.inputRequests)[0]!;
  assert.match(q.params.message, /#ff00ff/);
  const done = await resolveTokens.run({ matchId, theme: 'light', tolerance: 'normal', inputResponses: { [key]: { action: 'accept', content: { choice: 'exception' } } }, requestState: s.requestState }, ctx);
  const d = done.structured as { resultType: string; tokenMap: Array<{ regionId: string; property: string; token?: string; status: string }>; exceptions: number };
  assert.equal(d.resultType, 'complete');
  assert.equal(d.exceptions, 1);
  const accent = d.tokenMap.find((t) => t.regionId === 'r7' && t.property === 'background')!;
  assert.equal(accent.token, 'bgColor-accent-emphasis');
  assert.equal(accent.status, 'exact');
  assert.equal(d.tokenMap.find((t) => t.regionId === 'r11')!.status, 'exception');
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
  const match = readResource(store, `design://${designId}/match.json`, { designs, sub: 'apurv' });
  assert.ok(JSON.parse(match.text!).assignments.length === 11);
  assert.throws(() => readResource(store, `design://${designId}/layout.json`, { designs, sub: 'someone-else' }), /no resource/);
  assert.throws(() => readResource(store, `design://${designId}/screenshot.png`, { designs, sub: 'apurv' }), /no screenshot/);
});
