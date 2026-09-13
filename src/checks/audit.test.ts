import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { CatalogStore } from '../catalog/store.js';
import { readResource } from '../resources.js';
import { DesignStore } from '../store/design-store.js';
import { auditCode, auditPage } from '../tools/audit-tools.js';
import type { ToolContext } from '../tools/context.js';
import { ingestDesign } from '../tools/design-tools.js';
import { contractChecks } from './contract.js';
import { contrastRatio, judgePage, PAGE_CHECKS, SnapshotSchema, treeNodes, type PageSnapshot } from './page.js';
import { parseSource } from './source.js';

const store = new CatalogStore('snapshots');
const data = store.load('0.4.0');
const designs = new DesignStore(mkdtempSync(join(tmpdir(), 'tenet-audit-')));
const ctx: ToolContext = { store, traceId: 't', publicUrl: 'http://x', principal: { sub: 'apurv', scopes: ['audit:run', 'design:ingest'], clientId: 'apurv' }, designs, sealKey: randomBytes(32) };
const here = new URL('.', import.meta.url);
const articleCard = readFileSync(new URL('./fixtures/ArticleCard.tsx.txt', here), 'utf8');
const snapshot = JSON.parse(readFileSync(new URL('./fixtures/snapshot.sample.json', here), 'utf8')) as PageSnapshot;

const toggle = `import { forwardRef } from 'react';
import { Button, Stack } from 'tenet-ui';

export interface ToggleBarProps {
  isPrimary?: boolean;
  isDanger?: boolean;
  isInvisible?: boolean;
  onToggle?: () => void;
}

export const ToggleBar = forwardRef<HTMLDivElement, ToggleBarProps>(function ToggleBar({ isPrimary, onToggle }, ref) {
  return (
    <Stack ref={ref} direction="horizontal">
      <Button style={{ marginLeft: '12px', color: '#c2502e' }} variant={isPrimary ? 'primary' : 'default'} onClick={onToggle}>Toggle</Button>
    </Stack>
  );
});
`;

test('parseSource: imports, props interface with prop kinds, components, tags, stories', () => {
  const s = parseSource({ path: 'src/ToggleBar.tsx', content: toggle }, 'tenet-ui');
  assert.deepEqual(s.packageImports, ['Button', 'Stack']);
  const i = s.interfaces.find((x) => x.name === 'ToggleBarProps')!;
  assert.equal(i.exported, true);
  assert.deepEqual(i.props.map((p) => `${p.name}:${p.kind}`), ['isPrimary:boolean', 'isDanger:boolean', 'isInvisible:boolean', 'onToggle:callback']);
  const c = s.components.find((x) => x.name === 'ToggleBar')!;
  assert.equal(c.forwardRef, true);
  assert.equal(c.exported, true);
  assert.equal(c.propsType, 'ToggleBarProps');
  assert.equal(s.tags.Button, 1);
  const card = parseSource({ path: 'src/ArticleCard.tsx', content: articleCard }, 'tenet-ui');
  assert.equal(card.components[0]!.forwardRef, false);
  const union = parseSource({ path: 'X.tsx', content: "export interface XProps { variant: 'a' | 'b' | 'c'; label: string }\nexport function X({ variant }: XProps) { return <div /> }" }, 'tenet-ui');
  assert.deepEqual(union.interfaces[0]!.props[0]!.values, ['a', 'b', 'c']);
  const stories = parseSource({ path: 'X.stories.tsx', content: "const meta = { title: 'Components/X', component: X };\nexport default meta;\nexport const Default = {};\nexport const WithIcon: Story = { args: {} };" }, 'tenet-ui');
  assert.deepEqual(stories.storyExports, ['Default', 'WithIcon']);
  assert.equal(stories.storyTitle, 'Components/X');
});

