// run_checks (DESIGN.md §5, §11, rev 3): the same tool both paths end on. Accepts the files the
// agent wrote plus the results the agent produced with the skill's capture script, judges them
// against the contract for dsVersion, and returns one report with fix hints by severity. Nothing
// executes on the server. Structural checks gate; the visual check informs.
import { z } from 'zod';
import { contractChecks } from '../checks/contract.js';
import { judgeResults, ResultsSchema, type CaptureResults } from '../checks/judge.js';
import { deltaAgainst, GATING, overallStatus, paginate, publicFinding, saveReport, sortFindings, summarize, topFindings, type CheckStatus } from '../checks/report.js';
import { staticChecks, type Finding } from '../checks/static.js';
import { compareScreens } from '../checks/visual.js';
import { capJson } from './caps.js';
import type { ToolDef } from './catalog-tools.js';
import { pickVersion, ToolError, versionMeta, type ToolContext } from './context.js';
import type { DesignRow } from './design-tools.js';

const dsVersionArg = z.string().default('latest').describe('Lockfile version, "0.4", or "latest".').meta({ 'x-mcp-header': 'DsVersion' });
const dsMeta = { dsVersion: z.string(), dsVersionNote: z.string().optional(), guidelinesRevision: z.string().optional() };
const shape = (fields: string): z.ZodUnknown => z.unknown().describe(fields);

export const CHECKS = ['types', 'lint', 'tokens', 'deprecations', 'tests', 'a11y', 'visual', 'contract'] as const;
const ADVISORY: ReadonlySet<string> = new Set(['visual', 'contract']);

