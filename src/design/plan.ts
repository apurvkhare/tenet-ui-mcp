// plan_component (DESIGN.md §4): the implementation plan — component tree with exact imports,
// prop mapping per node, token references by name, a11y requirements per node, files to create,
// applicable contract rules, plus the catalog excerpts the plan depends on. A plan, never source.
import { readFileSync } from 'node:fs';
import type { VersionData } from '../catalog/store.js';
import type { CatalogComponent } from '../ingest/extract/catalog.js';
import { A11Y_CONTRACT } from '../tools/catalog-tools.js';
import { childrenOf, type Layout, type Region } from './layout.js';
import type { Assignment } from './match.js';
import type { TokenEntry } from './tokens.js';

export interface PlanNode {
  regionId: string;
  component: string | null;
  name?: string;
  exportName?: string;
  props: Record<string, unknown>;
  text?: string[];
  tokens: Record<string, string>;
  a11y: string[];
  note?: string;
  children: PlanNode[];
}

export interface PlanOptions { name: string; directory?: string; stories?: boolean; tests?: boolean; typescript?: boolean }

export interface Plan {
  name: string;
  dsVersion: string;
  guidelinesRevision?: string;
  designId: string;
  matchId: string;
  imports: string[];
  tree: PlanNode[];
  files: Array<{ path: string; purpose: string }>;
  contract: string[];
  a11y: string[];
  catalog: Array<{ component: string; import: string; props: Array<{ name: string; type: string; required: boolean; default?: string; deprecated?: string }>; guidelines?: string }>;
  exceptions: Array<{ regionId: string; property: string; raw: string; note?: string }>;
  unresolved: Array<{ regionId: string; picked: string; options: string[] }>;
  stories: string[];
  tests: string[];
  notes: string[];
}

