// run_checks (DESIGN.md §5, §11, rev 3): the same tool both paths end on. Accepts the files the
// agent wrote plus the results the agent produced with the skill's capture script, judges them
// against the contract for dsVersion, and returns one report with fix hints by severity. Nothing
// executes on the server. Structural checks gate; the visual check informs.
import { z } from 'zod';
import { judgeResults, ResultsSchema, type CaptureResults } from '../checks/judge.js';
import { decodePng, ssim } from '../checks/ssim.js';
import { staticChecks, type Finding, type Severity } from '../checks/static.js';
import type { Row } from '../store/design-store.js';
import { capJson } from './caps.js';
import type { ToolDef } from './catalog-tools.js';
import { pickVersion, ToolError, versionMeta, type ToolContext } from './context.js';
import type { DesignRow } from './design-tools.js';

const dsVersionArg = z.string().default('latest').describe('Lockfile version, "0.4", or "latest".').meta({ 'x-mcp-header': 'DsVersion' });
const dsMeta = { dsVersion: z.string(), dsVersionNote: z.string().optional(), guidelinesRevision: z.string().optional() };
const shape = (fields: string): z.ZodUnknown => z.unknown().describe(fields);

export const CHECKS = ['types', 'lint', 'tokens', 'deprecations', 'tests', 'a11y', 'visual', 'contract'] as const;
const GATING: ReadonlySet<Severity> = new Set(['critical', 'serious', 'error']);
const ORDER: Record<Severity, number> = { critical: 0, serious: 1, error: 2, warn: 3, info: 4 };

export interface ReportRow {
  kind: 'checks';
  dsVersion: string;
  status: 'pass' | 'fail';
  findingIds: string[];
  summary: Record<string, number>;
  designId?: string;
}

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
    pagination: shape('{page, pages, files[]}').optional(),
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
    const findings: Finding[] = staticChecks(v.data, args.files, args.theme).filter((f) => wanted.has(f.check) || (f.check === 'a11y' && wanted.has('a11y')));
    const checks: Record<string, { status: 'pass' | 'fail' | 'skipped' | 'error'; detail: string }> = {};
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

    // 4. Assemble, sort, delta, paginate.
    findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0));
    const summary: Record<string, number> = { critical: 0, serious: 0, error: 0, warn: 0, info: 0, total: findings.length };
    for (const f of findings) summary[f.severity] = (summary[f.severity] ?? 0) + 1;
    const gatingChecks = Object.entries(checks).filter(([k]) => k !== 'visual' && k !== 'contract');
    const status: 'pass' | 'fail' = gatingChecks.some(([, s]) => s.status === 'fail' || s.status === 'error') || findings.some((f) => f.check !== 'visual' && GATING.has(f.severity)) ? 'fail' : 'pass';
    const skipped = Object.entries(checks).filter(([, s]) => s.status === 'skipped').map(([k, s]) => `${k}: ${s.detail}`);

    let delta: Record<string, unknown> | undefined;
    if (args.auditId && ctx.designs && ctx.principal) {
      const prev = ctx.designs.get<ReportRow>('audit', ctx.principal.sub, args.auditId);
      if (!prev) throw new ToolError(`report ${args.auditId} not found (unknown, expired, or not yours)`, 'not_found');
      const before = new Set(prev.data.findingIds);
      const now = new Set(findings.map((f) => f.id));
      delta = { previous: prev.id, fixed: [...before].filter((id) => !now.has(id)).length, new: [...now].filter((id) => !before.has(id)).length, remaining: [...now].filter((id) => before.has(id)).length };
    }
    const report = ctx.designs && ctx.principal ? ctx.designs.create<ReportRow>('audit', ctx.principal.sub, { kind: 'checks', dsVersion: v.resolved.effective, status, findingIds: findings.map((f) => f.id), summary, designId: args.designId }) : undefined;
    const reportId = report?.id ?? `chk_${Date.now().toString(16)}`;

    const files = [...new Set(findings.map((f) => f.file ?? '(results)'))];
    let pageFindings = findings;
    let pagination: Record<string, unknown> | undefined;
    const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
    if (bytesOf(findings) > this.cap * 0.75 && files.length > 1) {
      const perPage = Math.max(1, Math.ceil(files.length / Math.ceil(bytesOf(findings) / (this.cap * 0.75))));
      const pages = Math.ceil(files.length / perPage);
      const page = Math.min(args.page, pages);
      const slice = new Set(files.slice((page - 1) * perPage, page * perPage));
      pageFindings = findings.filter((f) => slice.has(f.file ?? '(results)'));
      pagination = { page, pages, files: [...slice], hint: page < pages ? `call again with page: ${page + 1}` : undefined };
    }
    const top = findings.filter((f) => GATING.has(f.severity)).slice(0, 3).map((f) => `${f.severity} ${f.rule}${f.file ? ` ${f.file}:${f.line ?? ''}` : ''}`);
    const structured: Record<string, unknown> = {
      reportId, status, summary, checks, findings: pageFindings.map(publicFinding), skipped, visual, delta, pagination,
      nextRound: status === 'fail' ? `fix by severity (${top.join('; ')}), re-run the capture script, call run_checks again with auditId: "${reportId}" for the delta; at most three rounds` : undefined,
      ...meta,
    };
    const capped = capJson(structured, this.cap, 'request fewer `checks`, or page through findings');
    return {
      structured: capped.value,
      text: `${status.toUpperCase()} against ${v.resolved.effective}: ${summary.critical} critical, ${summary.serious} serious, ${summary.error} error, ${summary.warn} warn${skipped.length ? `; skipped: ${skipped.map((s) => s.split(':')[0]).join(', ')}` : ''}.${top.length ? ` Start with: ${top.join('; ')}.` : ''}`,
      links: [{ uri: `ds://${v.resolved.effective}/guidelines/audit-rules`, name: 'audit rule catalog', mimeType: 'text/markdown' }, { uri: `ds://${v.resolved.effective}/guidelines/contract`, name: 'component contract', mimeType: 'text/markdown' }],
    };
  },
};

