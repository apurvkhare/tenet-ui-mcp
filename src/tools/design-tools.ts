// Path one, design to code (DESIGN.md §4): ingest_design → match_components → resolve_tokens →
// plan_component. The server holds the catalog, the guidelines, the contract and the token scale,
// so it decides every close match and every off-scale value itself and explains each decision
// (rule, reason, confidence, runner-up). Nothing in this path asks the user.
import { z } from 'zod';
import { nearestNames } from '../catalog/search.js';
import { LayoutInputSchema, normalizeLayout, summarizeLayout, type Layout } from '../design/layout.js';
import { assignRegions, type Assignment } from '../design/match.js';
import { buildPlan, planMarkdown, type Plan } from '../design/plan.js';
import { resolveLayoutTokens, type TokenEntry, type Tolerance } from '../design/tokens.js';
import type { Row } from '../store/design-store.js';
import { capJson } from './caps.js';
import { correctColorsFromPixels, type ColorCorrection } from '../design/pixels.js';
import type { ToolDef } from './catalog-tools.js';
import { pickVersion, ToolError, versionMeta, type ToolContext } from './context.js';

const dsVersionArg = z.string().default('latest').describe('Lockfile version, "0.4", or "latest".').meta({ 'x-mcp-header': 'DsVersion' });
const dsMeta = { dsVersion: z.string(), dsVersionNote: z.string().optional(), guidelinesRevision: z.string().optional() };
const shape = (fields: string): z.ZodUnknown => z.unknown().describe(fields);

// ---- rows ----------------------------------------------------------------------------------------
export interface DesignRow {
  dsVersion: string;
  name?: string;
  /** 'layout': the agent described it (with or without a screenshot); 'image': the vision call did. */
  source: 'image' | 'layout';
  mediaType?: string;
  imageBytes?: number;
  layout: Layout;
  /** Set only when the opt-in vision call produced the layout. */
  vision?: { model: string; usage: { inputTokens: number; outputTokens: number } };
  /** Colours the layout reported that the server re-measured from the screenshot's pixels (PNG only). */
  colorCorrections?: ColorCorrection[];
  matches: string[];
  plans: string[];
}
export interface MatchRow {
  designId: string;
  dsVersion: string;
  assignments: Assignment[];
  tokens?: { theme: 'light' | 'dark'; tolerance: Tolerance; entries: TokenEntry[]; exceptions: number };
}
export interface PlanRow { designId: string; matchId: string; plan: Plan; markdown: string }

const MAX_IMAGE = 5 * 1024 * 1024;

function needStore(ctx: ToolContext): NonNullable<ToolContext['designs']> {
  if (!ctx.designs || !ctx.principal) throw new ToolError('design tools are not enabled on this transport', 'unavailable');
  return ctx.designs;
}
const sub = (ctx: ToolContext): string => ctx.principal!.sub;

function loadDesign(ctx: ToolContext, designId: string): Row<DesignRow> {
  const row = needStore(ctx).get<DesignRow>('design', sub(ctx), designId);
  if (!row) throw new ToolError(`design ${designId} not found (unknown, expired, or not yours)`, 'not_found');
  return row;
}
function loadMatch(ctx: ToolContext, matchId: string): Row<MatchRow> {
  const row = needStore(ctx).get<MatchRow>('match', sub(ctx), matchId);
  if (!row) throw new ToolError(`match ${matchId} not found (unknown, expired, or not yours)`, 'not_found');
  return row;
}

