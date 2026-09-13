// Path one, design to code (DESIGN.md §4): ingest_design → match_components → resolve_tokens →
// plan_component. Human answers travel as MRTR-shaped results (§8): a tool that needs an answer
// returns `resultType: "input_required"` with `inputRequests` and a sealed `requestState`; the
// client calls the same tool again with `inputResponses` and the untouched `requestState`.
import { z } from 'zod';
import { argsDigest, seal, SealError, unseal } from '../auth/seal.js';
import { nearestNames } from '../catalog/search.js';
import { LayoutInputSchema, normalizeLayout, summarizeLayout, type Layout } from '../design/layout.js';
import { assignRegions, questionsFor, type Assignment, type Question } from '../design/match.js';
import { buildPlan, planMarkdown, type Plan } from '../design/plan.js';
import { applyTokenAnswer, resolveLayoutTokens, type TokenEntry, type Tolerance } from '../design/tokens.js';
import type { Row } from '../store/design-store.js';
import { capJson } from './caps.js';
import type { ToolDef, ToolResult } from './catalog-tools.js';
import { pickVersion, ToolError, versionMeta, type ToolContext } from './context.js';

const dsVersionArg = z.string().default('latest').describe('Lockfile version, "0.4", or "latest".').meta({ 'x-mcp-header': 'DsVersion' });
const dsMeta = { dsVersion: z.string(), dsVersionNote: z.string().optional(), guidelinesRevision: z.string().optional() };
const loose = z.unknown();
const shape = (fields: string): z.ZodUnknown => z.unknown().describe(fields);
const mrtr = {
  resultType: z.enum(['complete', 'input_required']),
  inputRequests: shape('{<key>: {method:"elicitation/create", params:{mode:"form", message, requestedSchema}}}').optional(),
  requestState: z.string().optional(),
};
const inputResponsesArg = z.record(z.string(), z.object({ action: z.enum(['accept', 'decline', 'cancel']), content: z.record(z.string(), z.unknown()).optional() })).optional().describe('Answers to a previous input_required result, keyed like inputRequests.');
const requestStateArg = z.string().optional().describe('The requestState from the input_required result, untouched.');

// ---- rows ----------------------------------------------------------------------------------------
export interface DesignRow {
  dsVersion: string;
  name?: string;
  source: 'image' | 'layout';
  mediaType?: string;
  imageBytes?: number;
  layout: Layout;
  vision?: { model: string; usage: { inputTokens: number; outputTokens: number } };
  matches: string[];
  plans: string[];
}
export interface MatchRow {
  designId: string;
  dsVersion: string;
  strategy: 'auto' | 'ask';
  assignments: Assignment[];
  unresolved: Array<{ regionId: string; picked: string; options: string[] }>;
  tokens?: { theme: 'light' | 'dark'; tolerance: Tolerance; entries: TokenEntry[]; exceptions: number };
}
export interface PlanRow { designId: string; matchId: string; plan: Plan; markdown: string }

const TEN_MINUTES = 10 * 60 * 1000;
const MAX_IMAGE = 5 * 1024 * 1024;

function needStore(ctx: ToolContext): NonNullable<ToolContext['designs']> {
  if (!ctx.designs || !ctx.principal || !ctx.sealKey) throw new ToolError('design tools are not enabled on this transport', 'unavailable');
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

/** Build the MRTR input_required result. */
function inputRequired(ctx: ToolContext, kind: string, args: unknown, questions: Question[], state: unknown, partial: Record<string, unknown>, meta: Record<string, unknown>): ToolResult {
  const inputRequests: Record<string, unknown> = {};
  for (const q of questions) {
    inputRequests[q.key] = {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: q.message,
        requestedSchema: { type: 'object', properties: { choice: { type: 'string', title: 'Use which?', oneOf: q.options.map((o) => ({ const: o.value, title: o.title })), default: q.defaultValue } }, required: ['choice'] },
      },
    };
  }
  const requestState = seal(ctx.sealKey!, { sub: sub(ctx), exp: Date.now() + TEN_MINUTES, argsDigest: argsDigest(args), kind, state });
  return {
    structured: { resultType: 'input_required', inputRequests, requestState, ...partial, ...meta },
    text: `${questions.length} question(s) need an answer: ${questions.map((q) => q.message).join(' ')} Reply by calling the same tool again with inputResponses {key: {action: "accept", content: {choice}}} and the requestState. Decline to auto-resolve; a client without form elicitation may auto-resolve everything.`,
  };
}

