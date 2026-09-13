// The five read-only catalog tools (DESIGN.md §6). Each is a plain function over the store so it
// can be unit-tested without a transport; server.ts wraps them for MCP.
import { z } from 'zod';
import { resolveValue, type Theme, type ValueKind } from '../catalog/resolve.js';
import { nearestNames, rankComponents, whenToUse } from '../catalog/search.js';
import { TOKEN_GROUP_SYNONYMS, tokenize } from '../catalog/synonyms.js';
import type { CatalogComponent } from '../ingest/extract/catalog.js';
import type { TokenRecord } from '../ingest/extract/package-data.js';
import { capJson, firstSentence } from './caps.js';
import { pickVersion, storybookUrlFor, versionMeta, type ToolContext } from './context.js';

export interface ToolResult {
  structured: Record<string, unknown>;
  text: string;
  links?: Array<{ uri: string; name: string; description?: string; mimeType?: string }>;
}

export interface ToolDef<In extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  scope: string;
  cap: number;
  inputSchema: In;
  outputSchema: z.ZodRawShape;
  run: (args: z.infer<z.ZodObject<In>>, ctx: ToolContext) => ToolResult | Promise<ToolResult>;
}

const dsVersionArg = z.string().default('latest').describe('Lockfile version, "0.4", or "latest".').meta({ 'x-mcp-header': 'DsVersion' });
const loose = z.unknown();
const shape = (fields: string): z.ZodUnknown => z.unknown().describe(fields);
const dsMeta = { dsVersion: z.string(), dsVersionNote: z.string().optional(), guidelinesRevision: z.string().optional() };

// ---- search_components -------------------------------------------------------------------------
const componentHit = shape('{id,name,status,score,summary,importPath,stories,deprecated?,matchedOn[]}');

export const searchComponents: ToolDef<{ query: z.ZodString; dsVersion: typeof dsVersionArg; limit: z.ZodDefault<z.ZodNumber> }> = {
  name: 'search_components',
  title: 'Search components',
  description: 'Find components by role or by what a design tool calls them (dropdown, modal, chip). Ranked, synonym-aware; zero results return the nearest names.',
  scope: 'ds:read',
  cap: 2048,
  inputSchema: {
    query: z.string().min(1).max(120).describe('A role, a design-tool name, or a component name.'),
    dsVersion: dsVersionArg,
    limit: z.number().int().min(1).max(10).default(5),
  },
  outputSchema: { results: z.array(componentHit), nearest: z.array(z.string()).optional(), hint: z.string().optional(), ...dsMeta },
  run(args, ctx) {
    const v = pickVersion(ctx, args.dsVersion);
    const meta = versionMeta(v);
    const scored = rankComponents(v.data, args.query, args.limit);
    if (!scored.length) {
      const nearest = nearestNames(v.data, args.query);
      return {
        structured: { results: [], nearest, hint: `no component matches "${args.query}"; nearest names listed — try one of them, or describe the role (e.g. "status pill", "confirm dialog")`, ...meta },
        text: `No component matches "${args.query}" in ${v.resolved.effective}. Nearest: ${nearest.join(', ')}.`,
      };
    }
    const results = scored.map(({ component: c, score, matchedOn }) => ({
      id: c.id, name: c.name, status: c.status, score, summary: firstSentence(c.description) || firstSentence(whenToUse(v.data, c)),
      importPath: c.importPath, stories: c.stories.length, deprecated: c.status === 'deprecated' ? true : undefined, matchedOn,
    }));
    const capped = capJson({ results, ...meta }, this.cap, 'lower `limit` or refine `query`');
    return {
      structured: capped.value,
      text: `${results.length} match(es) in ${v.resolved.effective}: ${results.map((r) => `${r.name} (${r.score})`).join(', ')}. Call get_component for the API.`,
      links: results.slice(0, 3).map((r) => ({ uri: `ds://${v.resolved.effective}/components/${r.id}`, name: r.name, mimeType: 'text/markdown' })),
    };
  },
};

// ---- get_component -----------------------------------------------------------------------------
const SECTIONS = ['api', 'examples', 'a11y', 'guidelines', 'source'] as const;
type Section = (typeof SECTIONS)[number];
const propOut = shape('{name,type,required,description,default?,deprecated?,typeRef?,inheritedFrom?}');