test('contractChecks: boolean explosion, restyled primitive, missing forwardRef; CSS override of Tenet-* classes', () => {
  const f = contractChecks(data, [
    { path: 'src/ToggleBar.tsx', content: toggle },
    { path: 'src/ArticleCard.tsx', content: articleCard },
    { path: 'src/ArticleCard.stories.tsx', content: "export const Default = { render: () => <Button style={{ color: '#000' }} /> };" },
    { path: 'src/app.css', content: '.page .Tenet-Button {\n  padding: 3px;\n  color: var(--fgColor-default);\n}\n.ok { gap: 2px; }' },
  ]);
  const rules = f.map((x) => `${x.rule}@${x.file}:${x.line}`);
  assert.ok(rules.includes('contract/boolean-explosion@src/ToggleBar.tsx:4'), rules.join('\n'));
  assert.match(f.find((x) => x.rule === 'contract/boolean-explosion')!.fix.hint, /variant/);
  assert.ok(rules.includes('contract/restyled-primitive@src/ToggleBar.tsx:14'));
  assert.equal(f.find((x) => x.rule === 'contract/restyled-primitive' && x.file === 'src/ToggleBar.tsx')!.fix.primitive, 'Button');
  assert.ok(rules.includes('contract/missing-forward-ref@src/ArticleCard.tsx:10'));
  assert.ok(!rules.some((r) => r.startsWith('contract/missing-forward-ref@src/ToggleBar')), 'forwardRef satisfies the rule');
  assert.ok(!rules.some((r) => r.includes('stories')), 'stories are not audited for contract rules');
  assert.ok(rules.includes('contract/restyled-primitive@src/app.css:2'));
  assert.ok(!rules.some((r) => r.includes('app.css:3')), 'a token value inside the override is not flagged');
});

test('audit_code: findings by rule, per-file summary, rules filter, auditId delta, audit:// resources', async () => {
  const files = [{ path: 'src/ArticleCard.tsx', content: articleCard }, { path: 'src/ToggleBar.tsx', content: toggle }];
  const first = await auditCode.run({ files, dsVersion: '0.4.0', theme: 'light', page: 1 }, ctx);
  const s = first.structured as { auditId: string; status: string; byRule: Record<string, number>; files: Array<{ path: string; findings: number; imports: string[]; components: string[] }>; checks: Record<string, { status: string }>; findings: Array<{ rule: string; severity: string; file: string }> };
  assert.equal(s.status, 'fail');
  assert.match(s.auditId, /^aud_/);
  assert.ok(s.byRule['contract/pixel-margin-layout'], JSON.stringify(s.byRule));
  assert.ok(s.byRule['contract/restyled-primitive']);
  assert.ok(s.byRule['deprecations/prop']);
  assert.ok(s.byRule['a11y/icon-only-without-name']);
  assert.equal(s.findings[0]!.severity, 'critical');
  const tb = s.files.find((f) => f.path === 'src/ToggleBar.tsx')!;
  assert.deepEqual(tb.imports, ['Button', 'Stack']);
  assert.deepEqual(tb.components, ['ToggleBar']);
  assert.equal(s.checks.deprecations!.status, 'fail');
  assert.match(first.text, /^FAIL audit of 2 file/);

  const only = await auditCode.run({ files, dsVersion: '0.4.0', rules: ['a11y'], theme: 'light', page: 1 }, ctx);
  const o = only.structured as { findings: Array<{ check: string }> };
  assert.ok(o.findings.length > 0 && o.findings.every((f) => f.check === 'a11y'));

  const fixedCard = articleCard.replace("<h1 style={{ color: '#c2410c', margin: 0 }}>{title}</h1>", '<Heading level={2}>{title}</Heading>').replace(' block>', ' fullWidth>').replace('<IconButton icon={<TrashIcon />} onClick={onDelete} />', '<IconButton icon={<TrashIcon />} aria-label="Delete article" onClick={onDelete} />');
  const second = await auditCode.run({ files: [{ path: 'src/ArticleCard.tsx', content: fixedCard }, { path: 'src/ToggleBar.tsx', content: toggle }], dsVersion: '0.4.0', theme: 'light', auditId: s.auditId, page: 1 }, ctx);
  const t = second.structured as { auditId: string; delta: { previous: string; fixed: number; new: number; remaining: number } };
  assert.equal(t.delta.previous, s.auditId);
  assert.ok(t.delta.fixed >= 4, JSON.stringify(t.delta));
  assert.equal(t.delta.new, 0);

  // audit:// is private and carries every finding.
  const findings = JSON.parse(readResource(store, `audit://${s.auditId}/findings.json`, { designs, sub: 'apurv' }).text!) as { findings: unknown[] };
  assert.equal(findings.findings.length, s.findings.length);
  const delta = JSON.parse(readResource(store, `audit://${t.auditId}/delta.json`, { designs, sub: 'apurv' }).text!) as { fixed: number };
  assert.equal(delta.fixed, t.delta.fixed);
  assert.throws(() => readResource(store, `audit://${s.auditId}/findings.json`, { designs, sub: 'someone-else' }), /no resource/);
  await assert.rejects(async () => auditCode.run({ files, dsVersion: '0.4.0', theme: 'light', auditId: 'aud_000000000000000000000000', page: 1 }, ctx), /not found/);
});