export function buildPlan(data: VersionData, layout: Layout, assignments: Assignment[], tokens: TokenEntry[] | undefined, opts: PlanOptions & { designId: string; matchId: string; unresolved: Plan['unresolved'] }): Plan {
  const byRegion = new Map(assignments.map((a) => [a.regionId, a]));
  const tokenFor = (regionId: string, property: string): TokenEntry | undefined => tokens?.find((t) => t.regionId === regionId && t.property === property);
  const used = new Set<string>();

  const node = (region: Region): PlanNode => {
    const a = byRegion.get(region.id);
    const comp = a?.component ? data.byId.get(a.component) : undefined;
    if (comp) used.add(comp.id);
    const props = comp ? mapProps(comp, region, tokenFor) : {};
    const tokenRefs: Record<string, string> = {};
    for (const [property] of Object.entries(region.style)) {
      const t = tokenFor(region.id, property);
      if (!t || !t.cssVar) continue;
      // Colours on a system component are owned by its variant; only layout-ish values are the agent's.
      if (comp && ['background', 'color', 'borderColor', 'borderRadius', 'fontSize', 'fontWeight'].includes(property) && ownsStyling(comp)) continue;
      tokenRefs[property] = t.status === 'exception' || t.status === 'proposed' ? `${t.raw} /* exception */` : `var(${t.cssVar})`;
    }
    const children = childrenOf(layout, region.id).map(node);
    const n: PlanNode = {
      regionId: region.id,
      component: comp?.id ?? null,
      name: comp?.name,
      exportName: comp?.exportName,
      props,
      text: region.text.length ? region.text : undefined,
      tokens: tokenRefs,
      a11y: comp ? a11yFor(data, comp, region) : region.role === 'image' ? ['`alt` is required and must describe the image; never guess it — ask'] : [],
      note: a?.note ?? (a && a.confidence < 0.6 ? `low confidence (${a.confidence}); alternatives: ${a.candidates.slice(1, 3).map((c) => c.component).join(', ')}` : undefined),
      children,
    };
    return n;
  };
  const tree = childrenOf(layout, null).map(node);

  const imports = importLines(data, used);
  const dir = opts.directory ?? `src/components/${opts.name}`;
  const files: Plan['files'] = [{ path: `${dir}/${opts.name}.tsx`, purpose: 'the component: composes the tree below from tenet-ui primitives; forwardRef, ...rest, className' }];
  if (opts.typescript !== false) files.push({ path: `${dir}/${opts.name}.types.ts`, purpose: 'exported props interface; text content as props with the design text as defaults' });
  if (opts.stories !== false) files.push({ path: `${dir}/${opts.name}.stories.tsx`, purpose: 'CSF3, one story per variant / state seen in the design' });
  if (opts.tests !== false) files.push({ path: `${dir}/${opts.name}.test.tsx`, purpose: 'render + interaction + a11y assertions from plan_tests' });
  files.push({ path: `${dir}/index.ts`, purpose: 'barrel' });

  const catalog = [...used].sort().map((id) => {
    const c = data.byId.get(id)!;
    return { component: c.id, import: `import { ${[c.exportName, ...c.subcomponents.filter((s) => s.exportName).map((s) => s.exportName!)].join(', ')} } from '${c.importPath}';`, props: c.props.filter((p) => !p.inheritedFrom).slice(0, 12).map((p) => ({ name: p.name, type: p.type, required: p.required, default: p.default, deprecated: p.deprecated })), guidelines: c.guidelines ? `ds://${data.version}/guidelines/${c.id}` : undefined };
  });
  const exceptions = (tokens ?? []).filter((t) => t.status === 'exception' || t.status === 'proposed' || t.status === 'pending').map((t) => ({ regionId: t.regionId, property: t.property, raw: t.raw, note: t.note }));
  const textNodes = layout.regions.filter((r) => r.text.length).length;
  return {
    name: opts.name,
    dsVersion: data.version,
    guidelinesRevision: data.manifest.guidelinesRevision,
    designId: opts.designId,
    matchId: opts.matchId,
    imports,
    tree,
    files,
    contract: contractRules(),
    a11y: A11Y_CONTRACT,
    catalog,
    exceptions,
    unresolved: opts.unresolved,
    stories: storyIdeas(tree),
    tests: [`renders with default props (${textNodes} text nodes visible)`, ...interactiveNodes(tree).map((n) => `${n.name}: interaction on ${n.regionId} (${describeInteraction(n)})`), 'axe: no serious/critical violations in light and dark', 'keyboard: every interactive node reachable and operable'],
    notes: [
      'This is a plan, not source. Write the files in the repository\'s conventions, then run the skill\'s capture script and send results.json to run_checks.',
      `Import the stylesheet once at the app root: import '${data.manifest.package}/styles.css'.`,
      ...(exceptions.length ? [`${exceptions.length} raw value(s) are exceptions or unresolved; keep them out of the component and document them.`] : []),
    ],
  };
}

function ownsStyling(c: CatalogComponent): boolean {
  return !['stack', 'grid', 'text', 'heading'].includes(c.id) ? true : c.id === 'text' || c.id === 'heading';
}