export const getComponent: ToolDef<{ name: z.ZodString; dsVersion: typeof dsVersionArg; sections: z.ZodOptional<z.ZodArray<z.ZodEnum<{ api: 'api'; examples: 'examples'; a11y: 'a11y'; guidelines: 'guidelines'; source: 'source' }>>>; full: z.ZodDefault<z.ZodBoolean> }> = {
  name: 'get_component',
  title: 'Get component',
  description: 'One component: import, props from the types (defaults, deprecations + replacements), subcomponents, stories, a11y, guidelines. Pick `sections` to stay small.',
  scope: 'ds:read',
  cap: 8192,
  inputSchema: {
    name: z.string().min(1).max(80).describe('Id, export name or display name.'),
    dsVersion: dsVersionArg,
    sections: z.array(z.enum(SECTIONS)).optional().describe('Default: api, examples, guidelines.'),
    full: z.boolean().default(false).describe('Every section, untrimmed (64 KB cap).'),
  },
  outputSchema: {
    found: z.boolean(),
    candidates: z.array(z.string()).optional(),
    component: shape('{id,name,exportName,status,a11yReviewed,importPath,import,description,related[],deprecated?}').optional(),
    api: shape('{propsType,refType,extends[],props[{name,type,required,description,default?,deprecated?,typeRef?,inheritedFrom?}],subcomponents[]}').optional(),
    examples: shape('{stories[{id,name,url,hasPlay}],baselines}').optional(),
    a11y: shape('{reviewed,notes[],contract[]}').optional(),
    guidelines: shape('{revision,updated,sections[{heading,body}]}').optional(),
    source: loose.optional(),
    omitted: z.array(shape('{section,hint}')).optional(),
    truncated: z.boolean().optional(),
    ...dsMeta,
  },
  run(args, ctx) {
    const v = pickVersion(ctx, args.dsVersion);
    const meta = versionMeta(v);
    const c = ctx.store.findComponent(v.data, args.name);
    if (!c) {
      const candidates = nearestNames(v.data, args.name);
      return { structured: { found: false, candidates, ...meta }, text: `No component "${args.name}" in ${v.resolved.effective}. Did you mean: ${candidates.join(', ')}?` };
    }
    const wanted = new Set<Section>(args.full ? [...SECTIONS] : (args.sections ?? ['api', 'examples', 'guidelines']));
    const cap = args.full ? 65536 : this.cap;
    const deprecation = v.data.deprecations?.deprecations.find((d) => d.kind === 'component' && d.component === c.name);
    const page = v.data.guidelines?.pages.find((p) => p.scope === 'component' && p.id === c.id);
    const out: Record<string, unknown> = {
      found: true,
      component: {
        id: c.id, name: c.name, exportName: c.exportName, status: c.status, a11yReviewed: c.a11yReviewed, importPath: c.importPath,
        import: `import { ${[c.exportName, ...c.subcomponents.filter((s) => s.exportName).map((s) => s.exportName!)].join(', ')} } from '${c.importPath}';`,
        description: c.description, related: c.related, deprecated: deprecation?.message,
      },
      ...meta,
    };
    if (wanted.has('api')) out.api = { propsType: c.propsType, refType: c.refType, extends: c.extends, props: c.props.map(propView), subcomponents: c.subcomponents.map((s) => ({ name: s.name, kind: s.kind, exportName: s.exportName, props: s.props.map(propView), description: s.description })) };
    if (wanted.has('examples')) {
      const storyIds = new Set(c.stories.map((s) => s.id));
      const baselines = v.data.manifest.counts.baselines ? c.stories.length * (v.data.manifest.sources.find((s) => s.kind === 'baselines') ? 2 : 0) : 0;
      out.examples = { stories: c.stories.map((s) => ({ id: s.id, name: s.name, url: storybookUrlFor(v.data, s.id), hasPlay: v.data.stories?.stories.find((x) => x.id === s.id)?.hasPlay })), baselines: storyIds.size ? baselines : 0 };
    }
    if (wanted.has('a11y')) {
      const notes = page?.sections.flatMap((s) => s.body.split('\n').filter((l) => /a11y|accessib|aria|keyboard|focus|screen reader|label/i.test(l)).map((l) => l.replace(/^[-*]\s*/, '').trim())).slice(0, 12) ?? [];
      out.a11y = { reviewed: c.a11yReviewed, notes, contract: A11Y_CONTRACT };
    }
    if (wanted.has('guidelines')) out.guidelines = page ? { revision: v.data.manifest.guidelinesRevision, updated: page.updated, sections: page.sections.map((s) => ({ heading: s.heading, body: s.body })) } : { revision: v.data.manifest.guidelinesRevision, sections: [] };
    if (wanted.has('source')) out.source = { typesFile: 'dist/index.d.ts', propsType: c.propsType };
    const omitted = SECTIONS.filter((s) => !wanted.has(s)).map((s) => ({ section: s, hint: `get_component(name: "${c.id}", sections: ["${s}"])` }));
    if (omitted.length) out.omitted = omitted;
    const capped = capJson(out, cap, 'request fewer `sections`, or `full: true`');
    if (capped.truncated) capped.value.truncated = true;
    const deprecatedProps = c.props.filter((p) => p.deprecated).map((p) => `${p.name} (${p.deprecated})`);
    return {
      structured: capped.value,
      text: `${c.name} (${c.status}${c.a11yReviewed ? ', a11y reviewed' : ''}) — ${c.props.filter((p) => !p.inheritedFrom).length} own props${deprecatedProps.length ? `, deprecated: ${deprecatedProps.join('; ')}` : ''}; ${c.stories.length} stories.${deprecation ? ` DEPRECATED: ${deprecation.message}` : ''}`,
      links: [{ uri: `ds://${v.resolved.effective}/components/${c.id}`, name: `${c.name} (markdown)`, mimeType: 'text/markdown' }, ...(page ? [{ uri: `ds://${v.resolved.effective}/guidelines/${c.id}`, name: `${c.name} guidelines`, mimeType: 'text/markdown' }] : [])],
    };
  },
};

