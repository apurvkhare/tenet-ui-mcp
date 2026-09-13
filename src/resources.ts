// ds:// resources (DESIGN.md §6): public, cacheable reads over the snapshots.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogStore, VersionData } from './catalog/store.js';
import { A11Y_CONTRACT } from './tools/catalog-tools.js';
import { ToolError } from './tools/context.js';
import type { DesignStore } from './store/design-store.js';
import type { DesignRow, MatchRow, PlanRow } from './tools/design-tools.js';

export interface ResourceContent { uri: string; mimeType: string; text?: string; blob?: Buffer }
export interface ReadContext { designs?: DesignStore; sub?: string }

export function readResource(store: CatalogStore, uri: string, rc: ReadContext = {}): ResourceContent {
  const u = new URL(uri);
  if (u.protocol === 'design:') return readDesignResource(u, uri, rc);
  if (u.protocol !== 'ds:') throw new ToolError(`unsupported scheme ${u.protocol}`, 'not_found');
  // ds://versions  |  ds://{v}/components/{name}  |  ds://{v}/tokens/{group}.json  |  ds://{v}/guidelines/{topic}  |  ds://{v}/gaps
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
  throw new ToolError(`no resource at ${uri}`, 'not_found');
}

const json = (v: unknown): string => JSON.stringify(v, null, 2);

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
  const p = new URL(`./content/${name}`, import.meta.url);
  return readFileSync(p, 'utf8');
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
  const file = join(data.guidelinesDir, page.file);
  if (!existsSync(file)) throw new ToolError(`guideline file missing: ${page.file}`, 'not_found');
  return readFileSync(file, 'utf8');
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
  }
  return out;
}

// ---- design:// (private, principal-bound; DESIGN.md §6) -----------------------------------------
function readDesignResource(u: URL, uri: string, rc: ReadContext): ResourceContent {
  if (!rc.designs || !rc.sub) throw new ToolError('design resources are not available on this transport', 'not_found');
  const designId = u.host;
  const parts = u.pathname.replace(/^\/+/, '').split('/');
  const design = rc.designs.get<DesignRow>('design', rc.sub, designId);
  if (!design) throw new ToolError(`no resource at ${uri}`, 'not_found'); // another principal's design: not-found, never forbidden
  const [artifact, id] = parts;
  if (artifact === 'layout.json') return { uri, mimeType: 'application/json', text: json({ designId, dsVersion: design.data.dsVersion, source: design.data.source, vision: design.data.vision, layout: design.data.layout }) };
  if (artifact === 'screenshot.png') {
    const blob = rc.designs.getBlob(rc.sub, designId, 'screenshot');
    if (!blob) throw new ToolError(`no screenshot for ${designId} (ingested from a layout)`, 'not_found');
    return { uri, mimeType: design.data.mediaType ?? 'image/png', blob };
  }
  const matchId = artifact === 'matches' ? id?.replace(/\.json$/, '') : artifact === 'match.json' ? design.data.matches.at(-1) : undefined;
  if (matchId) {
    const m = rc.designs.get<MatchRow>('match', rc.sub, matchId);
    if (!m || m.data.designId !== designId) throw new ToolError(`no resource at ${uri}`, 'not_found');
    return { uri, mimeType: 'application/json', text: json({ matchId, ...m.data }) };
  }
  const planId = artifact === 'plans' ? id?.replace(/\.(md|json)$/, '') : artifact === 'plan.md' || artifact === 'plan.json' ? design.data.plans.at(-1) : undefined;
  if (planId) {
    const p = rc.designs.get<PlanRow>('plan', rc.sub, planId);
    if (!p || p.data.designId !== designId) throw new ToolError(`no resource at ${uri}`, 'not_found');
    const wantJson = (id ?? artifact ?? '').endsWith('.json');
    return wantJson ? { uri, mimeType: 'application/json', text: json({ planId, ...p.data.plan }) } : { uri, mimeType: 'text/markdown', text: p.data.markdown };
  }
  throw new ToolError(`no resource at ${uri}; artifacts: layout.json, screenshot.png, match.json, matches/{id}.json, plan.md, plans/{id}.md|.json`, 'not_found');
}
