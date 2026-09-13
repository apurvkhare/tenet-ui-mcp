import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogStore } from '../catalog/store.js';
import { bytes } from './caps.js';
import { findTokens, getComponent, resolveValueTool, searchComponents, searchIcons, CATALOG_TOOLS } from './catalog-tools.js';
import type { ToolContext } from './context.js';

const ctx: ToolContext = { store: new CatalogStore('snapshots'), traceId: 'test', publicUrl: 'http://127.0.0.1:3000' };

test('every tool has a description under 300 chars and answers under its cap', () => {
  for (const t of CATALOG_TOOLS) assert.ok(t.description.length < 300, `${t.name} description too long`);
  const r = getComponent.run({ name: 'data-table', dsVersion: 'latest', full: false }, ctx);
  assert.ok(bytes(r.structured) <= getComponent.cap, `get_component ${bytes(r.structured)} > ${getComponent.cap}`);
  const s = searchComponents.run({ query: 'input', dsVersion: 'latest', limit: 10 }, ctx);
  assert.ok(bytes(s.structured) <= searchComponents.cap);
});

test('search_components: synonyms, ranking, zero-result nearest names', () => {
  const dropdown = searchComponents.run({ query: 'dropdown', dsVersion: 'latest', limit: 5 }, ctx);
  const ids = (dropdown.structured.results as Array<{ id: string }>).map((r) => r.id);
  assert.equal(ids[0], 'select');
  assert.ok(ids.includes('menu'));
  const modal = searchComponents.run({ query: 'modal', dsVersion: 'latest', limit: 3 }, ctx);
  assert.equal((modal.structured.results as Array<{ id: string }>)[0]?.id, 'dialog');
  const empty = searchComponents.run({ query: 'nothing here yet', dsVersion: 'latest', limit: 5 }, ctx);
  const e = empty.structured as { results: unknown[]; nearest?: string[]; hint?: string };
  assert.ok(e.results.length === 0 || e.results.length <= 5);
  const zero = searchComponents.run({ query: 'zzzz', dsVersion: 'latest', limit: 5 }, ctx);
  const z = zero.structured as { results: unknown[]; nearest: string[]; hint: string };
  assert.equal(z.results.length, 0);
  assert.equal(z.nearest.length, 5);
  assert.equal(zero.structured.dsVersion, '0.4.0');
});

test('search_components on 0.3.0: no Heading, version echoed', () => {
  const r = searchComponents.run({ query: 'heading', dsVersion: '0.3.0', limit: 5 }, ctx);
  const ids = (r.structured.results as Array<{ id: string }>).map((x) => x.id);
  assert.ok(!ids.includes('heading'));
  assert.equal(r.structured.dsVersion, '0.3.0');
  const r4 = searchComponents.run({ query: 'heading', dsVersion: '0.4.0', limit: 5 }, ctx);
  assert.equal((r4.structured.results as Array<{ id: string }>)[0]?.id, 'heading');
});

test('get_component: props from types, deprecations, sections and requery hints', () => {
  const r = getComponent.run({ name: 'Button', dsVersion: '0.4', full: false }, ctx);
  const s = r.structured as { found: boolean; api: { props: Array<{ name: string; deprecated?: string; type: string }> }; omitted: Array<{ section: string }>; guidelines: { sections: unknown[] }; dsVersion: string; dsVersionNote?: string };
  assert.equal(s.found, true);
  assert.equal(s.dsVersion, '0.4.0');
  assert.match(s.dsVersionNote ?? '', /requested 0\.4/);
  const block = s.api.props.find((p) => p.name === 'block')!;
  assert.match(block.deprecated ?? '', /fullWidth/);
  assert.equal(s.api.props.find((p) => p.name === 'variant')!.type, "'default' | 'primary' | 'danger' | 'invisible'");
  assert.deepEqual(s.omitted.map((o) => o.section), ['a11y', 'source']);
  assert.ok(s.guidelines.sections.length > 0);
  assert.ok(r.links?.some((l) => l.uri === 'ds://0.4.0/components/button'));

  const label = getComponent.run({ name: 'Label', dsVersion: 'latest', sections: ['api'], full: false }, ctx);
  assert.match(label.text, /DEPRECATED/);
  assert.match((label.structured.component as { deprecated?: string }).deprecated ?? '', /Tag/);

  const missing = getComponent.run({ name: 'Buton', dsVersion: 'latest', full: false }, ctx);
  const m = missing.structured as { found: boolean; candidates: string[] };
  assert.equal(m.found, false);
  assert.equal(m.candidates[0], 'button');

  const toast = getComponent.run({ name: 'Toast', dsVersion: 'latest', sections: ['api'], full: false }, ctx);
  const t = toast.structured as { component: { import: string }; api: { subcomponents: Array<{ name: string; kind: string }> } };
  assert.match(t.component.import, /ToastProvider, useToast/);
  assert.ok(t.api.subcomponents.some((x) => x.name === 'useToast' && x.kind === 'hook'));
});