test('audit_code paginates by file when findings exceed the cap', async () => {
  const files = Array.from({ length: 40 }, (_, i) => ({ path: `src/Big${i}.tsx`, content: Array.from({ length: 8 }, (_, j) => `export const a${j} = <div style={{ color: '#${(0x100000 + i * 997 + j * 131).toString(16).slice(-6)}', padding: ${j + 3} }} />;`).join('\n') }));
  const r = await auditCode.run({ files, dsVersion: '0.4.0', theme: 'light', page: 1 }, ctx);
  const s = r.structured as { pagination?: { page: number; pages: number; keys: string[] }; findings: Array<{ file: string }> };
  assert.ok(s.pagination && s.pagination.pages > 1, JSON.stringify(s.pagination));
  assert.ok(s.findings.every((f) => s.pagination!.keys.includes(f.file)));
  assert.ok(Buffer.byteLength(JSON.stringify(r.structured)) <= auditCode.cap);
  const last = await auditCode.run({ files, dsVersion: '0.4.0', theme: 'light', page: 99 }, ctx);
  assert.equal((last.structured as { pagination: { page: number; pages: number } }).pagination.page, s.pagination.pages);
});

test('judgePage on a real capture of a compliant page: quiet on system components, loud on the page\'s own raw values', () => {
  const j = judgePage(data, SnapshotSchema.parse(snapshot), 'light', new Set(PAGE_CHECKS));
  assert.equal(j.checks.runtime!.status, 'pass');
  assert.equal(j.checks.contrast!.status, 'pass', j.checks.contrast!.detail);
  assert.equal(j.checks.a11y!.status, 'pass', j.checks.a11y!.detail);
  assert.equal(j.checks.tokens!.status, 'fail');
  assert.ok(j.stats.systemElements! > 200 && j.stats.elements! > 300);
  const gap = j.findings.find((f) => f.rule === 'tokens/no-token-dimension' && /row-gap: 2px/.test(f.message))!;
  assert.ok(gap, j.findings.map((f) => f.message).join('\n'));
  assert.equal(gap.fix.token, 'space-1');
  assert.ok(!j.findings.some((f) => f.rule === 'contrast/insufficient'));
  assert.ok(!j.findings.some((f) => f.rule === 'contrast/undocumented-pair'), 'white backgrounds resolve to bgColor-default, not fgColor-onEmphasis');
  assert.ok(j.findings.some((f) => f.rule === 'a11y/landmark-one-main'));
  assert.ok(!j.findings.some((f) => /Tenet-/.test(f.message) && f.check === 'tokens'), 'no token finding blames a system element');
});