const propView = (p: CatalogComponent['props'][number]): Record<string, unknown> => ({ name: p.name, type: p.type, required: p.required, description: p.description, default: p.default, deprecated: p.deprecated, typeRef: p.typeRef, inheritedFrom: p.inheritedFrom });

export const A11Y_CONTRACT = [
  'Semantic elements first; every interactive element has an accessible name.',
  'Missing alt is critical, never guessed.',
  'Focus order follows visual order; focus is visible.',
  'Colour pairs are checked against the documented contrast pairs (tokens.contrast).',
  'No text in images; meaningful icons are labeled, decorative ones aria-hidden.',
];

// ---- find_tokens ------------------------------------------------------------------------------
const tokenOut = shape('{name,cssVar,type,group,value|light/dark,description?,contrast?{theme:{aa[],aaLarge[]}},score}');

export const findTokens: ToolDef<{ query: z.ZodOptional<z.ZodString>; group: z.ZodOptional<z.ZodString>; dsVersion: typeof dsVersionArg; theme: z.ZodDefault<z.ZodEnum<{ light: 'light'; dark: 'dark'; both: 'both' }>>; limit: z.ZodDefault<z.ZodNumber> }> = {
  name: 'find_tokens',
  title: 'Find tokens',
  description: 'Tokens by meaning or group (spacing, radius, muted text, accent background), per theme, with documented AA contrast pairs. Returns the CSS variables to write.',
  scope: 'ds:read',
  cap: 4096,
  inputSchema: {
    query: z.string().max(120).optional().describe('What the token is for.'),
    group: z.string().max(40).optional().describe('space, fgColor, bgColor, borderRadius…'),
    dsVersion: dsVersionArg,
    theme: z.enum(['light', 'dark', 'both']).default('both'),
    limit: z.number().int().min(1).max(20).default(8),
  },
  outputSchema: { results: z.array(tokenOut), groups: z.array(z.string()), hint: z.string().optional(), ...dsMeta },
  run(args, ctx) {
    const v = pickVersion(ctx, args.dsVersion);
    const meta = versionMeta(v);
    const groups = [...new Set(v.data.tokens.map((t) => t.path?.[0] ?? ''))].filter(Boolean);
    const words = tokenize(args.query ?? '');
    const wantedGroups = new Set<string>();
    if (args.group) for (const g of groups) if (g.toLowerCase() === args.group.toLowerCase() || (TOKEN_GROUP_SYNONYMS[args.group.toLowerCase()] ?? []).includes(g)) wantedGroups.add(g);
    const q = (args.query ?? '').toLowerCase();
    for (const key of Object.keys(TOKEN_GROUP_SYNONYMS)) if (q.includes(key)) for (const g of TOKEN_GROUP_SYNONYMS[key]!) wantedGroups.add(g);
    if (!args.query && !args.group) return { structured: { results: [], groups, hint: 'pass `query` or `group`', ...meta }, text: `Groups in ${v.resolved.effective}: ${groups.join(', ')}.` };

    const scored = v.data.tokens
      .filter((t) => t.path?.[0] !== 'base' || args.group?.toLowerCase() === 'base')
      .map((t) => {
        const group = t.path?.[0] ?? '';
        let score = 0;
        if (wantedGroups.size && !wantedGroups.has(group)) return undefined;
        if (wantedGroups.has(group)) score += 0.5;
        const hay = `${t.name} ${t.cssVar ?? ''} ${(t.path ?? []).join(' ')} ${t.description ?? ''}`.toLowerCase();
        for (const w of words) {
          if ((t.path ?? []).map((p) => p.toLowerCase()).includes(w)) score += 0.6;
          else if (hay.includes(w)) score += 0.3;
        }
        if (args.query && score === 0) return undefined;
        return { t, score: Math.round(score * 100) / 100 };
      })
      .filter((x): x is { t: TokenRecord; score: number } => Boolean(x))
      .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name))
      .slice(0, args.limit);

    const results = scored.map(({ t, score }) => tokenView(t, args.theme, score));
    const capped = capJson({ results, groups: [...wantedGroups], ...meta }, this.cap, 'lower `limit` or set `group`');
    return {
      structured: capped.value,
      text: results.length ? `${results.length} token(s): ${results.map((r) => `${r.cssVar}${r.value ? `=${r.value}` : ''}`).join(', ')}.` : `No token matches; groups are ${groups.join(', ')}.`,
      links: [...wantedGroups].slice(0, 2).map((g) => ({ uri: `ds://${v.resolved.effective}/tokens/${g}.json`, name: `${g} tokens`, mimeType: 'application/json' })),
    };
  },
};

