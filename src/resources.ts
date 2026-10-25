// ds:// resources (DESIGN.md §6): public, cacheable reads over the snapshots.
import { contentText } from './catalog/files.js';
import type { CatalogStore, VersionData } from './catalog/store.js';
import { A11Y_CONTRACT } from './tools/catalog-tools.js';
import { ToolError } from './tools/context.js';
import type { DesignRows } from './store/design-store.js';
import type { DesignRow, MatchRow, PlanRow } from './tools/design-tools.js';
import { z } from 'zod';
import { LAYOUT_RULES, LayoutInputSchema, ROLE_HINTS } from './design/layout.js';
import type { ReportRow } from './checks/report.js';

export interface ResourceContent { uri: string; mimeType: string; text?: string; blob?: Buffer }
export interface ReadContext { designs?: DesignRows; sub?: string }

export async function readResource(store: CatalogStore, uri: string, rc: ReadContext = {}): Promise<ResourceContent> {
  const u = new URL(uri);
  if (u.protocol === 'design:') return readDesignResource(u, uri, rc);
  if (u.protocol === 'audit:') return readAuditResource(u, uri, rc);
  if (u.protocol !== 'ds:') throw new ToolError(`unsupported scheme ${u.protocol}`, 'not_found');
  // ds://versions  |  ds://{v}/components/{name}  |  ds://{v}/tokens/{group}.json  |  ds://{v}/guidelines/{topic}  |  ds://{v}/gaps  |  ds://{v}/baselines[/{file}]  |  ds://{v}/layout-schema
  const host = u.host;
  const path = u.pathname.replace(/^\/+/, '').split('/');
  if (host === 'versions' && !path[0]) return { uri, mimeType: 'application/json', text: json(versionsResource(store)) };
  const resolved = store.resolve(host);
  const data = store.load(resolved.effective);
  const [kind, rest] = path;
  if (kind === 'components' && rest) return { uri, mimeType: 'text/markdown', text: componentMarkdown(store, data, rest) };
  if (kind === 'tokens' && rest) return { uri, mimeType: 'application/json', text: json(tokensResource(data, rest.replace(/\.json$/, ''))) };
  if (kind === 'guidelines' && rest) return { uri, mimeType: 'text/markdown', text: guidelineMarkdown(store, data, rest) };
  if (kind === 'gaps' && !rest) return { uri, mimeType: 'application/json', text: json(data.gaps ?? { version: data.version, summary: {}, components: [] }) };
  if (kind === 'changelog' && !rest) return { uri, mimeType: 'text/markdown', text: changelogMarkdown(data) };
  if (kind === 'deprecations' && !rest) return { uri, mimeType: 'application/json', text: json(data.deprecations ?? { deprecations: [] }) };
  if (kind === 'baselines') return baselineResource(store, data, uri, rest);
  if (kind === 'layout-schema' && !rest) return { uri, mimeType: 'application/json', text: json(layoutSchemaResource(data)) };
  throw new ToolError(`no resource at ${uri}`, 'not_found');
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);


// The release's story screenshots (DESIGN.md §10): the manifest at ds://{v}/baselines, one PNG per
// story per theme at ds://{v}/baselines/{storyId}.{theme}.png. Only files named in the manifest are served.
async function baselineResource(store: CatalogStore, data: VersionData, uri: string, file: string | undefined): Promise<ResourceContent> {
  const b = data.baselines;
  if (!b) throw new ToolError(`no baselines shipped with ${data.version}`, 'not_found');
  if (!file) return { uri, mimeType: 'application/json', text: json({ dsVersion: data.version, viewport: b.viewport, count: b.entries.length, entries: b.entries.map((e) => ({ storyId: e.storyId, theme: e.theme, uri: `ds://${data.version}/baselines/${e.file}` })) }) };
  const e = b.entries.find((x) => x.file === file);
  if (!e) throw new ToolError(`no baseline ${file} in ${data.version}; read ds://${data.version}/baselines for the list`, 'not_found');
  const bytes = await store.files.bytes(`${b.dir}/${e.file}`);
  if (!bytes) throw new ToolError(`baseline file missing: ${e.file}`, 'not_found');
  return { uri, mimeType: 'image/png', blob: Buffer.from(bytes) };
}