/** Strip the MRTR fields so the digest covers only the original arguments. */
const originalArgs = (args: Record<string, unknown>): Record<string, unknown> => { const { inputResponses: _i, requestState: _s, ...rest } = args; return rest; };

function readAnswers(ctx: ToolContext, kind: string, args: Record<string, unknown>): { state: unknown; answers: Record<string, string> } | undefined {
  const responses = args.inputResponses as Record<string, { action: string; content?: Record<string, unknown> }> | undefined;
  const requestState = args.requestState as string | undefined;
  if (!responses && !requestState) return undefined;
  if (!responses || !requestState) throw new ToolError('pass both inputResponses and requestState to answer questions', 'invalid_arguments');
  let payload;
  try { payload = unseal<unknown>(ctx.sealKey!, requestState, { sub: sub(ctx), kind, argsDigest: argsDigest(originalArgs(args)) }); }
  catch (err) { throw new ToolError(err instanceof SealError ? err.message : String(err), 'invalid_state'); }
  const answers: Record<string, string> = {};
  for (const [key, r] of Object.entries(responses)) {
    if (r.action === 'cancel') throw new ToolError('elicitation cancelled by the user', 'cancelled', { partial: payload.state as Record<string, unknown> });
    answers[key] = r.action === 'accept' && typeof r.content?.choice === 'string' ? r.content.choice : 'auto';
  }
  return { state: payload.state, answers };
}

// ---- ingest_design -------------------------------------------------------------------------------
export const ingestDesign: ToolDef<{ source: z.ZodDiscriminatedUnion<[z.ZodObject<{ type: z.ZodLiteral<'image'>; data: z.ZodString; mediaType: z.ZodOptional<z.ZodString> }>, z.ZodObject<{ type: z.ZodLiteral<'layout'>; layout: typeof LayoutInputSchema }>]>; dsVersion: typeof dsVersionArg; hints: z.ZodOptional<z.ZodObject<{ name: z.ZodOptional<z.ZodString>; notes: z.ZodOptional<z.ZodString>; viewport: z.ZodOptional<z.ZodObject<{ width: z.ZodNumber; height: z.ZodNumber }>> }>> }> = {
  name: 'ingest_design',
  title: 'Ingest a design',
  description: 'Turn a screenshot (or a host-supplied layout tree) into a stored design with a layout in the catalog\'s vocabulary. Returns a designId for match_components.',
  scope: 'design:ingest',
  cap: 6144,
  inputSchema: {
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('image'), data: z.string().min(16).describe('base64 PNG/JPEG/WebP/GIF, ≤ 5 MB'), mediaType: z.string().optional() }),
      z.object({ type: z.literal('layout'), layout: LayoutInputSchema }),
    ]),
    dsVersion: dsVersionArg,
    hints: z.object({ name: z.string().max(80).optional(), notes: z.string().max(1000).optional(), viewport: z.object({ width: z.number(), height: z.number() }).optional() }).optional(),
  },
  outputSchema: { designId: z.string(), source: z.string(), summary: shape('{regions, roots, roles{}, texts, palette[], theme}'), vision: shape('{model, usage}').optional(), resources: z.array(z.string()), ...dsMeta },
  async run(args, ctx) {
    const store = needStore(ctx);
    const v = pickVersion(ctx, args.dsVersion);
    const meta = versionMeta(v);
    let layout: Layout;
    let row: DesignRow;
    let imageBytes: Buffer | undefined;
    if (args.source.type === 'layout') {
      layout = normalizeLayout(args.source.layout);
      row = { dsVersion: v.resolved.effective, name: args.hints?.name, source: 'layout', layout, matches: [], plans: [] };
    } else {
      imageBytes = Buffer.from(args.source.data, 'base64');
      if (imageBytes.length > MAX_IMAGE) throw new ToolError(`image is ${(imageBytes.length / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB`, 'image_too_large');
      const mediaType = sniffImage(imageBytes);
      if (!mediaType) throw new ToolError('image bytes are not PNG, JPEG, WebP or GIF', 'image_unsupported');
      if (!ctx.vision) throw new ToolError('vision is not configured on this server; pass source.type = "layout" with a layout tree instead', 'vision_unavailable');
      const vocabulary = { components: v.data.components.filter((c) => c.kind === 'component').map((c) => c.id), tokenGroups: [...new Set(v.data.tokens.map((t) => t.path?.[0] ?? ''))].filter(Boolean), icons: v.data.icons?.icons.length ?? 0 };
      const result = await ctx.vision({ image: imageBytes, mediaType, vocabulary, hints: args.hints });
      layout = result.layout;
      row = { dsVersion: v.resolved.effective, name: args.hints?.name, source: 'image', mediaType, imageBytes: imageBytes.length, layout, vision: result, matches: [], plans: [] };
    }
    const created = store.create<DesignRow>('design', sub(ctx), row);
    if (imageBytes) store.putBlob(sub(ctx), created.id, 'screenshot', imageBytes);
    const summary = summarizeLayout(layout);
    const resources = [`design://${created.id}/layout.json`, ...(imageBytes ? [`design://${created.id}/screenshot.png`] : [])];
    const structured = { designId: created.id, source: row.source, summary, vision: row.vision, resources, ...meta };
    return {
      structured: capJson(structured, this.cap, 'read design://…/layout.json for the full tree').value,
      text: `Design ${created.id} stored against ${v.resolved.effective}: ${summary.regions} regions (${Object.entries(summary.roles).slice(0, 6).map(([r, n]) => `${n} ${r}`).join(', ')}), ${summary.texts} text strings. Next: match_components.`,
      links: resources.map((uri) => ({ uri, name: uri.split('/').pop()!, mimeType: uri.endsWith('.png') ? 'image/png' : 'application/json' })),
    };
  },
};