const publicFinding = (f: Finding): Record<string, unknown> => ({ id: f.id, check: f.check, rule: f.rule, severity: f.severity, file: f.file, line: f.line, column: f.column, message: f.message, fix: f.fix });

function compareScreens(ref: Row<DesignRow>, refPng: Buffer, shots: Array<{ story: string; theme: string; data?: string }>, findings: Finding[], version: string): Record<string, unknown> {
  let reference;
  try { reference = decodePng(refPng); } catch { return { reference: ref.id, error: 'reference is not a PNG' }; }
  const out: Array<Record<string, unknown>> = [];
  for (const s of shots) {
    let img;
    try { img = decodePng(Buffer.from(s.data!, 'base64')); } catch { out.push({ story: s.story, theme: s.theme, error: 'screenshot is not a PNG' }); continue; }
    const r = ssim(reference, img);
    const low = r.map.flatMap((row, y) => row.map((v, x) => ({ v, x, y }))).filter((c) => c.v < 0.7);
    const verdict = r.score >= 0.85 && !low.length ? 'similar' : 'review';
    out.push({ story: s.story, theme: s.theme, ssim: r.score, regions: r.map, comparedAt: `${r.width}×${r.height}`, verdict, lowRegions: low.map((c) => `row ${c.y + 1} col ${c.x + 1} (${c.v})`) });
    if (verdict === 'review') findings.push({ check: 'visual', rule: 'visual/ssim', severity: 'info', message: `${s.story} [${s.theme}] SSIM ${r.score} vs the design${low.length ? `; regions below 0.7: ${low.map((c) => `r${c.y + 1}c${c.x + 1}`).join(', ')}` : ''}`, fix: { hint: 'advisory: look at both images side by side; the design screenshot is design://…/screenshot.png', resource: `design://${ref.id}/screenshot.png` }, id: `visual|ssim|${s.story}|${s.theme}` });
  }
  return { reference: `design://${ref.id}/screenshot.png`, dsVersion: version, screenshots: out, note: 'SSIM is a number to track; whether a difference matters is your call' };
}

export const CHECK_TOOLS: ToolDef<z.ZodRawShape>[] = [runChecks] as unknown as ToolDef<z.ZodRawShape>[];
