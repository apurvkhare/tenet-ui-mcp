// Path two, audit existing UI (DESIGN.md §5): audit_code over source files (static, paginated by
// file, auditId for deltas) and audit_page over a snapshot the host captured of a running page
// (`capture.mjs page`). The server never fetches a page and never executes user code.
import { z } from 'zod';
import { contractChecks } from '../checks/contract.js';
import { judgePage, PAGE_CHECKS, SnapshotSchema, type PageCheck } from '../checks/page.js';
import { byRule, deltaAgainst, GATING, overallStatus, paginate, publicFinding, saveReport, sortFindings, summarize, topFindings, type CheckStatus } from '../checks/report.js';
import { parseSource } from '../checks/source.js';
import { staticChecks, type Finding } from '../checks/static.js';
import { compareScreens } from '../checks/visual.js';
import { capJson } from './caps.js';
import type { ToolDef } from './catalog-tools.js';
import { pickVersion, ToolError, versionMeta } from './context.js';
import type { DesignRow } from './design-tools.js';

const dsVersionArg = z.string().default('latest').describe('Lockfile version, "0.4", or "latest".').meta({ 'x-mcp-header': 'DsVersion' });
const dsMeta = { dsVersion: z.string(), dsVersionNote: z.string().optional(), guidelinesRevision: z.string().optional() };
const shape = (fields: string): z.ZodUnknown => z.unknown().describe(fields);
const findingShape = shape('{id, check, rule, severity, file?, line?, message, fix: {hint, primitive?, token?, replacement?, guideline?, resource?}}');
const MAX_SNAPSHOT = 5 * 1024 * 1024;

// ---- audit_code ----------------------------------------------------------------------------------
export const auditCode: ToolDef<{ files: z.ZodArray<z.ZodObject<{ path: z.ZodString; content: z.ZodString }>>; dsVersion: typeof dsVersionArg; rules: z.ZodOptional<z.ZodArray<z.ZodString>>; theme: z.ZodDefault<z.ZodEnum<{ light: 'light'; dark: 'dark' }>>; auditId: z.ZodOptional<z.ZodString>; page: z.ZodDefault<z.ZodNumber> }> = {
  name: 'audit_code',
  title: 'Audit code',
  description: 'Static audit of source files against dsVersion: raw values (nearest token + delta), deprecated components/props from the migration registry, hand-built elements where a component exists, contract violations, static a11y rules. Paginated by file; returns an auditId for deltas.',
  scope: 'audit:run',
  cap: 16384,
  inputSchema: {
    files: z.array(z.object({ path: z.string().min(1).max(300), content: z.string().max(256 * 1024) })).min(1).max(64).describe('Source and style files (.tsx/.jsx/.ts/.js/.css).'),
    dsVersion: dsVersionArg,
    rules: z.array(z.string().max(60)).max(20).optional().describe('Rule ids or prefixes to include (e.g. "tokens", "a11y/missing-alt"); default all. See ds://…/guidelines/audit-rules.'),
    theme: z.enum(['light', 'dark']).default('light').describe('Theme for nearest-token resolution of colours.'),
    auditId: z.string().optional().describe('A previous audit to diff against: fixed / new / remaining.'),
    page: z.number().int().min(1).default(1),
  },
  outputSchema: {
    auditId: z.string(),
    status: z.enum(['pass', 'fail']),
    summary: shape('{critical, serious, error, warn, info, total}'),
    byRule: shape('{<rule>: count}'),
    checks: shape('{tokens|deprecations|contract|a11y|types: {status, detail}}'),
    files: z.array(shape('{path, findings, imports[], components[]}')),
    findings: z.array(findingShape),
    delta: shape('{previous, fixed, new, remaining}').optional(),
    pagination: shape('{page, pages, keys[]}').optional(),
    next: z.string().optional(),
    ...dsMeta,
  },
  run(args, ctx) {
    const v = pickVersion(ctx, args.dsVersion);
    const meta = versionMeta(v);
    const all = [...staticChecks(v.data, args.files, args.theme), ...contractChecks(v.data, args.files)];
    const filter = args.rules?.map((r) => r.trim()).filter(Boolean);
    const findings: Finding[] = filter?.length ? all.filter((f) => filter.some((r) => f.rule === r || f.rule.startsWith(`${r}/`) || f.check === r)) : all;
    sortFindings(findings);
    const checks: Record<string, CheckStatus> = {};
    for (const k of ['tokens', 'deprecations', 'contract', 'a11y', 'types'] as const) {
      const of = findings.filter((f) => f.check === k);
      checks[k] = { status: of.some((f) => GATING.has(f.severity)) ? 'fail' : 'pass', detail: `${of.length} finding(s)` };
    }
    const status = overallStatus(checks, findings, new Set());
    const summary = summarize(findings);
    const delta = deltaAgainst(ctx, args.auditId, findings);
    const { reportId } = saveReport(ctx, { kind: 'code', dsVersion: v.resolved.effective, status, checks, previous: args.auditId, delta, files: args.files.map((f) => f.path) }, findings);
    const files = args.files.map((f) => {
      const src = /\.(tsx|jsx|ts|js|mjs|mts)$/.test(f.path) ? parseSource(f, v.data.manifest.package) : undefined;
      return { path: f.path, findings: findings.filter((x) => x.file === f.path).length, imports: src?.packageImports ?? [], components: src?.components.filter((c) => c.exported).map((c) => c.name) ?? [] };
    });
    const paged = paginate(findings, args.page, this.cap);
    const top = topFindings(findings);
    const structured: Record<string, unknown> = {
      auditId: reportId, status, summary, byRule: byRule(findings), checks, files, findings: paged.findings.map(publicFinding),
      delta: delta ? { previous: delta.previous, fixed: delta.fixed, new: delta.new, remaining: delta.remaining } : undefined, pagination: paged.pagination,
      next: status === 'fail' ? `fix by severity (${top.join('; ')}); then run the capture script and call run_checks with auditId: "${reportId}" for the delta` : 'clean: run the capture script and run_checks to judge types, lint, tests and a11y',
      ...meta,
    };
    return {
      structured: capJson(structured, this.cap, 'pass `rules` to narrow, or page through findings').value,
      text: `${status.toUpperCase()} audit of ${args.files.length} file(s) against ${v.resolved.effective}: ${summary.total} finding(s) (${summary.critical} critical, ${summary.serious} serious, ${summary.error} error, ${summary.warn} warn).${top.length ? ` Start with: ${top.join('; ')}.` : ''}`,
      links: [{ uri: `audit://${reportId}/findings.json`, name: 'full findings', mimeType: 'application/json' }, { uri: `ds://${v.resolved.effective}/guidelines/audit-rules`, name: 'audit rule catalog', mimeType: 'text/markdown' }, { uri: `ds://${v.resolved.effective}/deprecations`, name: 'migration registry', mimeType: 'application/json' }],
    };
  },
};