// ---- match_components ---------------------------------------------------------------------------
export const matchComponents: ToolDef<{ designId: z.ZodString; strategy: z.ZodDefault<z.ZodEnum<{ ask: 'ask'; auto: 'auto' }>>; inputResponses: typeof inputResponsesArg; requestState: typeof requestStateArg }> = {
  name: 'match_components',
  title: 'Match components',
  description: 'Assign a catalog component to every region of a design with a confidence. Where two candidates are close it asks (form elicitation, ≤ 8 questions) unless strategy is auto. Returns a matchId.',
  scope: 'design:ingest',
  cap: 8192,
  inputSchema: {
    designId: z.string().min(1),
    strategy: z.enum(['ask', 'auto']).default('ask').describe('auto: never ask, list skipped questions in unresolved[]'),
    inputResponses: inputResponsesArg,
    requestState: requestStateArg,
  },
  outputSchema: { ...mrtr, matchId: z.string().optional(), designId: z.string(), assignments: z.array(shape('{regionId, role, label, component, confidence, candidates[{component, confidence, reasons[]}], source}')).optional(), unresolved: z.array(shape('{regionId, picked, options[]}')).optional(), questions: z.number().optional(), ...dsMeta },
  run(args, ctx) {
    const store = needStore(ctx);
    const design = loadDesign(ctx, args.designId);
    const v = pickVersion(ctx, design.data.dsVersion);
    const meta = versionMeta(v);
    const answered = readAnswers(ctx, 'match_components', args as Record<string, unknown>);
    const assignments = answered ? (answered.state as { assignments: Assignment[] }).assignments : assignRegions(v.data, design.data.layout);
    const questions = questionsFor(assignments, v.data, design.data.layout);
    const unresolved: MatchRow['unresolved'] = [];

    if (answered) {
      for (const q of questions) {
        const choice = answered.answers[q.key] ?? 'auto';
        const a = assignments.find((x) => x.regionId === q.regionId)!;
        if (choice === 'auto' || !a.candidates.some((c) => c.component === choice)) { a.source = 'unresolved'; unresolved.push({ regionId: a.regionId, picked: a.component ?? '', options: q.options.filter((o) => o.value !== 'auto').map((o) => o.value) }); }
        else { a.component = choice; a.confidence = Math.max(a.confidence, 0.95); a.source = 'answered'; a.note = undefined; }
      }
    } else if (args.strategy === 'ask' && questions.length) {
      return inputRequired(ctx, 'match_components', originalArgs(args as Record<string, unknown>), questions, { assignments }, { designId: design.id, questions: questions.length, assignments: assignments.map(compactAssignment) }, meta);
    } else {
      for (const q of questions) { const a = assignments.find((x) => x.regionId === q.regionId)!; a.source = 'unresolved'; unresolved.push({ regionId: a.regionId, picked: a.component ?? '', options: q.options.filter((o) => o.value !== 'auto').map((o) => o.value) }); }
    }
    // Questions beyond the cap were never asked: they are unresolved too.
    for (const a of assignments) {
      const [c1, c2] = a.candidates;
      if (c1 && c2 && c1.confidence - c2.confidence < 0.15 && a.source === 'auto' && !questions.some((q) => q.regionId === a.regionId)) { a.source = 'unresolved'; unresolved.push({ regionId: a.regionId, picked: a.component ?? '', options: a.candidates.slice(0, 3).map((c) => c.component) }); }
    }
    const created = store.create<MatchRow>('match', sub(ctx), { designId: design.id, dsVersion: v.resolved.effective, strategy: args.strategy, assignments, unresolved });
    store.update(design, { ...design.data, matches: [...design.data.matches, created.id] });
    const structured = { resultType: 'complete', matchId: created.id, designId: design.id, assignments: assignments.map(compactAssignment), unresolved, ...meta };
    const capped = capJson(structured, this.cap, `read design://${design.id}/matches/${created.id}.json for the full assignment tree`);
    const counts = { answered: assignments.filter((a) => a.source === 'answered').length, none: assignments.filter((a) => a.source === 'none').length };
    return {
      structured: capped.value,
      text: `Match ${created.id}: ${assignments.length} regions assigned (${counts.answered} answered, ${unresolved.length} unresolved, ${counts.none} without a system component). Next: resolve_tokens, then plan_component.`,
      links: [{ uri: `design://${design.id}/matches/${created.id}.json`, name: 'match.json', mimeType: 'application/json' }],
    };
  },
};