function sniffImage(buf: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | undefined {
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return 'image/gif';
  return undefined;
}

// ---- ingest_design -------------------------------------------------------------------------------
// The agent's model already sees the screenshot, so it describes the layout and the server makes no
// model call. The agent measures the layout's colours from the screenshot on its own machine with the
// plugin's measure-colors script, so by default the screenshot never leaves it. Fallback for an agent
// that cannot run the script: send the screenshot with the layout and, for a PNG, the server runs the
// same measurement. Image-only ingest needs the opt-in vision call (VISION=on).
const imageData = z.string().min(16).describe('base64 PNG/JPEG/WebP/GIF, ≤ 5 MB');
type ImageArg = z.ZodObject<{ data: z.ZodString; mediaType: z.ZodOptional<z.ZodString> }>;
type IngestSource = z.ZodDiscriminatedUnion<[
  z.ZodObject<{ type: z.ZodLiteral<'layout'>; layout: typeof LayoutInputSchema; image: z.ZodOptional<ImageArg> }>,
  z.ZodObject<{ type: z.ZodLiteral<'image'>; data: z.ZodString; mediaType: z.ZodOptional<z.ZodString> }>,
]>;

/** What the agent is told when it sends a screenshot alone and the server has no vision. */
export const noVisionMessage = (dsVersion: string): string =>
  `This server does not read screenshots (vision is off). Describe the screenshot yourself as a layout tree (regions with id, role, bounds, parent, raw style values and candidate component ids), measure its colours locally with the tenet-ui plugin's scripts/measure-colors.mjs, and call ingest_design again with source {type: "layout", layout}. If you cannot run the script, add this image as image.data and the server measures the colours. Schema, roles and component ids: ds://${dsVersion}/layout-schema`;

export const ingestDesign: ToolDef<{ source: IngestSource; dsVersion: typeof dsVersionArg; hints: z.ZodOptional<z.ZodObject<{ name: z.ZodOptional<z.ZodString>; notes: z.ZodOptional<z.ZodString>; viewport: z.ZodOptional<z.ZodObject<{ width: z.ZodNumber; height: z.ZodNumber }>> }>> }> = {
  name: 'ingest_design',
  title: 'Ingest a design',
  description: 'Store a design as a layout tree; returns a designId for match_components. Describe the screenshot yourself (ds://{v}/layout-schema), measure its colours locally with the plugin\'s measure-colors.mjs, then send source {type: "layout", layout}. From Figma, use its exact values.',
  scope: 'design:ingest',
  cap: 6144,
  inputSchema: {
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('layout'), layout: LayoutInputSchema, image: z.object({ data: imageData, mediaType: z.string().optional() }).optional().describe('PNG fallback if you cannot measure locally') }),
      z.object({ type: z.literal('image'), data: imageData, mediaType: z.string().optional() }).describe('Only if the server has vision on'),
    ]),
    dsVersion: dsVersionArg,
    hints: z.object({ name: z.string().max(80).optional(), notes: z.string().max(1000).optional(), viewport: z.object({ width: z.number(), height: z.number() }).optional() }).optional(),
  },
  outputSchema: { designId: z.string(), source: z.string(), summary: shape('{regions, roots, roles{}, texts, palette[], theme}'), vision: shape('{model, usage}').optional(), colorCorrections: shape('{count, maxDeltaE, examples[]}').optional(), resources: z.array(z.string()), ...dsMeta },
  async run(args, ctx) {
    const store = needStore(ctx);
    const v = pickVersion(ctx, args.dsVersion);
    const meta = versionMeta(v);
    const src = args.source;
    const image = src.type === 'image' ? src : src.image;
    let imageBytes: Buffer | undefined;
    let mediaType: ReturnType<typeof sniffImage>;
    if (image) {
      imageBytes = Buffer.from(image.data, 'base64');
      if (imageBytes.length > MAX_IMAGE) throw new ToolError(`image is ${(imageBytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB`, 'image_too_large');
      mediaType = sniffImage(imageBytes);
      if (!mediaType) throw new ToolError('image bytes are not PNG, JPEG, WebP or GIF', 'image_unsupported');
    }
    let layout: Layout;
    let vision: DesignRow['vision'];
    if (src.type === 'layout') {
      layout = normalizeLayout(src.layout);
    } else {
      if (!ctx.vision) throw new ToolError(noVisionMessage(v.resolved.effective), 'vision_unavailable', { resource: `ds://${v.resolved.effective}/layout-schema` });
      const vocabulary = { components: v.data.components.filter((c) => c.kind === 'component').map((c) => c.id), tokenGroups: [...new Set(v.data.tokens.map((t) => t.path?.[0] ?? ''))].filter(Boolean), icons: v.data.icons?.icons.length ?? 0 };
      const result = await ctx.vision({ image: imageBytes!, mediaType: mediaType!, vocabulary, hints: args.hints });
      layout = result.layout;
      vision = { model: result.model, usage: result.usage };
    }
    // Hex values read off a screenshot by eye are estimates, whichever model read them; measure the
    // ones the layout reports from the pixels.
    let corrections: ColorCorrection[] = [];
    if (imageBytes && mediaType === 'image/png') ({ layout, corrections } = correctColorsFromPixels(layout, imageBytes));
    const row: DesignRow = { dsVersion: v.resolved.effective, name: args.hints?.name, source: src.type, mediaType, imageBytes: imageBytes?.length, layout, vision, colorCorrections: imageBytes ? corrections : undefined, matches: [], plans: [] };
    const created = store.create<DesignRow>('design', sub(ctx), row);
    if (imageBytes) store.putBlob(sub(ctx), created.id, 'screenshot', imageBytes);
    const summary = summarizeLayout(layout);
    const resources = [`design://${created.id}/layout.json`, ...(imageBytes ? [`design://${created.id}/screenshot.png`] : [])];
    const maxDelta = Math.max(0, ...corrections.map((c) => c.deltaE));
    const colorCorrections = corrections.length ? { count: corrections.length, maxDeltaE: maxDelta, examples: corrections.slice(0, 3).map((c) => `${c.regionId}.${c.property} ${c.model} → ${c.sampled}`) } : undefined;
    const structured = { designId: created.id, source: row.source, summary, vision: row.vision, colorCorrections, resources, ...meta };
    const measured = colorCorrections ? ` ${colorCorrections.count} colour(s) ${vision ? 'the model estimated' : 'in the layout'} were re-measured from the pixels (off by up to ΔE ${maxDelta}).` : imageBytes && mediaType !== 'image/png' ? ' Colours were not measured from the image: that needs a PNG.' : '';
    return {
      structured: capJson(structured, this.cap, 'read design://…/layout.json for the full tree').value,
      text: `Design ${created.id} stored against ${v.resolved.effective}: ${summary.regions} regions (${Object.entries(summary.roles).slice(0, 6).map(([r, n]) => `${n} ${r}`).join(', ')}), ${summary.texts} text strings.${measured} Next: match_components.`,
      links: resources.map((uri) => ({ uri, name: uri.split('/').pop()!, mimeType: uri.endsWith('.png') ? 'image/png' : 'application/json' })),
    };
  },
};