function mapProps(c: CatalogComponent, region: Region, tokenFor: (regionId: string, property: string) => TokenEntry | undefined): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  const has = (name: string): boolean => c.props.some((p) => p.name === name && !p.deprecated);
  const enumOf = (name: string): string[] => (c.props.find((p) => p.name === name)?.type.match(/'([^']+)'/g) ?? []).map((s) => s.replace(/'/g, ''));
  const states = new Set(region.states);
  const text = region.text[0];
  const bg = tokenFor(region.id, 'background')?.token ?? '';
  const fg = tokenFor(region.id, 'color')?.token ?? '';
  const tone = (): string | undefined => {
    for (const t of ['danger', 'success', 'attention', 'accent']) if (bg.includes(t) || fg.includes(t) || states.has(t === 'attention' ? 'warning' : t)) return t;
    return undefined;
  };
  switch (c.id) {
    case 'button': {
      if (text) props.children = text;
      const variants = enumOf('variant');
      const v = states.has('danger') ? 'danger' : states.has('primary') || bg.includes('accent-emphasis') ? 'primary' : states.has('tertiary') || states.has('invisible') || (!bg && !region.style.borderColor) ? 'invisible' : 'default';
      if (variants.includes(v) && v !== 'default') props.variant = v;
      if (states.has('disabled')) props.disabled = true;
      if (has('leadingIcon') && states.has('icon')) props.leadingIcon = '<…Icon /> (search_icons)';
      if (has('fullWidth') && region.bounds.width > 400) props.fullWidth = true;
      break;
    }
    case 'icon-button': props['aria-label'] = region.label || 'TODO: accessible name'; props.icon = '<…Icon /> (search_icons)'; if (states.has('danger')) props.variant = 'danger'; break;
    case 'link': if (text) props.children = text; props.href = '#TODO'; break;
    case 'heading': {
      if (text) props.children = text;
      const px = parseInt(region.style.fontSize ?? '', 10);
      props.level = px >= 32 ? 1 : px >= 24 ? 2 : px >= 18 ? 3 : px ? 4 : 2;
      break;
    }
    case 'text': {
      if (text) props.children = region.text.join(' ');
      const px = parseInt(region.style.fontSize ?? '', 10);
      if (px && px <= 12) props.size = 'small'; else if (px >= 16) props.size = 'large';
      const t = tone();
      if (fg.includes('muted')) props.tone = 'muted'; else if (t && enumOf('tone').includes(t)) props.tone = t;
      if (/^(6|7)00$/.test(region.style.fontWeight ?? '') || region.style.fontWeight === 'bold') props.weight = 'semibold';
      break;
    }
    case 'text-input': case 'textarea': case 'number-input': case 'date-picker': case 'select': {
      if (text) props.placeholder = text;
      if (states.has('disabled')) props.disabled = true;
      if (states.has('error') || states.has('invalid')) props.validationStatus = 'error';
      if (has('fullWidth')) props.fullWidth = true;
      props['/* wrap in */'] = '<FormControl> with <FormControl.Label>';
      break;
    }
    case 'form-control': if (states.has('required')) props.required = true; props['/* children */'] = 'FormControl.Label, the input, FormControl.Caption / FormControl.Validation'; break;
    case 'checkbox': case 'switch': if (text) props.label = text; if (states.has('selected') || states.has('checked')) props.defaultChecked = true; break;
    case 'radio-group': if (text) props.label = text; props['/* items */'] = region.text.slice(1).map((t) => `<Radio value="…" label="${t}" />`); break;
    case 'card': if (has('variant') && states.has('raised')) props.variant = 'raised'; if (has('padding')) props.padding = 'normal'; break;
    case 'stack': {
      const kids = region.text.length;
      props.direction = states.has('horizontal') || states.has('row') ? 'horizontal' : 'vertical';
      const gap = tokenFor(region.id, 'gap')?.token ?? '';
      props.gap = gap.endsWith('-1') || gap.endsWith('-2') ? 'condensed' : gap.endsWith('-5') || gap.endsWith('-6') ? 'spacious' : 'normal';
      if (kids > 6) props.note = 'many children; consider Grid';
      break;
    }
    case 'grid': props.columns = '{ base: 1, md: 2, lg: 3 } (adjust to the design)'; props.gap = 'normal'; break;
    case 'tag': case 'badge': { if (text) props.children = text; const t = tone(); if (t && enumOf('variant').includes(t)) props.variant = t; break; }
    case 'banner': { if (text) props.children = region.text.join(' '); const t = tone(); if (t && enumOf('variant').includes(t)) props.variant = t; if (region.text.length > 1) props.title = region.text[0]; break; }
    case 'empty-state': props.title = region.text[0] ?? 'TODO'; if (region.text[1]) props.description = region.text[1]; if (region.text[2]) props.action = `<Button variant="primary">${region.text[2]}</Button>`; break;
    case 'dialog': props.title = region.text[0] ?? 'TODO'; props.open = 'controlled'; props['/* footer */'] = 'Button(s) for the actions seen'; break;
    case 'tabs': props['/* items */'] = region.text.map((t) => `<Tabs.Tab>${t}</Tabs.Tab>`); break;
    case 'table': case 'data-table': props['/* columns */'] = region.text.slice(0, 8); if (c.id === 'data-table') props.rows = 'data[]'; break;
    case 'avatar': props.name = region.text[0] ?? 'TODO'; props.src = 'TODO'; break;
    case 'icon': props['/* glyph */'] = 'a named glyph from search_icons; decorative unless it carries meaning (then `label`)'; break;
    case 'divider': break;
    case 'progress-bar': props.value = 'number'; if (text) props.label = text; break;
    case 'breadcrumbs': props['/* items */'] = region.text; break;
    case 'pagination': props.pageCount = 'number'; props.page = 'controlled'; break;
    default: if (text) props.children = text;
  }
  return props;
}