test('judgePage: missing names, contrast below AA with documented pairs, focus order, runtime contract', () => {
  const base = SnapshotSchema.parse(snapshot);
  // A nameless button and a skipped heading level in the tree; axe did not report them.
  const tree = { format: 'aria-snapshot-yaml', tree: `- heading "Articles" [level=1]\n- button\n- heading "Deep" [level=4]\n- main:\n  - link "Read more"\n  - img\n` };
  const j = judgePage(data, { ...base, a11yTree: tree }, 'light', new Set(['a11y']));
  const rules = j.findings.map((f) => f.rule);
  assert.ok(rules.includes('a11y/missing-name'));
  assert.equal(j.findings.filter((f) => f.rule === 'a11y/missing-name').length, 2, rules.join(','));
  assert.equal(j.findings.find((f) => f.rule === 'a11y/missing-name')!.severity, 'critical');
  assert.ok(rules.includes('a11y/heading-order'));
  assert.ok(!rules.includes('a11y/landmark-one-main'));
  assert.equal(j.checks.a11y!.status, 'fail');
  // The same nameless button reported by axe: the tree-derived finding stands aside.
  const withAxe = judgePage(data, { ...base, a11yTree: tree, axe: { violations: [{ id: 'button-name', impact: 'critical', help: 'Buttons must have discernible text', nodes: [{ target: '.x > button', summary: 'no text' }] }] } }, 'light', new Set(['a11y']));
  assert.equal(withAxe.findings.filter((f) => f.rule === 'a11y/missing-name').length, 1);
  assert.ok(withAxe.findings.some((f) => f.rule === 'axe/button-name' && f.fix.primitive === 'IconButton'));

  const el = (i: number, tag: string, styles: Record<string, string>, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ path: `p${i}`, parent: i ? 0 : null, tag, rect: { x: 0, y: i * 40, width: 200, height: 20 }, styles: { 'font-size': '14px', 'font-weight': '400', ...styles }, ...extra });
  const synthetic = SnapshotSchema.parse({
    runtimeContract: { stylesheetLoaded: false, missingTokens: ['--fgColor-default'], colorMode: 'light' },
    consoleErrors: ['boom', 'boom'],
    computedStyles: { elements: [
      el(0, 'body', { 'background-color': 'rgb(255, 255, 255)' }),
      el(1, 'p', { color: 'rgb(200, 200, 200)' }, { text: 'faint' }),
      el(2, 'p', { color: 'rgb(42, 36, 27)', 'background-color': 'rgb(194, 80, 46)' }, { text: 'dark on accent' }),
      { ...el(3, 'button', {}, { text: 'second in DOM' }), rect: { x: 0, y: 0, width: 80, height: 20 } },
      { ...el(4, 'button', {}, { text: 'first in DOM' }), rect: { x: 0, y: 100, width: 80, height: 20 } },
    ].map((e, i) => (i === 3 ? { ...e, path: 'p4' } : i === 4 ? { ...e, path: 'p3' } : e)) },
  });
  // Swap so DOM order is p3 (y=100) then p4 (y=0)... build explicitly to be unambiguous.
  const elements = synthetic.computedStyles!.elements;
  const ordered = [elements[0]!, elements[1]!, elements[2]!, { ...elements[4]!, path: 'b-low', rect: { x: 0, y: 100, width: 80, height: 20 } }, { ...elements[3]!, path: 'b-high', rect: { x: 0, y: 0, width: 80, height: 20 } }];
  const s = judgePage(data, { ...synthetic, computedStyles: { elements: ordered } }, 'light', new Set(PAGE_CHECKS));
  const r = s.findings.map((f) => f.rule);
  assert.ok(r.includes('contract/require-styles-import'));
  assert.equal(s.findings.find((f) => f.rule === 'contract/require-styles-import')!.severity, 'critical');
  assert.equal(s.findings.filter((f) => f.rule === 'runtime/console-error').length, 1, 'console errors are deduplicated');
  const faint = s.findings.find((f) => f.rule === 'contrast/insufficient' && /rgb\(200, 200, 200\)/.test(f.message))!;
  assert.ok(faint, r.join(','));
  assert.match(faint.fix.hint, /documented fg\/bg pair/);
  const dark = s.findings.find((f) => f.rule === 'contrast/insufficient' && /rgb\(42, 36, 27\)/.test(f.message))!;
  assert.ok(dark);
  assert.match(dark.fix.hint, /fgColor-default is documented AA on: bgColor-default/);
  assert.ok(r.includes('a11y/focus-order'));
  assert.equal(s.checks.runtime!.status, 'fail');
  assert.equal(s.checks.contrast!.status, 'fail');
  assert.ok(Math.abs(contrastRatio([255, 255, 255], [0, 0, 0]) - 21) < 0.01);
  assert.equal(treeNodes({ format: 'playwright-accessibility-json', tree: { role: 'WebArea', children: [{ role: 'button', name: '' }, { role: 'heading', name: 'T', level: 2 }] } }).length, 3);
});