test('find_tokens: group synonyms, theme values, contrast pairs', () => {
  const spacing = findTokens.run({ query: 'spacing', dsVersion: 'latest', theme: 'both', limit: 8 }, ctx);
  const rs = spacing.structured.results as Array<{ group: string; cssVar: string }>;
  assert.ok(rs.length > 0 && rs.every((r) => r.group === 'space'));
  const muted = findTokens.run({ query: 'muted text', dsVersion: 'latest', theme: 'dark', limit: 5 }, ctx);
  const m = muted.structured.results as Array<{ name: string; dark?: string; light?: string; contrast?: unknown }>;
  assert.equal(m[0]?.name, 'fgColor-muted');
  assert.ok(m[0]?.dark && !m[0]?.light);
  assert.ok(m[0]?.contrast);
  const grouped = findTokens.run({ group: 'radius', dsVersion: 'latest', theme: 'both', limit: 20 }, ctx);
  assert.ok((grouped.structured.results as Array<{ group: string }>).every((r) => r.group === 'borderRadius'));
  const none = findTokens.run({ dsVersion: 'latest', theme: 'both', limit: 8 }, ctx);
  assert.ok((none.structured.groups as string[]).includes('space'));
});

test('search_icons: keywords and exact import; none on 0.3.0', () => {
  const del = searchIcons.run({ query: 'delete', dsVersion: 'latest', limit: 3 }, ctx);
  const r = del.structured.results as Array<{ component: string; import: string }>;
  assert.equal(r[0]?.component, 'TrashIcon');
  assert.equal(r[0]?.import, "import { TrashIcon } from 'tenet-ui/icons';");
  const old = searchIcons.run({ query: 'delete', dsVersion: '0.3.0', limit: 3 }, ctx);
  assert.equal((old.structured.results as unknown[]).length, 0);
  assert.match(String(old.structured.hint), /no icon set/);
});

test('resolve_value: exact colour, off-scale spacing, weights, auto kind', () => {
  const r = resolveValueTool.run({ values: [{ kind: 'auto', raw: '#c2502e' }, { kind: 'space', raw: '13px' }, { kind: 'auto', raw: '600' }, { kind: 'color', raw: '#ff0000' }, { kind: 'auto', raw: '1rem' }], dsVersion: 'latest', theme: 'light' }, ctx);
  const [accent, thirteen, weight, red, rem] = r.structured.results as Array<{ token?: string; exact: boolean; delta?: number; withinTolerance: boolean; suggestion?: string; kind: string; alternatives?: unknown[] }>;
  assert.equal(accent!.token, 'bgColor-accent-emphasis');
  assert.equal(accent!.exact, true);
  assert.equal(thirteen!.token, 'space-3');
  assert.equal(thirteen!.delta, 1);
  assert.equal(thirteen!.withinTolerance, true);
  assert.equal(weight!.token, 'fontWeight-semibold');
  assert.equal(red!.exact, false);
  assert.equal(red!.withinTolerance, false);
  assert.ok((red!.alternatives?.length ?? 0) >= 1);
  assert.equal(rem!.kind, 'space');
  assert.equal(rem!.suggestion, 'var(--space-4)');
});