function tokenView(t: TokenRecord, theme: 'light' | 'dark' | 'both', score: number): Record<string, unknown> & { cssVar: string; value?: string } {
  const str = (x: unknown): string | undefined => (x === undefined || x === null ? undefined : String(x));
  const contrast = t.contrast ? (theme === 'both' ? t.contrast : { [theme]: t.contrast[theme] }) : undefined;
  return {
    name: t.name, cssVar: t.cssVar ?? `--${t.name}`, type: t.type ?? 'unknown', group: t.path?.[0] ?? '',
    value: t.themed ? undefined : str(t.value),
    light: t.themed && theme !== 'dark' ? str(t.light) : undefined,
    dark: t.themed && theme !== 'light' ? str(t.dark) : undefined,
    description: t.description, contrast: contrast as Record<string, unknown> | undefined, score,
  };
}

// ---- search_icons ------------------------------------------------------------------------------
export const searchIcons: ToolDef<{ query: z.ZodString; dsVersion: typeof dsVersionArg; limit: z.ZodDefault<z.ZodNumber> }> = {
  name: 'search_icons',
  title: 'Search icons',
  description: 'Icons by name, keyword or category, with the exact import statement.',
  scope: 'ds:read',
  cap: 2048,
  inputSchema: {
    query: z.string().min(1).max(80).describe('Keyword, e.g. "delete", "chevron".'),
    dsVersion: dsVersionArg,
    limit: z.number().int().min(1).max(10).default(5),
  },
  outputSchema: { results: z.array(shape('{name,component,category?,import,keywords[],score}')), categories: z.array(z.string()), hint: z.string().optional(), ...dsMeta },
  run(args, ctx) {
    const v = pickVersion(ctx, args.dsVersion);
    const meta = versionMeta(v);
    const icons = v.data.icons;
    if (!icons) return { structured: { results: [], categories: [], hint: `${v.resolved.effective} ships no icon set (added in 0.4.0)`, ...meta }, text: `No icons in ${v.resolved.effective}.` };
    const importPath = icons.importPath ?? 'tenet-ui/icons';
    const q = args.query.toLowerCase().trim();
    const words = tokenize(q);
    const scored = icons.icons.map((i) => {
      let score = 0;
      if (i.name === q || i.component.toLowerCase() === q) score += 1;
      else if (i.name.startsWith(q)) score += 0.8;
      else if (i.name.includes(q)) score += 0.6;
      for (const w of words) {
        if (i.name.split('-').includes(w)) score += 0.5;
        if ((i.keywords ?? []).some((k) => k === w || k === q)) score += 0.6;
        else if ((i.keywords ?? []).some((k) => k.includes(w))) score += 0.3;
        if (i.category === w) score += 0.4;
      }
      return { i, score: Math.round(score * 100) / 100 };
    }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score || a.i.name.localeCompare(b.i.name)).slice(0, args.limit);
    const categories = [...new Set(icons.icons.map((i) => i.category ?? ''))].filter(Boolean);
    const results = scored.map(({ i, score }) => ({ name: i.name, component: i.component, category: i.category, import: `import { ${i.component} } from '${importPath}';`, keywords: (i.keywords ?? []).slice(0, 6), score }));
    const capped = capJson({ results, categories, ...(results.length ? {} : { hint: `no icon matches "${args.query}"; categories: ${categories.join(', ')}` }), ...meta }, this.cap, 'lower `limit`');
    return { structured: capped.value, text: results.length ? results.map((r) => `${r.component} (${r.name})`).join(', ') : `No icon matches "${args.query}". Categories: ${categories.join(', ')}.` };
  },
};

