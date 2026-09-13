import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PNG } from 'pngjs';
import { CatalogStore } from '../catalog/store.js';
import { DesignStore } from '../store/design-store.js';
import { runChecks } from '../tools/checks-tools.js';
import type { ToolContext } from '../tools/context.js';
import { ingestDesign } from '../tools/design-tools.js';
import { judgeResults, ResultsSchema } from './judge.js';
import { decodePng, ssim } from './ssim.js';
import { staticChecks } from './static.js';

const store = new CatalogStore('snapshots');
const data = store.load('0.4.0');
const designs = new DesignStore(mkdtempSync(join(tmpdir(), 'tenet-checks-')));
const ctx: ToolContext = { store, traceId: 't', publicUrl: 'http://x', principal: { sub: 'apurv', scopes: ['checks:run', 'design:ingest'], clientId: 'apurv' }, designs, sealKey: randomBytes(32) };
const here = new URL('.', import.meta.url);
const sample = JSON.parse(readFileSync(new URL('./fixtures/results.sample.json', here), 'utf8'));
const articleCard = readFileSync(new URL('./fixtures/ArticleCard.tsx.txt', here), 'utf8');

test('staticChecks: raw colour, raw element, deprecated prop, unlabeled IconButton, unknown token, unknown export', () => {
  const files = [
    { path: 'src/ArticleCard.tsx', content: articleCard },
    { path: 'src/styles.css', content: '.x { padding: 13px; color: var(--fgColor-mutd); gap: var(--space-3); }' },
    { path: 'src/main.tsx', content: "import { createRoot } from 'react-dom/client';\nimport { Buton } from 'tenet-ui';\ncreateRoot(document.body).render(null);" },
  ];
  const f = staticChecks(data, files);
  const rules = f.map((x) => `${x.rule}@${x.file}:${x.line}`);
  assert.ok(rules.includes('tokens/no-raw-color@src/ArticleCard.tsx:14'), rules.join('\n'));
  assert.ok(rules.includes('contract/prefer-component@src/ArticleCard.tsx:14'));
  assert.ok(rules.includes('deprecations/prop@src/ArticleCard.tsx:17'));
  assert.ok(rules.includes('a11y/icon-only-without-name@src/ArticleCard.tsx:18'));
  assert.ok(rules.includes('tokens/no-raw-spacing@src/styles.css:1'));
  assert.ok(rules.includes('tokens/no-unknown-token@src/styles.css:1'));
  assert.ok(rules.includes('contract/require-styles-import@src/main.tsx:1'));
  assert.ok(rules.includes('types/unknown-export@src/main.tsx:2'));
  const color = f.find((x) => x.rule === 'tokens/no-raw-color')!;
  assert.match(color.fix.hint, /var\(--/);
  const dep = f.find((x) => x.rule === 'deprecations/prop')!;
  assert.equal(dep.fix.replacement, 'fullWidth');
  const unknown = f.find((x) => x.rule === 'tokens/no-unknown-token')!;
  assert.match(unknown.fix.hint, /--fgColor-muted/);
  const exp = f.find((x) => x.rule === 'types/unknown-export')!;
  assert.match(exp.fix.hint, /Button/);
  // A commented-out colour does not fire; a space token does not fire.
  assert.equal(staticChecks(data, [{ path: 'a.css', content: '/* #ff0000 */ .a { gap: var(--space-2); }' }]).length, 0);
});

test('judgeResults: lint, tests and axe from a real capture; type errors mapped to props', () => {
  const j = judgeResults(data, ResultsSchema.parse(sample), 'light');
  assert.equal(j.checks.types?.status, 'pass');
  assert.equal(j.checks.lint?.status, 'fail');
  assert.equal(j.checks.tests?.status, 'fail');
  assert.equal(j.checks.a11y?.status, 'fail');
  const axe = j.findings.filter((f) => f.rule === 'axe/button-name');
  assert.equal(axe.length, 1, 'one finding per node, not per theme');
  assert.equal(axe[0]!.severity, 'critical');
  assert.equal(axe[0]!.fix.primitive, 'IconButton');
  const lint = j.findings.find((f) => f.rule === 'tenet-ui/no-deprecated-api')!;
  assert.match(lint.fix.hint, /eslint --fix/);
  const rawColor = j.findings.find((f) => f.rule === 'tenet-ui/no-raw-color')!;
  assert.ok(rawColor.fix.token, 'lint raw colour gets the nearest token');
  assert.ok(j.findings.some((f) => f.rule === 'tests/failed' && /plan_tests case/.test(f.fix.hint)));

  const withTypes = ResultsSchema.parse({ ...sample, checks: { ...sample.checks, types: { status: 'fail', errors: [
    { file: 'src/X.tsx', line: 3, code: 'TS2322', message: "Type '{ varient: string; }' is not assignable to type 'ButtonProps'. Property 'varient' does not exist on type 'ButtonProps'." },
    { file: 'src/X.tsx', line: 5, code: 'TS2322', message: "Property 'kind' does not exist on type 'ButtonProps'." },
    { file: 'src/X.tsx', line: 4, code: 'TS2322', message: "Type '\"ghost\"' is not assignable to type 'ButtonVariant'." },
  ] } } });
  const t = judgeResults(data, withTypes, 'light');
  const typo = t.findings.find((f) => f.line === 3)!;
  assert.match(typo.fix.hint, /did you mean variant/);
  assert.equal(typo.fix.primitive, 'Button');
  const kind = t.findings.find((f) => f.line === 5)!;
  assert.match(kind.fix.hint, /Button props: variant/);
  const variant = t.findings.find((f) => f.line === 4)!;
  assert.match(variant.fix.hint, /accepts 'default' \| 'primary'/);
});

test('ssim: identical images score 1, a changed quadrant shows in the map', () => {
  const make = (paint: (x: number, y: number) => number): Buffer => {
    const png = new PNG({ width: 64, height: 64 });
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const i = (y * 64 + x) * 4; const v = paint(x, y); png.data[i] = v; png.data[i + 1] = v; png.data[i + 2] = v; png.data[i + 3] = 255; }
    return PNG.sync.write(png);
  };
  const a = make((x, y) => ((x >> 3) + (y >> 3)) % 2 ? 200 : 60);
  const same = ssim(decodePng(a), decodePng(a));
  assert.equal(same.score, 1);
  const b = make((x, y) => (x >= 32 && y >= 32 ? 128 : ((x >> 3) + (y >> 3)) % 2 ? 200 : 60));
  const diff = ssim(decodePng(a), decodePng(b));
  assert.ok(diff.score < 1 && diff.score > 0.5, `score ${diff.score}`);
  assert.ok(diff.map[3]![3]! < diff.map[0]![0]!, 'bottom-right region changed');
  assert.equal(diff.map[0]![0], 1);
});