// ---- audit_page ----------------------------------------------------------------------------------
export const auditPage: ToolDef<{ snapshot: z.ZodUnknown; dsVersion: typeof dsVersionArg; theme: z.ZodOptional<z.ZodEnum<{ light: 'light'; dark: 'dark' }>>; checks: z.ZodOptional<z.ZodArray<z.ZodEnum<Record<PageCheck, PageCheck>>>>; designId: z.ZodOptional<z.ZodString>; auditId: z.ZodOptional<z.ZodString>; page: z.ZodDefault<z.ZodNumber> }> = {
  name: 'audit_page',
  title: 'Audit page',
  description: 'Judge a running page from the capture script\'s snapshot.json (a11y tree, computed styles, axe, screenshot): values that resolve to no token, contrast vs the documented pairs, missing names / heading and focus order, drift vs a designId (advisory). Returns an auditId.',
  scope: 'audit:run',
  cap: 16384,
  inputSchema: {
    snapshot: z.unknown().describe('The capture script\'s snapshot.json (capture.mjs page <url> [--embed-screenshots]).'),
    dsVersion: dsVersionArg,
    theme: z.enum(['light', 'dark']).optional().describe('Default: the snapshot\'s theme.'),
    checks: z.array(z.enum(PAGE_CHECKS)).optional().describe('Subset of runtime, tokens, contrast, a11y, visual; default all.'),
    designId: z.string().optional().describe('Design to measure drift against (needs screenshot.data in the snapshot).'),
    auditId: z.string().optional().describe('A previous audit to diff against.'),
    page: z.number().int().min(1).default(1),
  },
  outputSchema: {
    auditId: z.string(),
    status: z.enum(['pass', 'fail']),
    page: shape('{url, title, theme, viewport, elements}'),
    summary: shape('{critical, serious, error, warn, info, total}'),
    byRule: shape('{<rule>: count}'),
    checks: shape('{runtime|tokens|contrast|a11y|visual: {status, detail}}'),
    stats: shape('{elements, distinctValues, offTokenValues, textPairs, treeNodes, focusable}'),
    findings: z.array(findingShape),
    visual: shape('{reference, screenshots[{ssim, regions[][], verdict}]}').optional(),
    delta: shape('{previous, fixed, new, remaining}').optional(),
    pagination: shape('{page, pages, keys[]}').optional(),
    next: z.string().optional(),
    ...dsMeta,
  },
  run(args, ctx) {
    const v = pickVersion(ctx, args.dsVersion);
    const meta = versionMeta(v);
    const raw = JSON.stringify(args.snapshot ?? null);
    if (raw.length > MAX_SNAPSHOT) throw new ToolError(`snapshot is ${(raw.length / 1024 / 1024).toFixed(1)} MB; the limit is 5 MB (drop screenshot.data or reduce computedStyles)`, 'snapshot_too_large');
    const parsed = SnapshotSchema.safeParse(args.snapshot);
    if (!parsed.success) throw new ToolError(`snapshot is not a capture snapshot.json: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'invalid_snapshot');
    const snap = parsed.data;
    if (!snap.computedStyles && !snap.a11yTree && !snap.axe && !snap.runtimeContract) throw new ToolError('snapshot is not a capture snapshot.json: none of computedStyles, a11yTree, axe or runtimeContract is present; capture it with capture.mjs page <url>', 'invalid_snapshot');
    const theme: 'light' | 'dark' = args.theme ?? (snap.theme === 'dark' ? 'dark' : 'light');
    const wanted = new Set<PageCheck>(args.checks ?? [...PAGE_CHECKS]);
    const judged = judgePage(v.data, snap, theme, wanted);
    const findings = judged.findings;
    const checks = judged.checks;

    let visual: Record<string, unknown> | undefined;
    if (wanted.has('visual')) {
      const ref = args.designId && ctx.designs && ctx.principal ? ctx.designs.get<DesignRow>('design', ctx.principal.sub, args.designId) : undefined;
      if (args.designId && !ref) throw new ToolError(`design ${args.designId} not found (unknown, expired, or not yours)`, 'not_found');
      const refPng = ref && ctx.designs && ctx.principal ? ctx.designs.getBlob(ctx.principal.sub, ref.id, 'screenshot') : undefined;
      if (!args.designId) checks.visual = { status: 'skipped', detail: 'no designId; nothing to measure drift against' };
      else if (!snap.screenshot?.data) checks.visual = { status: 'skipped', detail: 'snapshot has no screenshot.data; capture with --embed-screenshots' };
      else if (!refPng) checks.visual = { status: 'skipped', detail: `design ${ref!.id} was ingested from a layout, not an image` };
      else {
        visual = compareScreens(ref!, refPng, [{ story: snap.title || 'page', theme, data: snap.screenshot.data }], findings, v.data.version);
        checks.visual = { status: 'pass', detail: 'compared; advisory' };
      }
    }
    sortFindings(findings);
    const summary = summarize(findings);
    const status = overallStatus(checks, findings, new Set(['visual']));
    const delta = deltaAgainst(ctx, args.auditId, findings);
    const { reportId } = saveReport(ctx, { kind: 'page', dsVersion: v.resolved.effective, status, checks, designId: args.designId, previous: args.auditId, delta }, findings);
    const paged = paginate(findings, args.page, this.cap, (f) => f.rule);
    const top = topFindings(findings);
    const structured: Record<string, unknown> = {
      auditId: reportId, status,
      page: { url: snap.url, title: snap.title, theme, viewport: snap.viewport, elements: snap.computedStyles?.elements.length ?? 0 },
      summary, byRule: byRule(findings), checks, stats: judged.stats, findings: paged.findings.map(publicFinding), visual,
      delta: delta ? { previous: delta.previous, fixed: delta.fixed, new: delta.new, remaining: delta.remaining } : undefined, pagination: paged.pagination,
      next: status === 'fail' ? `fix by severity (${top.join('; ')}); audit_code the files behind the page, then re-capture and call audit_page again with auditId: "${reportId}"` : 'runtime, tokens, contrast and a11y are clean; look at the screenshot yourself for anything the numbers cannot see',
      ...meta,
    };
    return {
      structured: capJson(structured, this.cap, 'pass `checks` to narrow, or page through findings').value,
      text: `${status.toUpperCase()} page audit (${snap.title || snap.url || 'page'}, ${theme}) against ${v.resolved.effective}: ${summary.total} finding(s) (${summary.critical} critical, ${summary.serious} serious, ${summary.error} error, ${summary.warn} warn); ${Object.entries(checks).map(([k, s]) => `${k} ${s.status}`).join(', ')}.${top.length ? ` Start with: ${top.join('; ')}.` : ''}`,
      links: [{ uri: `audit://${reportId}/findings.json`, name: 'full findings', mimeType: 'application/json' }, { uri: `ds://${v.resolved.effective}/guidelines/contract`, name: 'component contract', mimeType: 'text/markdown' }, { uri: `ds://${v.resolved.effective}/tokens/fgColor.json`, name: 'text colours with documented contrast pairs', mimeType: 'application/json' }],
    };
  },
};

export const AUDIT_TOOLS: ToolDef<z.ZodRawShape>[] = [auditCode, auditPage] as unknown as ToolDef<z.ZodRawShape>[];