const compactAssignment = (a: Assignment): Record<string, unknown> => ({ regionId: a.regionId, role: a.role, label: a.label || undefined, component: a.component, confidence: a.confidence, candidates: a.candidates.slice(0, 3).map((c) => ({ component: c.component, confidence: c.confidence, reasons: c.reasons.slice(0, 2) })), source: a.source, note: a.note });

// ---- resolve_tokens ------------------------------------------------------------------------------
export const resolveTokens: ToolDef<{ matchId: z.ZodString; theme: z.ZodDefault<z.ZodEnum<{ light: 'light'; dark: 'dark' }>>; tolerance: z.ZodDefault<z.ZodEnum<{ strict: 'strict'; normal: 'normal'; loose: 'loose' }>>; inputResponses: typeof inputResponsesArg; requestState: typeof requestStateArg }> = {
  name: 'resolve_tokens',
  title: 'Resolve tokens',
  description: 'Map every raw value in a matched design to the nearest token with its delta. Off-scale values become questions (snap, keep as exception, propose a token), batched, ≤ 8 per call.',
  scope: 'design:ingest',
  cap: 6144,
  inputSchema: {
    matchId: z.string().min(1),
    theme: z.enum(['light', 'dark']).default('light'),
    tolerance: z.enum(['strict', 'normal', 'loose']).default('normal').describe('strict: exact only; loose: always snap'),
    inputResponses: inputResponsesArg,
    requestState: requestStateArg,
  },
  outputSchema: { ...mrtr, matchId: z.string(), tokenMap: z.array(shape('{regionId, property, raw, token?, cssVar?, delta?, status, suggestion?}')).optional(), exceptions: z.number().optional(), questions: z.number().optional(), ...dsMeta },
  run(args, ctx) {
    const store = needStore(ctx);
    const match = loadMatch(ctx, args.matchId);
    const design = loadDesign(ctx, match.data.designId);
    const v = pickVersion(ctx, match.data.dsVersion);
    const meta = versionMeta(v);
    const answered = readAnswers(ctx, 'resolve_tokens', args as Record<string, unknown>);
    const { entries, questions } = answered
      ? { entries: (answered.state as { entries: TokenEntry[] }).entries, questions: [] as Question[] }
      : resolveLayoutTokens(v.data, design.data.layout, args.theme, args.tolerance);
    if (answered) {
      const asked = resolveLayoutTokens(v.data, design.data.layout, args.theme, args.tolerance).questions;
      for (const q of asked) {
        const target = entries.find((e) => e.regionId === q.regionId && e.status === 'pending' && q.message.startsWith(e.raw));
        if (target) applyTokenAnswer(entries, v.data, target, answered.answers[q.key] ?? 'auto');
      }
      for (const e of entries) if (e.status === 'pending') { e.status = e.token ? 'snapped' : 'exception'; e.note = 'auto-resolved (not asked)'; }
    } else if (questions.length) {
      return inputRequired(ctx, 'resolve_tokens', originalArgs(args as Record<string, unknown>), questions, { entries }, { matchId: match.id, questions: questions.length, exceptions: entries.filter((e) => e.status === 'exception').length }, meta);
    }
    const exceptions = entries.filter((e) => e.status === 'exception' || e.status === 'proposed').length;
    const updated = store.update(match, { ...match.data, tokens: { theme: args.theme, tolerance: args.tolerance, entries, exceptions } });
    const tokenMap = entries.map((e) => ({ regionId: e.regionId, property: e.property, raw: e.raw, token: e.token, cssVar: e.cssVar, delta: e.delta, status: e.status, suggestion: e.suggestion }));
    const structured = { resultType: 'complete', matchId: updated.id, tokenMap, exceptions, ...meta };
    const exact = entries.filter((e) => e.status === 'exact').length;
    return {
      structured: capJson(structured, this.cap, `read design://${design.id}/matches/${match.id}.json for every entry`).value,
      text: `${entries.length} value(s): ${exact} exact, ${entries.filter((e) => e.status === 'snapped').length} snapped, ${exceptions} exception(s)/proposed. Next: plan_component.`,
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
  outputSchema: { planId: z.string(), plan: shape('{name, dsVersion, imports[], tree[], files[], contract[], a11y[], catalog[], exceptions[], unresolved[], stories[], tests[], notes[]}'), truncated: z.boolean().optional(), ...dsMeta },
  run(args, ctx) {
    const store = needStore(ctx);
    const match = loadMatch(ctx, args.matchId);
    const design = loadDesign(ctx, match.data.designId);
    const v = pickVersion(ctx, match.data.dsVersion);
    const meta = versionMeta(v);
    let tokens = match.data.tokens?.entries;
    if (!tokens) {
      // No resolve_tokens call: snap within tolerance, leave the rest as exceptions.
      const r = resolveLayoutTokens(v.data, design.data.layout, design.data.layout.theme === 'dark' ? 'dark' : 'light', 'normal');
      tokens = r.entries.map((e) => (e.status === 'pending' ? { ...e, status: 'exception' as const, note: 'off-scale; resolve_tokens was not called' } : e));
    }
    const plan = buildPlan(v.data, design.data.layout, match.data.assignments, tokens, { ...args.options, name: args.name, designId: design.id, matchId: match.id, unresolved: match.data.unresolved });
    const markdown = planMarkdown(plan);
    const created = store.create<PlanRow>('plan', sub(ctx), { designId: design.id, matchId: match.id, plan, markdown });
    store.update(design, { ...design.data, plans: [...design.data.plans, created.id] });
    const capped = capJson({ planId: created.id, plan, ...meta } as Record<string, unknown>, this.cap, `read design://${design.id}/plans/${created.id}.md for the full plan`);
    if (capped.truncated) capped.value.truncated = true;
    const components = plan.catalog.map((c) => c.component);
    return {
      structured: capped.value,
      text: `Plan ${created.id} for ${args.name}: ${components.length} components (${components.join(', ')}), ${plan.files.length} files, ${plan.exceptions.length} exception(s), ${plan.unresolved.length} unresolved match(es). Write the files, run the capture script, then run_checks.`,
      links: [{ uri: `design://${design.id}/plans/${created.id}.md`, name: 'plan.md', mimeType: 'text/markdown' }, { uri: `ds://${v.resolved.effective}/guidelines/contract`, name: 'component contract', mimeType: 'text/markdown' }],
    };
  },
};

export const DESIGN_TOOLS: ToolDef<z.ZodRawShape>[] = [ingestDesign, matchComponents, resolveTokens, planComponent] as unknown as ToolDef<z.ZodRawShape>[];

export { nearestNames };