// ---- match_components ---------------------------------------------------------------------------
export const matchComponents: ToolDef<{ designId: z.ZodString }> = {
  name: 'match_components',
  title: 'Match components',
  description: 'Assign a catalog component to every region of a design with a confidence. Close calls are decided from the guidelines and structure, with the rule, the reason and the runner-up. Never asks. Returns a matchId.',
  scope: 'design:ingest',
  cap: 8192,
  inputSchema: { designId: z.string().min(1) },
  outputSchema: { matchId: z.string(), designId: z.string(), assignments: z.array(shape('{regionId, role, label, component, confidence, candidates[{component, confidence, reasons[]}], source: auto|decided|none, decision?{basis, rule, reason, cites[], runnerUp{component, confidence}}}')), decisions: z.number(), ...dsMeta },
  run(args, ctx) {
    const store = needStore(ctx);
    const design = loadDesign(ctx, args.designId);
    const v = pickVersion(ctx, design.data.dsVersion);
    const meta = versionMeta(v);
    const assignments = assignRegions(v.data, design.data.layout);
    const created = store.create<MatchRow>('match', sub(ctx), { designId: design.id, dsVersion: v.resolved.effective, assignments });
    store.update(design, { ...design.data, matches: [...design.data.matches, created.id] });
    const decided = assignments.filter((a) => a.source === 'decided');
    const structured = { matchId: created.id, designId: design.id, assignments: assignments.map(compactAssignment), decisions: decided.length, ...meta };
    const capped = capJson(structured, this.cap, `read design://${design.id}/matches/${created.id}.json for the full assignment tree`);
    const none = assignments.filter((a) => a.source === 'none').length;
    const why = decided.slice(0, 3).map((a) => `${a.regionId} → ${a.component} over ${a.decision!.runnerUp.component} (${a.decision!.reason})`).join('; ');
    return {
      structured: capped.value,
      text: `Match ${created.id}: ${assignments.length} regions assigned, ${decided.length} close call(s) decided${why ? `: ${why}` : ''}${none ? `, ${none} without a system component` : ''}. Next: resolve_tokens, then plan_component.`,
      links: [{ uri: `design://${design.id}/matches/${created.id}.json`, name: 'match.json', mimeType: 'application/json' }],
    };
  },
};