function a11yFor(data: VersionData, c: CatalogComponent, region: Region): string[] {
  const out: string[] = [];
  if (c.id === 'icon-button' || (c.id === 'button' && !region.text.length)) out.push('accessible name required (aria-label) — icon-only control');
  if (['text-input', 'textarea', 'select', 'number-input', 'date-picker'].includes(c.id)) out.push('label via FormControl.Label; error text via FormControl.Validation with aria-describedby');
  if (c.id === 'heading') out.push('one h1 per page; do not skip levels — use `as` to decouple size from semantics');
  if (c.id === 'dialog') out.push('focus trapped and returned; Escape closes; title is the accessible name');
  if (c.id === 'tabs') out.push('arrow-key navigation between tabs; aria-selected on the active tab');
  if (c.id === 'table' || c.id === 'data-table') out.push('column headers are <th>; a caption or aria-label names the table');
  if (c.id === 'link') out.push('descriptive link text, never "click here"');
  const page = data.guidelines?.pages.find((p) => p.scope === 'component' && p.id === c.id);
  const lines = page?.sections.flatMap((s) => s.body.split('\n')).filter((l) => /aria|accessib|keyboard|focus|screen reader/i.test(l)).map((l) => l.replace(/^[-*]\s*/, '').trim()).slice(0, 2) ?? [];
  out.push(...lines);
  if (!c.a11yReviewed) out.push('component is not a11y-reviewed in this version: run axe on the rendered story');
  return out;
}

function importLines(data: VersionData, used: Set<string>): string[] {
  const names = new Set<string>();
  for (const id of used) {
    const c = data.byId.get(id);
    if (!c) continue;
    names.add(c.exportName);
    for (const s of c.subcomponents) if (s.exportName) names.add(s.exportName);
  }
  const lines = [`import '${data.manifest.package}/styles.css'; // once, at the app root — not in the component`];
  if (names.size) lines.push(`import { ${[...names].sort().join(', ')} } from '${data.manifest.package}';`);
  if ([...used].some((id) => ['icon', 'icon-button', 'button', 'empty-state'].includes(id))) lines.push(`import { /* glyphs from search_icons */ } from '${data.manifest.package}/icons';`);
  return lines;
}

function contractRules(): string[] {
  try {
    const md = readFileSync(new URL('../content/contract.md', import.meta.url), 'utf8');
    return md.split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)).slice(0, 12);
  } catch { return []; }
}