// What the agent needs to describe a screenshot for ingest_design: the rules the vision call
// follows, the role list, this version's component ids for `candidates`, the JSON Schema, an example.
export function layoutSchemaResource(data: VersionData): unknown {
  return {
    dsVersion: data.version,
    call: 'ingest_design { source: { type: "layout", layout }, dsVersion }',
    measure: 'node <tenet-ui plugin>/scripts/measure-colors.mjs <screenshot.png> <layout.json>: re-measures the colours in layout.json from the pixels on your machine before you send it. Skip it for a Figma design.',
    rules: [
      ...LAYOUT_RULES,
      'Set viewport to the image size as you see it and give bounds in that same space; the server scales them to the real pixels. Omitted style fields are fine.',
      'Your hex values are estimates. Run the measure script on the screenshot before sending: it re-measures every colour you report (background inside the bounds, borderColor on the edges, color from the glyphs), so give bounds that hug the element. From Figma, use its exact values and skip measuring.',
      'If you cannot run the script, send the screenshot as image: {data: "<base64 PNG>"} with the layout and the server measures the same way.',
    ],
    roles: ROLE_HINTS,
    components: data.components.filter((c) => c.kind === 'component').map((c) => c.id),
    schema: z.toJSONSchema(LayoutInputSchema, { io: 'input' }),
    example: {
      viewport: { width: 1280, height: 800 },
      theme: 'light',
      regions: [
        { id: 'r1', role: 'page', parent: null, bounds: { x: 0, y: 0, width: 1280, height: 800 }, style: { background: '#ffffff' }, candidates: ['stack'] },
        { id: 'r2', role: 'card', label: 'Revenue', parent: 'r1', bounds: { x: 16, y: 16, width: 300, height: 86 }, style: { background: '#ffffff', borderColor: '#ddd2bf', borderRadius: '6px', padding: '16px' }, candidates: ['card'] },
        { id: 'r3', role: 'text', label: 'Value', text: ['128'], parent: 'r2', bounds: { x: 32, y: 55, width: 44, height: 28 }, style: { color: '#2a241b', fontSize: '26px', fontWeight: '600' }, candidates: ['text'] },
        { id: 'r4', role: 'button', label: 'Primary action', text: ['Save'], parent: 'r1', states: ['primary'], bounds: { x: 16, y: 120, width: 80, height: 32 }, style: { background: '#c2502e', color: '#ffffff' }, candidates: ['button'] },
      ],
    },
  };
}

export function versionsResource(store: CatalogStore): unknown {
  const index = store.getIndex();
  return {
    package: index.package,
    latest: index.latest,
    versions: store.versions().map((v) => {
      const e = index.versions[v]!;
      return { version: v, ingestedAt: e.ingestedAt, provenance: e.provenance, sourceRef: e.sourceRef, guidelinesRevision: e.guidelinesRevision, counts: e.counts, resources: [`ds://${v}/gaps`, `ds://${v}/changelog`, `ds://${v}/deprecations`] };
    }),
  };
}

function tokensResource(data: VersionData, group: string): unknown {
  const tokens = data.tokens.filter((t) => (t.path?.[0] ?? '') === group);
  if (!tokens.length) throw new ToolError(`no token group "${group}" in ${data.version}; groups: ${[...new Set(data.tokens.map((t) => t.path?.[0]))].join(', ')}`, 'not_found');
  return { dsVersion: data.version, group, count: tokens.length, tokens };
}

export function componentMarkdown(store: CatalogStore, data: VersionData, name: string): string {
  const c = store.findComponent(data, name);
  if (!c) throw new ToolError(`no component "${name}" in ${data.version}`, 'not_found');
  const page = data.guidelines?.pages.find((p) => p.scope === 'component' && p.id === c.id);
  const dep = data.deprecations?.deprecations.find((d) => d.kind === 'component' && d.component === c.name);
  const lines: string[] = [];
  lines.push(`# ${c.name}`, '', `- Version: ${data.version} · status: ${c.status} · a11y reviewed: ${c.a11yReviewed ? 'yes' : 'no'}`, `- Import: \`import { ${[c.exportName, ...c.subcomponents.filter((s) => s.exportName).map((s) => s.exportName!)].join(', ')} } from '${c.importPath}';\``);
  if (dep) lines.push('', `> **Deprecated since ${dep.since ?? '?'}.** ${dep.message ?? ''} Replacement: \`${dep.replacement ?? '?'}\`.`);
  if (c.description) lines.push('', c.description);
  lines.push('', '## Props', '', `Props type: \`${c.propsType ?? '—'}\`${c.extends.length ? ` extends ${c.extends.map((e) => `\`${e}\``).join(', ')}` : ''}`, '', '| Prop | Type | Required | Default | Notes |', '|---|---|---|---|---|');
  for (const p of c.props) lines.push(`| ${p.name}${p.inheritedFrom ? ` (from ${p.inheritedFrom})` : ''} | \`${p.type.replace(/\|/g, '\\|')}\` | ${p.required ? 'yes' : ''} | ${p.default ?? ''} | ${p.deprecated ? `**Deprecated:** ${p.deprecated} ` : ''}${p.description.replace(/\n/g, ' ')} |`);
  for (const s of c.subcomponents) {
    lines.push('', `### ${s.name}${s.exportName ? ` (\`import { ${s.exportName} }\`)` : ''}`, '', s.description || '', '', '| Prop | Type | Required | Default | Notes |', '|---|---|---|---|---|');
    for (const p of s.props) lines.push(`| ${p.name} | \`${p.type.replace(/\|/g, '\\|')}\` | ${p.required ? 'yes' : ''} | ${p.default ?? ''} | ${p.deprecated ? `**Deprecated:** ${p.deprecated} ` : ''}${p.description.replace(/\n/g, ' ')} |`);
  }
  lines.push('', '## Stories', '');
  for (const s of c.stories) lines.push(`- \`${s.id}\` — ${s.name}${data.stories ? ` — ${data.stories.storybookUrl}?path=/story/${s.id}` : ''}`);
  if (!c.stories.length) lines.push('_none_');
  lines.push('', '## Accessibility', '', ...A11Y_CONTRACT.map((r) => `- ${r}`));
  if (page) {
    lines.push('', `## Guidelines (revision ${data.manifest.guidelinesRevision}${page.updated ? `, updated ${page.updated}` : ''})`, '');
    for (const s of page.sections) { if (s.heading && s.level > 1) lines.push(`### ${s.heading}`, ''); if (s.body) lines.push(s.body, ''); }
  }
  if (c.related.length) lines.push('', '## Related', '', c.related.map((r) => `- ds://${data.version}/components/${r}`).join('\n'));
  return lines.join('\n');
}

