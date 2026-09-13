import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CatalogStore } from '../catalog/store.js';
import { DesignStore } from '../store/design-store.js';
import type { ToolContext } from '../tools/context.js';
import type { DesignRow, MatchRow } from '../tools/design-tools.js';
import { planTests } from '../tools/test-tools.js';
import { buildTestPlan, testPlanMarkdown, testSkeleton } from './test-plan.js';

const store = new CatalogStore('snapshots');
const data = store.load('0.4.0');
const designs = new DesignStore(mkdtempSync(join(tmpdir(), 'tenet-plan-tests-')));
const ctx: ToolContext = { store, traceId: 't', publicUrl: 'http://x', principal: { sub: 'apurv', scopes: ['ds:read'], clientId: 'apurv' }, designs, sealKey: randomBytes(32) };
const articleCard = readFileSync(new URL('../checks/fixtures/ArticleCard.tsx.txt', import.meta.url), 'utf8');
const stories = `import type { Meta, StoryObj } from '@storybook/react-vite';
import { ArticleCard } from './ArticleCard';
const meta = { title: 'Newsroom/Article Card', component: ArticleCard } satisfies Meta<typeof ArticleCard>;
export default meta;
export const Default: StoryObj<typeof meta> = { args: { title: 'T', summary: 'S' } };
export const WithDelete: StoryObj<typeof meta> = { args: { title: 'T', summary: 'S', onDelete: () => {} } };
`;
const badge = `import { forwardRef } from 'react';
import { Tag } from 'tenet-ui';
export interface StatusBadgeProps { status: 'draft' | 'review' | 'published'; label: string; disabled?: boolean; onSelect?: (s: string) => void; children?: React.ReactNode }
export const StatusBadge = forwardRef<HTMLSpanElement, StatusBadgeProps>(function StatusBadge({ status, label, onSelect, ...rest }, ref) {
  return <Tag ref={ref} {...rest}>{label}</Tag>;
});
`;

test('buildTestPlan from files: variants, callbacks, primitives, stories with Storybook ids, gaps', () => {
  const plan = buildTestPlan(data, { files: [{ path: 'src/StatusBadge.tsx', content: badge }] });
  assert.equal(plan.component, 'StatusBadge');
  assert.equal(plan.propsType, 'StatusBadgeProps');
  assert.equal(plan.file, 'src/StatusBadge.test.tsx');
  const names = plan.cases.map((c) => c.name);
  assert.ok(names.includes('renders status="draft"') && names.includes('renders status="published"'), names.join('\n'));
  assert.ok(names.includes('renders the label text'));
  assert.ok(names.includes('calls onSelect when the select control is activated'));
  assert.ok(names.includes('does not call onSelect when disabled'));
  assert.ok(names.includes('activates onSelect with the keyboard'));
  assert.ok(names.includes('has no axe violations (default render)'));
  assert.ok(names.includes('forwards its ref and spreads rest props (className, data-*)'));
  assert.deepEqual(plan.primitives, ['Tag']);
  assert.ok(plan.cases.every((c) => c.rule && c.assert && c.steps.length));
  assert.ok(plan.gaps.some((g) => /stories/.test(g)));
  assert.match(plan.cases.find((c) => c.kind === 'render')!.steps[0]!, /status="draft" label="…"/);

  const withStories = buildTestPlan(data, { files: [{ path: 'src/ArticleCard.tsx', content: articleCard }, { path: 'src/ArticleCard.stories.tsx', content: stories }] });
  assert.deepEqual(withStories.stories.map((s) => s.storyId), ['newsroom-article-card--default', 'newsroom-article-card--with-delete']);
  assert.ok(withStories.cases.some((c) => c.kind === 'visual' && c.story === 'WithDelete'));
  assert.ok(withStories.cases.some((c) => c.primitive === 'IconButton' && /accessible name/.test(c.name)));
  assert.ok(withStories.cases.some((c) => c.primitive === 'Button' && c.kind === 'keyboard'));
  assert.ok(withStories.gaps.some((g) => /forwardRef/.test(g)));
  assert.ok(!withStories.gaps.some((g) => /stories/.test(g)));
  const skeleton = testSkeleton(withStories);
  assert.match(skeleton, /describe\('ArticleCard'/);
  assert.match(skeleton, /it\.todo\("calls onDelete when the delete control is activated"\)/);
  assert.match(skeleton, /vitest-axe/);
  assert.match(testPlanMarkdown(withStories), /# Test plan: ArticleCard/);
  const jest = buildTestPlan(data, { files: [{ path: 'src/StatusBadge.tsx', content: badge }], runner: 'jest' });
  assert.match(jest.setup.imports.join('\n'), /jest-axe/);
});

test('plan_tests tool: files path, matchId path (from a match without a plan), argument errors', async () => {
  const r = await planTests.run({ files: [{ path: 'src/ArticleCard.tsx', content: articleCard }, { path: 'src/ArticleCard.stories.tsx', content: stories }], runner: 'vitest', dsVersion: '0.4.0', skeleton: true, markdown: true }, ctx);
  const s = r.structured as { component: string; cases: unknown[]; skeleton: string; markdown: string; dsVersion: string };
  assert.equal(s.component, 'ArticleCard');
  assert.ok(s.cases.length >= 8);
  assert.ok(s.skeleton && s.markdown);
  assert.equal(s.dsVersion, '0.4.0');
  assert.match(r.text, /case\(s\) for ArticleCard/);
  assert.ok(Buffer.byteLength(JSON.stringify(r.structured)) <= planTests.cap);
  assert.ok(r.links!.some((l) => l.name === 'IconButton'));

  const design = designs.create<DesignRow>('design', 'apurv', { dsVersion: '0.4.0', name: 'Settings', source: 'layout', layout: { viewport: { width: 10, height: 10 }, theme: 'light', regions: [], texts: [] } as never, matches: [], plans: [] });
  const match = designs.create<MatchRow>('match', 'apurv', { designId: design.id, dsVersion: '0.4.0', strategy: 'auto', assignments: [{ regionId: 'r1', role: 'card', label: '', component: 'card', confidence: 0.9, candidates: [], source: 'auto' }, { regionId: 'r2', role: 'button', label: '', component: 'icon-button', confidence: 0.8, candidates: [], source: 'auto' }], unresolved: [] });
  const m = await planTests.run({ matchId: match.id, runner: 'vitest', dsVersion: 'latest', skeleton: false, markdown: false }, ctx);
  const ms = m.structured as { component: string; source: string; primitives: string[]; gaps: string[]; cases: Array<{ primitive?: string }> };
  assert.equal(ms.source, 'match');
  assert.equal(ms.component, 'Settings');
  assert.deepEqual(ms.primitives, ['Card', 'IconButton']);
  assert.ok(ms.cases.some((c) => c.primitive === 'IconButton'));
  assert.ok(ms.gaps.some((g) => /plan_component/.test(g)));
  await assert.rejects(async () => planTests.run({ runner: 'vitest', dsVersion: 'latest', skeleton: true, markdown: false }, ctx), /files\[\]/);
  await assert.rejects(async () => planTests.run({ matchId: 'mtc_000000000000000000000000', runner: 'vitest', dsVersion: 'latest', skeleton: true, markdown: false }, ctx), /not found/);
  await assert.rejects(async () => planTests.run({ matchId: match.id, runner: 'vitest', dsVersion: 'latest', skeleton: true, markdown: false }, { ...ctx, principal: { sub: 'other', scopes: [], clientId: 'o' } }), /not found/);
});