test('audit_page: report with auditId, delta, and advisory drift against a designId', async () => {
  const first = await auditPage.run({ snapshot, dsVersion: '0.4.0', page: 1 }, ctx);
  const s = first.structured as { auditId: string; status: string; page: { title: string; theme: string; elements: number }; checks: Record<string, { status: string }>; byRule: Record<string, number>; findings: unknown[] };
  assert.match(s.auditId, /^aud_/);
  assert.equal(s.status, 'fail');
  assert.equal(s.page.theme, 'light');
  assert.equal(s.checks.visual!.status, 'skipped');
  assert.ok(s.byRule['tokens/no-token-dimension']);
  assert.match(first.text, /^FAIL page audit \(The Tenet Review/);
  assert.ok(first.links!.some((l) => l.uri === `audit://${s.auditId}/findings.json`));

  const clean = { ...snapshot, computedStyles: { elements: (snapshot.computedStyles!.elements).filter((e) => !/cell-title/.test(e.className ?? '') && e.styles['font-size'] !== '13.3333px' && !/arial/i.test(e.styles['font-family'] ?? '')) } };
  const second = await auditPage.run({ snapshot: clean, dsVersion: '0.4.0', auditId: s.auditId, page: 1 }, ctx);
  const t = second.structured as { status: string; delta: { fixed: number; new: number; remaining: number }; findings: Array<{ severity: string }> };
  assert.equal(t.status, 'pass', JSON.stringify(t.findings));
  assert.ok(t.delta.fixed >= 3, JSON.stringify(t.delta));
  assert.equal(t.delta.new, 0);

  // Drift: a design image identical to the page screenshot scores 1.
  const png = (v: number): Buffer => { const p = new PNG({ width: 32, height: 32 }); p.data.fill(v); for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255; return PNG.sync.write(p); };
  const d = await ingestDesign.run({ source: { type: 'layout', layout: { viewport: { width: 32, height: 32 }, theme: 'light' as const, regions: [{ id: 'r1', role: 'page' }] } }, dsVersion: 'latest' }, ctx);
  const designId = (d.structured as { designId: string }).designId;
  designs.putBlob('apurv', designId, 'screenshot', png(120));
  const drift = await auditPage.run({ snapshot: { ...clean, screenshot: { ...snapshot.screenshot, data: png(120).toString('base64') } }, dsVersion: '0.4.0', designId, checks: ['visual'], page: 1 }, ctx);
  const v = drift.structured as { status: string; visual: { screenshots: Array<{ ssim: number; verdict: string }> }; checks: Record<string, { status: string }> };
  assert.equal(v.checks.visual!.status, 'pass');
  assert.equal(v.visual.screenshots[0]!.ssim, 1);
  assert.equal(v.status, 'pass');
  await assert.rejects(async () => auditPage.run({ snapshot: { nope: true }, dsVersion: '0.4.0', page: 1 }, ctx), /not a capture snapshot/);
  await assert.rejects(async () => auditPage.run({ snapshot, dsVersion: '0.4.0', designId: 'dsg_000000000000000000000000', page: 1 }, ctx), /not found/);
});