const STATIC_TOPICS: Record<string, () => string> = {
  contract: () => readStatic('contract.md'),
  'audit-rules': () => readStatic('audit-rules.md'),
};
function readStatic(name: string): string {
  const text = contentText(name);
  if (text === undefined) throw new ToolError(`content page missing: ${name}`, 'not_found');
  return text;
}

export function guidelineMarkdown(store: CatalogStore, data: VersionData, topic: string): string {
  const staticTopic = STATIC_TOPICS[topic];
  if (staticTopic) return staticTopic();
  const alias: Record<string, string> = { composition: 'layout', a11y: 'accessibility', patterns: 'feedback', icons: 'iconography', type: 'typography', colour: 'color', 'data': 'data-display' };
  const id = alias[topic] ?? topic;
  const page = data.guidelines?.pages.find((p) => p.id === id && p.scope === 'system') ?? data.guidelines?.pages.find((p) => p.id === id);
  if (!page || !data.guidelinesDir) {
    const topics = [...Object.keys(STATIC_TOPICS), ...(data.guidelines?.pages.filter((p) => p.scope === 'system').map((p) => p.id) ?? [])];
    throw new ToolError(`no guideline "${topic}" in ${data.version}; topics: ${topics.join(', ')}${data.guidelines ? ' plus every component id' : ' (this version ships no guidelines)'}`, 'not_found');
  }
  const text = store.files.text(`${data.guidelinesDir}/${page.file}`);
  if (text === undefined) throw new ToolError(`guideline file missing: ${page.file}`, 'not_found');
  return text;
}

function changelogMarkdown(data: VersionData): string {
  const entries = data.changelog?.entries ?? [];
  if (!entries.length) return `# Changelog\n\nNo changelog shipped with ${data.version}.`;
  return ['# Changelog', '', ...entries.map((e) => `## ${e.version}${e.date ? ` — ${e.date}` : ''}\n\n${e.body}`)].join('\n\n');
}

/** Resource list for resources/list: concrete URIs only (templates are advertised separately). */
export function listResources(store: CatalogStore): Array<{ uri: string; name: string; mimeType: string; description?: string }> {
  const out: Array<{ uri: string; name: string; mimeType: string; description?: string }> = [{ uri: 'ds://versions', name: 'Design-system versions', mimeType: 'application/json', description: 'Snapshotted versions with provenance, counts and guidelines revision.' }];
  for (const v of store.versions()) {
    out.push({ uri: `ds://${v}/gaps`, name: `${v} gaps`, mimeType: 'application/json', description: 'Typed components with no story, baseline or guideline; catalog mismatches.' });
    out.push({ uri: `ds://${v}/changelog`, name: `${v} changelog`, mimeType: 'text/markdown' });
    out.push({ uri: `ds://${v}/deprecations`, name: `${v} deprecations`, mimeType: 'application/json', description: 'Migration registry: deprecated components and props with replacements.' });
    out.push({ uri: `ds://${v}/guidelines/contract`, name: `${v} component contract`, mimeType: 'text/markdown' });
    out.push({ uri: `ds://${v}/guidelines/audit-rules`, name: `${v} audit rule catalog`, mimeType: 'text/markdown' });
    out.push({ uri: `ds://${v}/layout-schema`, name: `${v} layout schema`, mimeType: 'application/json', description: 'How to describe a screenshot for ingest_design: rules, roles, component ids for candidates, JSON Schema, example.' });
    if (store.load(v).baselines) out.push({ uri: `ds://${v}/baselines`, name: `${v} story baselines`, mimeType: 'application/json', description: 'Release screenshots per story and theme, with the URI of each PNG.' });
  }
  return out;
}