const INTERACTIVE = new Set(['button', 'icon-button', 'link', 'text-input', 'textarea', 'select', 'number-input', 'date-picker', 'checkbox', 'radio-group', 'switch', 'tabs', 'segmented-control', 'pagination', 'menu', 'dialog', 'accordion']);
function interactiveNodes(tree: PlanNode[]): PlanNode[] {
  const out: PlanNode[] = [];
  const walk = (n: PlanNode): void => { if (n.component && INTERACTIVE.has(n.component)) out.push(n); n.children.forEach(walk); };
  tree.forEach(walk);
  return out;
}
function describeInteraction(n: PlanNode): string {
  switch (n.component) {
    case 'button': case 'icon-button': case 'link': return 'click fires the handler; Enter/Space work';
    case 'text-input': case 'textarea': case 'number-input': return 'typing updates the value; error state announces';
    case 'select': case 'menu': case 'date-picker': return 'opens on click/ArrowDown; Escape closes; selection updates the value';
    case 'checkbox': case 'switch': case 'radio-group': return 'toggles with click and Space';
    case 'tabs': case 'segmented-control': return 'ArrowLeft/Right move; selection changes the panel';
    case 'dialog': return 'opens, traps focus, closes on Escape, returns focus';
    default: return 'operable by keyboard';
  }
}
function storyIdeas(tree: PlanNode[]): string[] {
  const ideas = new Set<string>(['Default']);
  const walk = (n: PlanNode): void => {
    if (n.props.variant) ideas.add(`With${String(n.props.variant)[0]!.toUpperCase()}${String(n.props.variant).slice(1)}${n.name ?? ''}`);
    if (n.props.disabled) ideas.add('Disabled');
    if (n.props.validationStatus) ideas.add('WithError');
    if (n.component === 'empty-state') ideas.add('Empty');
    n.children.forEach(walk);
  };
  tree.forEach(walk);
  return [...ideas];
}

export function planMarkdown(plan: Plan): string {
  const lines: string[] = [`# Plan: ${plan.name}`, '', `- Design system: ${plan.dsVersion}${plan.guidelinesRevision ? ` · guidelines ${plan.guidelinesRevision}` : ''}`, `- Design: ${plan.designId} · match: ${plan.matchId}`, '', '## Imports', '', '```ts', ...plan.imports, '```', '', '## Tree', ''];
  const walk = (n: PlanNode, depth: number): void => {
    const pad = '  '.repeat(depth);
    const props = Object.entries(n.props).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`).join(' ');
    lines.push(`${pad}- **${n.name ?? `(${n.regionId}: no system component)`}** ${props}${n.note ? ` — _${n.note}_` : ''}`);
    for (const [k, v] of Object.entries(n.tokens)) lines.push(`${pad}  - token ${k}: \`${v}\``);
    for (const a of n.a11y) lines.push(`${pad}  - a11y: ${a}`);
    n.children.forEach((c) => walk(c, depth + 1));
  };
  plan.tree.forEach((n) => walk(n, 0));
  lines.push('', '## Files', '', ...plan.files.map((f) => `- \`${f.path}\` — ${f.purpose}`));
  lines.push('', '## Contract', '', ...plan.contract.map((r) => `- ${r}`));
  lines.push('', '## Accessibility', '', ...plan.a11y.map((r) => `- ${r}`));
  if (plan.exceptions.length) lines.push('', '## Exceptions / unresolved values', '', ...plan.exceptions.map((e) => `- ${e.regionId}.${e.property} = ${e.raw}${e.note ? ` (${e.note})` : ''}`));
  if (plan.unresolved.length) lines.push('', '## Unresolved matches (auto-picked)', '', ...plan.unresolved.map((u) => `- ${u.regionId}: picked ${u.picked}; options ${u.options.join(', ')}`));
  lines.push('', '## Stories', '', ...plan.stories.map((s) => `- ${s}`), '', '## Tests', '', ...plan.tests.map((t) => `- ${t}`));
  lines.push('', '## Catalog excerpts', '');
  for (const c of plan.catalog) { lines.push(`### ${c.component}`, '', '```ts', c.import, '```', '', ...c.props.map((p) => `- \`${p.name}\`: ${p.type}${p.required ? ' (required)' : ''}${p.default ? ` = ${p.default}` : ''}${p.deprecated ? ` — DEPRECATED: ${p.deprecated}` : ''}`), ...(c.guidelines ? ['', `Guidelines: ${c.guidelines}`] : []), ''); }
  lines.push('## Notes', '', ...plan.notes.map((n) => `- ${n}`));
  return lines.join('\n');
}