const compactAssignment = (a: Assignment): Record<string, unknown> => ({ regionId: a.regionId, role: a.role, label: a.label || undefined, component: a.component, confidence: a.confidence, candidates: a.candidates.slice(0, 3).map((c) => ({ component: c.component, confidence: c.confidence, reasons: c.reasons.slice(0, 2) })), source: a.source, decision: a.decision, note: a.note });

// ---- resolve_tokens ------------------------------------------------------------------------------
export const resolveTokens: ToolDef<{ matchId: z.ZodString; theme: z.ZodDefault<z.ZodEnum<{ light: 'light'; dark: 'dark' }>>; tolerance: z.ZodDefault<z.ZodEnum<{ strict: 'strict'; normal: 'normal'; loose: 'loose' }>> }> = {
  name: 'resolve_tokens',
  title: 'Resolve tokens',
  description: 'Map every raw value in a matched design to the nearest token with its delta. Off-scale values are decided, never asked: snapped to the scale with the delta, or kept as a documented exception, each with its rule.',
  scope: 'design:ingest',
  cap: 6144,
  inputSchema: {
    matchId: z.string().min(1),
    theme: z.enum(['light', 'dark']).default('light'),
    tolerance: z.enum(['strict', 'normal', 'loose']).default('normal').describe('strict: exact only, the rest are exceptions; normal: the system rules; loose: always snap'),
  },
  outputSchema: { matchId: z.string(), tokenMap: z.array(shape('{regionId, property, raw, token?, cssVar?, delta?, status: exact|snapped|exception, suggestion?, runnerUp?, decision?{rule, reason, cites[]}}')), exceptions: z.number(), snappedBeyondTolerance: z.number(), ...dsMeta },
  run(args, ctx) {
    const store = needStore(ctx);
    const match = loadMatch(ctx, args.matchId);
    const design = loadDesign(ctx, match.data.designId);
    const v = pickVersion(ctx, match.data.dsVersion);
    const meta = versionMeta(v);
    const { entries } = resolveLayoutTokens(v.data, design.data.layout, args.theme, args.tolerance);
    const exceptions = entries.filter((e) => e.status === 'exception').length;
    const beyond = entries.filter((e) => e.status === 'snapped' && e.decision).length;
    const updated = store.update(match, { ...match.data, tokens: { theme: args.theme, tolerance: args.tolerance, entries, exceptions } });
    const tokenMap = entries.map((e) => ({ regionId: e.regionId, property: e.property, raw: e.raw, token: e.token, cssVar: e.cssVar, delta: e.delta, status: e.status, suggestion: e.suggestion, runnerUp: e.decision ? e.runnerUp : undefined, decision: e.decision }));
    const structured = { matchId: updated.id, tokenMap, exceptions, snappedBeyondTolerance: beyond, ...meta };
    const exact = entries.filter((e) => e.status === 'exact').length;
    const snapped = entries.filter((e) => e.status === 'snapped').length;
    const firstException = entries.find((e) => e.status === 'exception');
    return {
      structured: capJson(structured, this.cap, `read design://${design.id}/matches/${match.id}.json for every entry`).value,
      text: `${entries.length} value(s): ${exact} exact, ${snapped} snapped (${beyond} beyond tolerance, each with its rule), ${exceptions} documented exception(s)${firstException ? `, e.g. ${firstException.raw}: ${firstException.decision?.reason}` : ''}. Next: plan_component.`,
      links: [{ uri: `design://${design.id}/matches/${match.id}.json`, name: 'match.json', mimeType: 'application/json' }],
    };
  },
};