// ---- design:// (private, principal-bound; DESIGN.md §6) -----------------------------------------
async function readDesignResource(u: URL, uri: string, rc: ReadContext): Promise<ResourceContent> {
  if (!rc.designs || !rc.sub) throw new ToolError('design resources are not available on this transport', 'not_found');
  const designId = u.host;
  const parts = u.pathname.replace(/^\/+/, '').split('/');
  const design = await rc.designs.get<DesignRow>('design', rc.sub, designId);
  if (!design) throw new ToolError(`no resource at ${uri}`, 'not_found'); // another principal's design: not-found, never forbidden
  const [artifact, id] = parts;
  if (artifact === 'layout.json') return { uri, mimeType: 'application/json', text: json({ designId, dsVersion: design.data.dsVersion, source: design.data.source, vision: design.data.vision, colorCorrections: design.data.colorCorrections, layout: design.data.layout }) };
  if (artifact === 'screenshot.png') {
    const blob = await rc.designs.getBlob(rc.sub, designId, 'screenshot');
    if (!blob) throw new ToolError(`no screenshot for ${designId} (ingested from a layout without an image)`, 'not_found');
    return { uri, mimeType: design.data.mediaType ?? 'image/png', blob };
  }
  const matchId = artifact === 'matches' ? id?.replace(/\.json$/, '') : artifact === 'match.json' ? design.data.matches.at(-1) : undefined;
  if (matchId) {
    const m = await rc.designs.get<MatchRow>('match', rc.sub, matchId);
    if (!m || m.data.designId !== designId) throw new ToolError(`no resource at ${uri}`, 'not_found');
    return { uri, mimeType: 'application/json', text: json({ matchId, ...m.data }) };
  }
  const planId = artifact === 'plans' ? id?.replace(/\.(md|json)$/, '') : artifact === 'plan.md' || artifact === 'plan.json' ? design.data.plans.at(-1) : undefined;
  if (planId) {
    const p = await rc.designs.get<PlanRow>('plan', rc.sub, planId);
    if (!p || p.data.designId !== designId) throw new ToolError(`no resource at ${uri}`, 'not_found');
    const wantJson = (id ?? artifact ?? '').endsWith('.json');
    return wantJson ? { uri, mimeType: 'application/json', text: json({ planId, ...p.data.plan }) } : { uri, mimeType: 'text/markdown', text: p.data.markdown };
  }
  throw new ToolError(`no resource at ${uri}; artifacts: layout.json, screenshot.png, match.json, matches/{id}.json, plan.md, plans/{id}.md|.json`, 'not_found');
}

// ---- audit:// (private, principal-bound; DESIGN.md §6) ------------------------------------------
async function readAuditResource(u: URL, uri: string, rc: ReadContext): Promise<ResourceContent> {
  if (!rc.designs || !rc.sub) throw new ToolError('audit resources are not available on this transport', 'not_found');
  const auditId = u.host;
  const artifact = u.pathname.replace(/^\/+/, '');
  const row = await rc.designs.get<ReportRow>('audit', rc.sub, auditId);
  if (!row) throw new ToolError(`no resource at ${uri}`, 'not_found');
  if (artifact === 'findings.json') {
    const blob = await rc.designs.getBlob(rc.sub, auditId, 'findings.json');
    return { uri, mimeType: 'application/json', text: blob ? blob.toString('utf8') : json({ reportId: auditId, findings: [], note: 'findings were not stored for this report' }) };
  }
  if (artifact === 'delta.json') return { uri, mimeType: 'application/json', text: json(row.data.delta ?? { reportId: auditId, note: 'no previous report was given; pass auditId on the next run to get a delta' }) };
  if (artifact === 'report.json' || artifact === '') { const { findingIds: _ids, ...rest } = row.data; return { uri, mimeType: 'application/json', text: json({ reportId: auditId, createdAt: row.createdAt, expiresAt: row.expiresAt, findings: _ids.length, ...rest }) }; }
  throw new ToolError(`no resource at ${uri}; artifacts: findings.json, delta.json, report.json`, 'not_found');
}