// ---- resolve_value -----------------------------------------------------------------------------
const KINDS = ['color', 'space', 'fontSize', 'radius', 'borderWidth', 'fontWeight', 'lineHeight', 'shadow', 'fontFamily', 'letterSpacing', 'auto'] as const;
const resolutionOut = shape('{raw,kind,token?,cssVar?,tokenValue?,delta?,exact,withinTolerance,suggestion?,alternatives[]?,note?}');

export const resolveValueTool: ToolDef<{ values: z.ZodArray<z.ZodObject<{ kind: z.ZodDefault<z.ZodEnum<Record<(typeof KINDS)[number], (typeof KINDS)[number]>>>; raw: z.ZodString }>>; dsVersion: typeof dsVersionArg; theme: z.ZodDefault<z.ZodEnum<{ light: 'light'; dark: 'dark' }>> }> = {
  name: 'resolve_value',
  title: 'Resolve raw values to tokens',
  description: 'Nearest token for raw CSS values (hex, px, weights) with the distance, deterministically; colours by ΔE in Lab against semantic tokens. Up to 20 per call.',
  scope: 'ds:read',
  cap: 4096,
  inputSchema: {
    values: z.array(z.object({ kind: z.enum(KINDS).default('auto'), raw: z.string().min(1).max(80) })).min(1).max(20),
    dsVersion: dsVersionArg,
    theme: z.enum(['light', 'dark']).default('light'),
  },
  outputSchema: { results: z.array(resolutionOut), theme: z.string(), ...dsMeta },
  run(args, ctx) {
    const v = pickVersion(ctx, args.dsVersion);
    const meta = versionMeta(v);
    const results = args.values.map((x) => resolveValue(v.data.tokens, x.raw, x.kind as ValueKind, args.theme as Theme));
    const capped = capJson({ results, theme: args.theme, ...meta }, this.cap, 'send fewer values per call');
    const exact = results.filter((r) => r.exact).length;
    const snap = results.filter((r) => !r.exact && r.withinTolerance).length;
    return {
      structured: capped.value,
      text: `${results.length} value(s): ${exact} exact, ${snap} within tolerance, ${results.length - exact - snap} off-scale. ${results.map((r) => `${r.raw} → ${r.suggestion ?? 'none'}${r.delta ? ` (Δ${r.delta})` : ''}`).join('; ')}`,
    };
  },
};

/** tools/list order is fixed (DESIGN.md §6). */
export const CATALOG_TOOLS: ToolDef<z.ZodRawShape>[] = [searchComponents, getComponent, findTokens, searchIcons, resolveValueTool] as unknown as ToolDef<z.ZodRawShape>[];