export const runChecks: ToolDef<{ files: z.ZodDefault<z.ZodArray<z.ZodObject<{ path: z.ZodString; content: z.ZodString }>>>; results: z.ZodOptional<z.ZodUnknown>; checks: z.ZodOptional<z.ZodArray<z.ZodEnum<Record<(typeof CHECKS)[number], (typeof CHECKS)[number]>>>>; dsVersion: typeof dsVersionArg; theme: z.ZodDefault<z.ZodEnum<{ light: 'light'; dark: 'dark' }>>; designId: z.ZodOptional<z.ZodString>; auditId: z.ZodOptional<z.ZodString>; page: z.ZodDefault<z.ZodNumber> }> = {
  name: 'run_checks',
  title: 'Run checks',
  description: 'Judge the files you wrote and the results you captured (tsc, lint, tests, axe, screenshot via the skill\'s capture script) against the contract for dsVersion: one report with fix hints by severity. Types, lint, tokens, deprecations, tests and a11y gate; visual informs. Nothing runs on the server.',
  scope: 'checks:run',
  cap: 16384,
  inputSchema: {
    files: z.array(z.object({ path: z.string().min(1).max(300), content: z.string().max(256 * 1024) })).max(64).default([]).describe('Source files to scan statically (tokens, deprecations, raw elements, contract).'),
    results: z.unknown().optional().describe('The capture script\'s results.json (checks.types / lint / tests / a11y / visual). Omitted checks are reported as skipped.'),
    checks: z.array(z.enum(CHECKS)).optional().describe('Subset to report; default all.'),
    dsVersion: dsVersionArg,
    theme: z.enum(['light', 'dark']).default('light'),
    designId: z.string().optional().describe('Compare screenshots against this design\'s image (needs screenshot data in results).'),
    auditId: z.string().optional().describe('A previous report to diff against: fixed / new / remaining.'),
    page: z.number().int().min(1).default(1).describe('Findings are paginated by file when the report exceeds the cap.'),
  },
  outputSchema: {
    reportId: z.string(),
    status: z.enum(['pass', 'fail']),
    summary: shape('{critical, serious, error, warn, info, total}'),
    checks: shape('{<check>: {status: pass|fail|skipped|error, detail}}'),
    findings: z.array(shape('{check, rule, severity, file?, line?, message, fix: {hint, primitive?, token?, replacement?, guideline?, resource?}}')),
    skipped: z.array(z.string()),
    visual: shape('{reference, screenshots[{story, theme, ssim, regions[][], verdict}]}').optional(),
    delta: shape('{fixed, new, remaining}').optional(),
    pagination: shape('{page, pages, keys[]}').optional(),
    nextRound: z.string().optional(),
    ...dsMeta,
  },
  run(args, ctx) {
    const v = pickVersion(ctx, args.dsVersion);
    const meta = versionMeta(v);
    const wanted = new Set<string>(args.checks ?? [...CHECKS]);
    let results: CaptureResults | undefined;
    if (args.results !== undefined) {
      const parsed = ResultsSchema.safeParse(args.results);
      if (!parsed.success) throw new ToolError(`results is not a capture results.json: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'invalid_results');
      results = parsed.data;
    }

    // 1. Static scan (server-side): tokens, deprecations, raw elements, contract.
    const findings: Finding[] = [...staticChecks(v.data, args.files, args.theme), ...contractChecks(v.data, args.files)].filter((f) => wanted.has(f.check));
    const checks: Record<string, CheckStatus> = {};
    for (const k of ['tokens', 'deprecations', 'contract'] as const) {
      if (!wanted.has(k)) continue;
      const n = findings.filter((f) => f.check === k && GATING.has(f.severity)).length;
      checks[k] = args.files.length ? { status: n ? 'fail' : 'pass', detail: `${findings.filter((f) => f.check === k).length} finding(s) over ${args.files.length} file(s)` } : { status: 'skipped', detail: 'no files supplied' };
    }
    // 2. Judgment over what the agent ran.
    if (results) {
      const judged = judgeResults(v.data, results, args.theme);
      findings.push(...judged.findings.filter((f) => wanted.has(f.check)));
      for (const [k, s] of Object.entries(judged.checks)) if (wanted.has(k)) checks[k] = s;
    } else {
      for (const k of ['types', 'lint', 'tests', 'a11y'] as const) if (wanted.has(k)) checks[k] = { status: 'skipped', detail: 'no results supplied — run the capture script and pass results.json' };
    }
    // 3. Visual: SSIM against the design's screenshot, advisory.
    let visual: Record<string, unknown> | undefined;
    if (wanted.has('visual')) {
      const shots = (results?.checks.visual?.screenshots ?? []).filter((s) => s.status === 'captured');
      const withData = shots.filter((s) => s.data);
      const ref = args.designId && ctx.designs && ctx.principal ? ctx.designs.get<DesignRow>('design', ctx.principal.sub, args.designId) : undefined;
      if (args.designId && !ref) throw new ToolError(`design ${args.designId} not found (unknown, expired, or not yours)`, 'not_found');
      const refPng = ref && ctx.designs && ctx.principal ? ctx.designs.getBlob(ctx.principal.sub, ref.id, 'screenshot') : undefined;
      if (!shots.length) checks.visual = { status: 'skipped', detail: results?.checks.visual?.reason ?? 'no screenshots in results' };
      else if (!withData.length) checks.visual = { status: 'skipped', detail: 'screenshots have no embedded bytes; run the capture script with --embed-screenshots' };
      else if (!ref) checks.visual = { status: 'skipped', detail: `${withData.length} screenshot(s) received but no designId to compare against; compare with the baseline resource yourself` };
      else if (!refPng) checks.visual = { status: 'skipped', detail: `design ${ref.id} was ingested from a layout, not an image; nothing to compare pixels against` };
      else {
        visual = compareScreens(ref, refPng, withData, findings, v.data.version);
        checks.visual = { status: 'pass', detail: `${withData.length} screenshot(s) compared; advisory` };
      }
    }

    // 4. Assemble, sort, delta, store, paginate.
    sortFindings(findings);
    const summary = summarize(findings);
    const status = overallStatus(checks, findings, ADVISORY);
    const skipped = Object.entries(checks).filter(([, s]) => s.status === 'skipped').map(([k, s]) => `${k}: ${s.detail}`);
    const delta = deltaAgainst(ctx, args.auditId, findings);
    const { reportId } = saveReport(ctx, { kind: 'checks', dsVersion: v.resolved.effective, status, checks, designId: args.designId, previous: args.auditId, delta, files: args.files.map((f) => f.path) }, findings);
    const paged = paginate(findings, args.page, this.cap);
    const top = topFindings(findings);
    const structured: Record<string, unknown> = {
      reportId, status, summary, checks, findings: paged.findings.map(publicFinding), skipped, visual, delta: delta ? { previous: delta.previous, fixed: delta.fixed, new: delta.new, remaining: delta.remaining } : undefined, pagination: paged.pagination,
      nextRound: status === 'fail' ? `fix by severity (${top.join('; ')}), re-run the capture script, call run_checks again with auditId: "${reportId}" for the delta; at most three rounds` : undefined,
      ...meta,
    };
    const capped = capJson(structured, this.cap, 'request fewer `checks`, or page through findings');
    return {
      structured: capped.value,
      text: `${status.toUpperCase()} against ${v.resolved.effective}: ${summary.critical} critical, ${summary.serious} serious, ${summary.error} error, ${summary.warn} warn${skipped.length ? `; skipped: ${skipped.map((s) => s.split(':')[0]).join(', ')}` : ''}.${top.length ? ` Start with: ${top.join('; ')}.` : ''}`,
      links: [{ uri: `audit://${reportId}/findings.json`, name: 'full findings', mimeType: 'application/json' }, { uri: `ds://${v.resolved.effective}/guidelines/audit-rules`, name: 'audit rule catalog', mimeType: 'text/markdown' }, { uri: `ds://${v.resolved.effective}/guidelines/contract`, name: 'component contract', mimeType: 'text/markdown' }],
    };
  },
};

export const CHECK_TOOLS: ToolDef<z.ZodRawShape>[] = [runChecks] as unknown as ToolDef<z.ZodRawShape>[];
export type { ToolContext };