test('run_checks: static + judged findings, skipped checks, delta on a second round', async () => {
  const first = await runChecks.run({ files: [{ path: 'src/ArticleCard.tsx', content: articleCard }], results: sample, dsVersion: '0.4.0', theme: 'light', page: 1 }, ctx);
  const s = first.structured as { reportId: string; status: string; summary: Record<string, number>; checks: Record<string, { status: string }>; findings: Array<{ rule: string; severity: string }>; skipped: string[] };
  assert.equal(s.status, 'fail');
  assert.match(s.reportId, /^aud_/);
  assert.ok(s.summary.critical! >= 2, JSON.stringify(s.summary)); // unlabeled IconButton statically + axe button-name
  assert.equal(s.checks.tokens!.status, 'fail');
  assert.equal(s.checks.visual!.status, 'skipped');
  assert.equal(s.findings[0]!.severity, 'critical');
  assert.ok(s.skipped.some((x) => x.startsWith('visual')));
  assert.match(first.text, /^FAIL against 0\.4\.0/);

  // Second round: the agent fixed the component; results now clean.
  const fixed = articleCard.replace("<h1 style={{ color: '#c2410c', margin: 0 }}>{title}</h1>", '<Heading level={2}>{title}</Heading>').replace(' block>', ' fullWidth>').replace('<IconButton icon={<TrashIcon />} onClick={onDelete} />', '<IconButton icon={<TrashIcon />} aria-label="Delete article" onClick={onDelete} />');
  const clean = { ...sample, checks: { ...sample.checks, lint: { status: 'pass', findings: [] }, tests: { status: 'pass', runner: 'vitest', total: 2, passed: 2, failed: 0, cases: [] }, a11y: { status: 'pass', renders: sample.checks.a11y.renders.map((r: { violations: unknown[] }) => ({ ...r, violations: [] })) } } };
  const second = await runChecks.run({ files: [{ path: 'src/ArticleCard.tsx', content: fixed }], results: clean, dsVersion: '0.4.0', theme: 'light', auditId: s.reportId, page: 1 }, ctx);
  const t = second.structured as { status: string; delta: { fixed: number; new: number; remaining: number }; findings: unknown[] };
  assert.equal(t.status, 'pass', JSON.stringify(t.findings));
  assert.ok(t.delta.fixed >= 4);
  // What remains is advisory only (the fixture never forwarded its ref): nothing gating survives the fix.
  assert.equal(t.delta.remaining, t.findings.length);
  assert.ok((t.findings as Array<{ severity: string }>).every((f) => f.severity === 'warn' || f.severity === 'info'), JSON.stringify(t.findings));

  // No results at all: every dynamic check is skipped, never green; status depends on static findings only.
  const none = await runChecks.run({ files: [], dsVersion: 'latest', theme: 'light', page: 1 }, ctx);
  const n = none.structured as { status: string; skipped: string[] };
  assert.equal(n.status, 'pass');
  assert.ok(n.skipped.length >= 6);
});

test('run_checks visual: compares embedded screenshots against the design image', async () => {
  const png = (v: number): Buffer => { const p = new PNG({ width: 32, height: 32 }); p.data.fill(v); for (let i = 3; i < p.data.length; i += 4) p.data[i] = 255; return PNG.sync.write(p); };
  const d = await ingestDesign.run({ source: { type: 'layout', layout: { viewport: { width: 32, height: 32 }, theme: 'light' as const, regions: [{ id: 'r1', role: 'page' }] } }, dsVersion: 'latest' }, ctx);
  const designId = (d.structured as { designId: string }).designId;
  designs.putBlob('apurv', designId, 'screenshot', png(200));
  const results = { schemaVersion: 1, checks: { visual: { status: 'captured', screenshots: [{ story: 'Default', theme: 'light', status: 'captured', data: png(200).toString('base64') }, { story: 'Dark', theme: 'dark', status: 'captured', data: png(20).toString('base64') }] } } };
  const r = await runChecks.run({ files: [], results, checks: ['visual'], dsVersion: 'latest', theme: 'light', designId, page: 1 }, ctx);
  const s = r.structured as { status: string; visual: { screenshots: Array<{ story: string; ssim: number; verdict: string }> }; findings: Array<{ rule: string; severity: string }> };
  assert.equal(s.status, 'pass', 'visual never gates');
  assert.equal(s.visual.screenshots[0]!.ssim, 1);
  assert.equal(s.visual.screenshots[1]!.verdict, 'review');
  assert.ok(s.findings.every((f) => f.rule === 'visual/ssim' && f.severity === 'info'));
});