// ---- plan_component -----------------------------------------------------------------------------
export const planComponent: ToolDef<{ matchId: z.ZodString; name: z.ZodString; options: z.ZodOptional<z.ZodObject<{ directory: z.ZodOptional<z.ZodString>; stories: z.ZodOptional<z.ZodBoolean>; tests: z.ZodOptional<z.ZodBoolean>; typescript: z.ZodOptional<z.ZodBoolean> }>> }> = {
  name: 'plan_component',
  title: 'Plan a component',
  description: 'The implementation plan for a matched design: component tree with exact imports, prop mapping per node, token references, a11y per node, files to create, contract rules, and the catalog excerpts it depends on. A plan, never source.',
  scope: 'design:ingest',
  cap: 24576,
  inputSchema: {
    matchId: z.string().min(1),
    name: z.string().min(1).max(60).regex(/^[A-Z][A-Za-z0-9]*$/, 'PascalCase component name'),
    options: z.object({ directory: z.string().max(200).optional(), stories: z.boolean().optional(), tests: z.boolean().optional(), typescript: z.boolean().optional() }).optional(),
  },
  outputSchema: { planId: z.string(), plan: shape('{name, dsVersion, imports[], tree[], files[], contract[], a11y[], catalog[], exceptions[], decisions[], stories[], tests[], notes[]}'), ...dsMeta },
  run(args, ctx) {
    const store = needStore(ctx);
    const match = loadMatch(ctx, args.matchId);
    const design = loadDesign(ctx, match.data.designId);
    const v = pickVersion(ctx, match.data.dsVersion);
    const meta = versionMeta(v);
    // Without a resolve_tokens call the plan applies the same rules with the defaults.
    const tokens = match.data.tokens?.entries ?? resolveLayoutTokens(v.data, design.data.layout, design.data.layout.theme === 'dark' ? 'dark' : 'light', 'normal').entries;
    const plan = buildPlan(v.data, design.data.layout, match.data.assignments, tokens, { ...args.options, name: args.name, designId: design.id, matchId: match.id });
    const markdown = planMarkdown(plan);
    const created = store.create<PlanRow>('plan', sub(ctx), { designId: design.id, matchId: match.id, plan, markdown });
    store.update(design, { ...design.data, plans: [...design.data.plans, created.id] });
    const capped = capJson({ planId: created.id, plan, ...meta } as Record<string, unknown>, this.cap, `read design://${design.id}/plans/${created.id}.md for the full plan`);
    const components = plan.catalog.map((c) => c.component);
    return {
      structured: capped.value,
      text: `Plan ${created.id} for ${args.name}: ${components.length} components (${components.join(', ')}), ${plan.files.length} files, ${plan.exceptions.length} documented exception(s), ${plan.decisions.length} decided close call(s). Write the files, run the capture script, then run_checks.`,
      links: [{ uri: `design://${design.id}/plans/${created.id}.md`, name: 'plan.md', mimeType: 'text/markdown' }, { uri: `ds://${v.resolved.effective}/guidelines/contract`, name: 'component contract', mimeType: 'text/markdown' }],
    };
  },
};

export const DESIGN_TOOLS: ToolDef<z.ZodRawShape>[] = [ingestDesign, matchComponents, resolveTokens, planComponent] as unknown as ToolDef<z.ZodRawShape>[];

export { nearestNames };
