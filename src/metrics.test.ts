import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HookEventSchema, MetricsStore } from './metrics.js';
import { toolMetrics } from './server.js';

test('toolMetrics derives names, counts and outcomes only', () => {
  const m = toolMetrics('run_checks', { auditId: 'aud_1', files: [{ path: 'secret.tsx', content: 'x' }] }, { status: 'fail', summary: { total: 7, critical: 2 }, checks: { types: { status: 'pass', detail: 'private' }, lint: { status: 'fail' } }, delta: { fixed: 3, remaining: 4 }, dsVersionNote: 'requested 0.4: newest patch', findings: [{ message: 'raw colour #fff' }] });
  assert.deepEqual(m, { versionFallback: true, outcome: 'fail', findings: 7, critical: 2, checks: { types: 'pass', lint: 'fail' }, round: 2, fixed: 3, remaining: 4, withPrevious: true });
  assert.ok(!JSON.stringify(m).includes('secret') && !JSON.stringify(m).includes('#fff'));
  assert.deepEqual(toolMetrics('search_components', { query: 'x' }, { results: [] }), { zeroResults: true });
  assert.deepEqual(toolMetrics('match_components', {}, { resultType: 'input_required', questions: 2, assignments: [{ confidence: 0.4 }, { confidence: 0.9 }] }), { resultType: 'input_required', questions: 2, lowConfidence: 1 });
});

test('HookEventSchema rejects free text and oversized fields', () => {
  assert.ok(HookEventSchema.safeParse({ event: 'hook.file', sessionId: 's', after: 'audit', ext: '.tsx', fileHash: 'abcdef0123456789' }).success);
  assert.ok(!HookEventSchema.safeParse({ event: 'hook.file', sessionId: 's', after: 'whatever' }).success);
  assert.ok(!HookEventSchema.safeParse({ event: 'hook.session', sessionId: 'x'.repeat(81) }).success);
});

test('MetricsStore.summary answers the §7 questions from a spool of server and hook events', () => {
  const store = new MetricsStore(mkdtempSync(join(tmpdir(), 'tenet-metrics-')));
  const day = new Date().toISOString();
  const tool = (tool: string, extra: Record<string, unknown> = {}): void => store.record({ event: 'tool', traceId: 't', tool, status: 'ok', durationMs: 10, bytes: 1000, sub: 'a', dsVersion: '0.4.0', ...extra });
  tool('search_components', { zeroResults: true });
  tool('search_components', { zeroResults: false, sub: 'b' });
  tool('get_component', { full: true });
  tool('get_component', { full: false, durationMs: 90 });
  tool('match_components', { resultType: 'input_required', questions: 2 });
  tool('match_components', { resultType: 'complete', unresolved: 1, lowConfidence: 2 });
  tool('run_checks', { outcome: 'fail', round: 1, checks: { types: 'pass', lint: 'fail', tests: 'skipped' }, findings: 5, critical: 1 });
  tool('run_checks', { outcome: 'pass', round: 2, checks: { types: 'pass', lint: 'pass' }, findings: 0, fixed: 5, remaining: 0 });
  tool('run_checks', { outcome: 'pass', round: 1, checks: { types: 'pass', lint: 'pass', tests: 'pass' }, findings: 0, versionFallback: true, dsVersion: '0.4.0' });
  tool('audit_code', { outcome: 'fail', round: 1, findings: 8 });
  tool('audit_code', { outcome: 'pass', round: 2, findings: 2, fixed: 6 });
  store.record({ event: 'request', traceId: 't', method: 'POST', path: '/mcp', status: 200, durationMs: 12 });
  store.record({ event: 'hook.tool', sessionId: 's1', tool: 'plan_component', ts: day });
  store.record({ event: 'hook.file', sessionId: 's1', after: 'plan', ext: '.tsx', fileHash: 'ab' });
  store.record({ event: 'hook.file', sessionId: 's1', after: 'audit', ext: '.tsx', fileHash: 'cd' });
  store.record({ event: 'hook.session', sessionId: 's1', rounds: 2, green: true, accepted: true, suppressed: 1, writesAfterPlan: 1, writesAfterAudit: 1, lookupsBeforeWrite: 3, toolCalls: 6 });
  store.record({ event: 'hook.session', sessionId: 's2', rounds: 3, green: false, accepted: false, suppressed: 0 });
  const s = store.summary(7) as Record<string, Record<string, unknown>>;
  assert.equal(s.used!.calls, 11);
  assert.equal(s.used!.principals, 2);
  assert.equal(s.used!.sessions, 2);
  const per = s.used!.perTool as Record<string, { calls: number; p95: number; principals: number }>;
  assert.equal(per.get_component!.calls, 2);
  assert.equal(per.get_component!.p95, 90);
  assert.equal(per.search_components!.principals, 2);
  assert.deepEqual(s.right, { elicitationRounds: 1, completed: 1, unresolvedPicks: 1, lowConfidenceMatches: 2 });
  const helps = s.helps as Record<string, unknown>;
  assert.equal(helps.runChecks, 3);
  assert.equal(helps.firstRunPassRate, 0.5);
  assert.deepEqual((helps.firstRunByCheck as Record<string, unknown>).lint, { pass: 1, fail: 1, skipped: 0 });
  assert.equal(helps.findingsPerAudit, 5);
  assert.equal(helps.findingsFixedInSession, 6);
  assert.equal(helps.sessionsGreen, 1);
  assert.equal(helps.roundsToGreenP50, 2);
  assert.equal(helps.suppressedFindings, 1);
  assert.deepEqual(s.agentUsedIt, { fileWrites: 2, writesAfter: { plan: 1, audit: 1 }, lookupsBeforeWrite: 3, hooksSeen: true });
  assert.deepEqual(s.catalogWeak, { zeroResultSearches: 1, tokenExceptions: 0, lowConfidenceMatches: 2 });
  assert.deepEqual(s.versions, { distribution: { '0.4.0': 11 }, fallbacks: 1 });
  assert.equal((s.budget as { fullRate: number }).fullRate, 0.5);
  assert.equal((new MetricsStore(mkdtempSync(join(tmpdir(), 'tenet-empty-'))).summary().used as { calls: number }).calls, 0);
});
