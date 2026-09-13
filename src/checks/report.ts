// Shared report plumbing for run_checks, audit_code and audit_page (DESIGN.md §5, §6): the
// stored report row, the findings blob behind audit://{auditId}/findings.json, the delta against
// a previous report, sorting, summary and pagination. One shape for every report.
import type { DesignStore, Row } from '../store/design-store.js';
import { ToolError, type ToolContext } from '../tools/context.js';
import type { Finding, Severity } from './static.js';

export type ReportKind = 'checks' | 'code' | 'page';
export type CheckStatus = { status: 'pass' | 'fail' | 'skipped' | 'error'; detail: string };

export interface ReportRow {
  kind: ReportKind;
  dsVersion: string;
  status: 'pass' | 'fail';
  findingIds: string[];
  summary: Record<string, number>;
  checks: Record<string, CheckStatus>;
  designId?: string;
  previous?: string;
  delta?: Delta;
  files?: string[];
}
export interface Delta { previous: string; fixed: number; new: number; remaining: number; fixedIds?: string[]; newIds?: string[] }

export const GATING: ReadonlySet<Severity> = new Set(['critical', 'serious', 'error']);
const ORDER: Record<Severity, number> = { critical: 0, serious: 1, error: 2, warn: 3, info: 4 };

export function sortFindings(findings: Finding[]): Finding[] {
  return findings.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || (a.file ?? '').localeCompare(b.file ?? '') || (a.line ?? 0) - (b.line ?? 0) || a.rule.localeCompare(b.rule));
}

export function summarize(findings: Finding[]): Record<string, number> {
  const summary: Record<string, number> = { critical: 0, serious: 0, error: 0, warn: 0, info: 0, total: findings.length };
  for (const f of findings) summary[f.severity] = (summary[f.severity] ?? 0) + 1;
  return summary;
}

/** Findings by rule, for the text summary and the dashboard: `{rule: count}` sorted by count. */
export function byRule(findings: Finding[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of findings) out[f.rule] = (out[f.rule] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => b[1] - a[1]));
}

export const publicFinding = (f: Finding): Record<string, unknown> => ({ id: f.id, check: f.check, rule: f.rule, severity: f.severity, file: f.file, line: f.line, column: f.column, message: f.message, fix: f.fix });

/** Delta against a previous report of the caller's; not-found for another principal's id. */
export function deltaAgainst(ctx: ToolContext, auditId: string | undefined, findings: Finding[]): Delta | undefined {
  if (!auditId) return undefined;
  if (!ctx.designs || !ctx.principal) throw new ToolError('reports are not stored on this transport; auditId cannot be resolved', 'unavailable');
  const prev = ctx.designs.get<ReportRow>('audit', ctx.principal.sub, auditId);
  if (!prev) throw new ToolError(`report ${auditId} not found (unknown, expired, or not yours)`, 'not_found');
  const before = new Set(prev.data.findingIds);
  const now = new Set(findings.map((f) => f.id));
  const fixedIds = [...before].filter((id) => !now.has(id));
  const newIds = [...now].filter((id) => !before.has(id));
  return { previous: prev.id, fixed: fixedIds.length, new: newIds.length, remaining: [...now].filter((id) => before.has(id)).length, fixedIds: fixedIds.slice(0, 50), newIds: newIds.slice(0, 50) };
}

/** Store the report row and its findings blob; returns the id (a local one when nothing is stored). */
export function saveReport(ctx: ToolContext, row: Omit<ReportRow, 'findingIds' | 'summary'>, findings: Finding[]): { reportId: string; stored: boolean } {
  const summary = summarize(findings);
  if (!ctx.designs || !ctx.principal) return { reportId: `${row.kind === 'checks' ? 'chk' : 'aud'}_${Date.now().toString(16)}`, stored: false };
  const stored: Row<ReportRow> = ctx.designs.create<ReportRow>('audit', ctx.principal.sub, { ...row, findingIds: findings.map((f) => f.id), summary });
  ctx.designs.putBlob(ctx.principal.sub, stored.id, 'findings.json', Buffer.from(JSON.stringify({ reportId: stored.id, kind: row.kind, dsVersion: row.dsVersion, status: row.status, summary, checks: row.checks, findings: findings.map(publicFinding) }, null, 2)));
  return { reportId: stored.id, stored: true };
}

export function readReportFindings(designs: DesignStore, sub: string, auditId: string): Record<string, unknown> | undefined {
  const blob = designs.getBlob(sub, auditId, 'findings.json');
  return blob ? (JSON.parse(blob.toString('utf8')) as Record<string, unknown>) : undefined;
}

/** Overall status: any gating check failed / errored, or any gating finding outside the advisory checks. */
export function overallStatus(checks: Record<string, CheckStatus>, findings: Finding[], advisory: ReadonlySet<string>): 'pass' | 'fail' {
  const gatingChecks = Object.entries(checks).filter(([k]) => !advisory.has(k));
  return gatingChecks.some(([, s]) => s.status === 'fail' || s.status === 'error') || findings.some((f) => !advisory.has(f.check) && GATING.has(f.severity)) ? 'fail' : 'pass';
}

/** Page findings by file (or by rule when there are no files) so a report stays under its cap. */
export function paginate(findings: Finding[], page: number, cap: number, keyOf: (f: Finding) => string = (f) => f.file ?? '(results)'): { findings: Finding[]; pagination?: Record<string, unknown> } {
  const bytesOf = (v: unknown): number => Buffer.byteLength(JSON.stringify(v));
  const keys = [...new Set(findings.map(keyOf))];
  if (bytesOf(findings) <= cap * 0.75 || keys.length < 2) return { findings };
  const perPage = Math.max(1, Math.ceil(keys.length / Math.ceil(bytesOf(findings) / (cap * 0.75))));
  const pages = Math.ceil(keys.length / perPage);
  const p = Math.min(Math.max(1, page), pages);
  const slice = new Set(keys.slice((p - 1) * perPage, p * perPage));
  return { findings: findings.filter((f) => slice.has(keyOf(f))), pagination: { page: p, pages, keys: [...slice], hint: p < pages ? `call again with page: ${p + 1}` : undefined } };
}

export const topFindings = (findings: Finding[], n = 3): string[] => findings.filter((f) => GATING.has(f.severity)).slice(0, n).map((f) => `${f.severity} ${f.rule}${f.file ? ` ${f.file}:${f.line ?? ''}` : f.line ? ` :${f.line}` : ''}`);
