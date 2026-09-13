// The first dashboard (DESIGN.md §7): server events (layer one) and hook events from the host
// (layer two) land in one JSONL spool, joined by trace id and session id. The dashboard answers
// the §7 questions from names, counts, durations and outcomes; nothing else is ever stored.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Event } from './telemetry.js';

/** Hook events posted by the companion plugin (plugin/hooks/ds-hook.mjs). Names, ids, counts and booleans only. */
export const HookEventSchema = z.object({
  event: z.enum(['hook.tool', 'hook.file', 'hook.session']),
  sessionId: z.string().max(80),
  traceId: z.string().max(64).optional(),
  ts: z.string().max(40).optional(),
  tool: z.string().max(80).optional(),
  /** hook.file: what the write followed. */
  after: z.enum(['plan', 'audit', 'checks', 'catalog', 'none']).optional(),
  ext: z.string().max(12).optional(),
  fileHash: z.string().max(16).optional(),
  /** hook.session: outcome counters. */
  rounds: z.number().int().min(0).max(1000).optional(),
  green: z.boolean().optional(),
  accepted: z.boolean().optional(),
  suppressed: z.number().int().min(0).max(10000).optional(),
  writesAfterPlan: z.number().int().min(0).max(10000).optional(),
  writesAfterAudit: z.number().int().min(0).max(10000).optional(),
  lookupsBeforeWrite: z.number().int().min(0).max(10000).optional(),
  toolCalls: z.number().int().min(0).max(100000).optional(),
  host: z.string().max(40).optional(),
});
export type HookEvent = z.infer<typeof HookEventSchema>;

type Line = Record<string, unknown> & { ts: string; event: string };

export class MetricsStore {
  constructor(readonly dir: string) { mkdirSync(dir, { recursive: true }); }

  record(e: Event | (HookEvent & { sub?: string })): void {
    const line: Line = { ts: new Date().toISOString(), ...e } as Line;
    appendFileSync(join(this.dir, `${line.ts.slice(0, 10)}.jsonl`), JSON.stringify(line) + '\n');
  }

  /** Read the last `days` days of events (newest file last). */
  read(days = 7): Line[] {
    if (!existsSync(this.dir)) return [];
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    const out: Line[] = [];
    for (const f of readdirSync(this.dir).filter((n) => n.endsWith('.jsonl') && n.slice(0, 10) >= cutoff).sort()) {
      for (const l of readFileSync(join(this.dir, f), 'utf8').split('\n')) { if (!l) continue; try { out.push(JSON.parse(l) as Line); } catch { /* partial line */ } }
    }
    return out;
  }

  summary(days = 7): Record<string, unknown> {
    const lines = this.read(days);
    const tools = lines.filter((l) => l.event === 'tool');
    const requests = lines.filter((l) => l.event === 'request');
    const hooks = lines.filter((l) => typeof l.event === 'string' && l.event.startsWith('hook.'));
    const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');

    // Is it used / is it fast.
    const perTool: Record<string, { calls: number; errors: number; p50: number; p95: number; bytesP50: number; principals: number; byDay: Record<string, number> }> = {};
    const byTool = new Map<string, Line[]>();
    for (const t of tools) { const k = str(t.tool) || '?'; if (!byTool.has(k)) byTool.set(k, []); byTool.get(k)!.push(t); }
    for (const [k, ls] of byTool) {
      const d = ls.map((l) => num(l.durationMs)).sort((a, b) => a - b);
      const b = ls.map((l) => num(l.bytes)).filter(Boolean).sort((a, b2) => a - b2);
      const byDay: Record<string, number> = {};
      for (const l of ls) byDay[str(l.ts).slice(0, 10)] = (byDay[str(l.ts).slice(0, 10)] ?? 0) + 1;
      perTool[k] = { calls: ls.length, errors: ls.filter((l) => l.status === 'error').length, p50: pct(d, 0.5), p95: pct(d, 0.95), bytesP50: pct(b, 0.5), principals: new Set(ls.map((l) => str(l.sub))).size, byDay };
    }
    // Is it right.
    const mrtr = tools.filter((l) => typeof l.resultType === 'string');
    const askedRounds = mrtr.filter((l) => l.resultType === 'input_required').length;
    const answered = tools.filter((l) => l.tool === 'match_components' || l.tool === 'resolve_tokens').filter((l) => l.resultType === 'complete');
    const unresolved = answered.reduce((n, l) => n + num(l.unresolved), 0);
    const lowConfidence = tools.filter((l) => l.tool === 'match_components').reduce((n, l) => n + num(l.lowConfidence), 0);
    // Does it help.
    const checkRuns = tools.filter((l) => l.tool === 'run_checks' && l.status === 'ok');
    const firstRuns = checkRuns.filter((l) => l.round === 1);
    const firstRunPass = firstRuns.length ? firstRuns.filter((l) => l.outcome === 'pass').length / firstRuns.length : undefined;
    const firstRunByCheck: Record<string, { pass: number; fail: number; skipped: number }> = {};
    for (const l of firstRuns) for (const [k, s] of Object.entries((l.checks as Record<string, string> | undefined) ?? {})) { const c = (firstRunByCheck[k] ??= { pass: 0, fail: 0, skipped: 0 }); if (s === 'pass') c.pass++; else if (s === 'fail' || s === 'error') c.fail++; else c.skipped++; }
    const audits = tools.filter((l) => (l.tool === 'audit_code' || l.tool === 'audit_page') && l.status === 'ok');
    const findingsPerAudit = audits.length ? audits.reduce((n, l) => n + num(l.findings), 0) / audits.length : undefined;
    const fixedInSession = audits.filter((l) => l.round === 2).reduce((n, l) => n + num(l.fixed), 0);
    const sessions = hooks.filter((l) => l.event === 'hook.session');
    const roundsToGreen = sessions.filter((l) => l.green === true).map((l) => num(l.rounds)).sort((a, b) => a - b);
    // Did the agent use it (hooks).
    const fileWrites = hooks.filter((l) => l.event === 'hook.file');
    const after: Record<string, number> = {};
    for (const l of fileWrites) after[str(l.after) || 'none'] = (after[str(l.after) || 'none'] ?? 0) + 1;
    // Where the catalog is weak.
    const zeroResults = tools.filter((l) => l.zeroResults === true).length;
    const exceptions = tools.filter((l) => l.tool === 'resolve_tokens').reduce((n, l) => n + num(l.exceptions), 0);
    // Which versions matter.
    const versions: Record<string, number> = {};
    for (const l of tools) if (l.dsVersion) versions[str(l.dsVersion)] = (versions[str(l.dsVersion)] ?? 0) + 1;
    const fallbacks = tools.filter((l) => l.versionFallback === true).length;
    // Context budget.
    const fullRate = (() => { const g = tools.filter((l) => l.tool === 'get_component'); return g.length ? g.filter((l) => l.full === true).length / g.length : undefined; })();

    return {
      window: { days, from: lines[0]?.ts, to: lines.at(-1)?.ts, events: lines.length },
      used: { calls: tools.length, requests: requests.length, principals: new Set(tools.map((l) => str(l.sub))).size, sessions: new Set(hooks.map((l) => str(l.sessionId))).size, perTool },
      right: { elicitationRounds: askedRounds, completed: answered.length, unresolvedPicks: unresolved, lowConfidenceMatches: lowConfidence },
      helps: { runChecks: checkRuns.length, firstRunPassRate: firstRunPass, firstRunByCheck, audits: audits.length, findingsPerAudit, findingsFixedInSession: fixedInSession, sessionsGreen: sessions.filter((l) => l.green === true).length, sessionsTotal: sessions.length, roundsToGreenP50: pct(roundsToGreen, 0.5), accepted: sessions.filter((l) => l.accepted === true).length, suppressedFindings: sessions.reduce((n, l) => n + num(l.suppressed), 0) },
      agentUsedIt: { fileWrites: fileWrites.length, writesAfter: after, lookupsBeforeWrite: sessions.reduce((n, l) => n + num(l.lookupsBeforeWrite), 0), hooksSeen: hooks.length > 0 },
      catalogWeak: { zeroResultSearches: zeroResults, tokenExceptions: exceptions, lowConfidenceMatches: lowConfidence },
      versions: { distribution: versions, fallbacks },
      budget: { fullRate, bytesP50ByTool: Object.fromEntries(Object.entries(perTool).map(([k, v]) => [k, v.bytesP50])) },
    };
  }
}

/** Nearest-rank percentile over an ascending list. */
function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1))]!;
}

export const DASHBOARD_HTML = `<!doctype html><meta charset="utf-8"><title>tenet-ui-mcp · dashboard</title>
<style>
:root{color-scheme:light dark;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;--muted:#6e6049;--line:#d9d2c4;--accent:#c2502e}
@media(prefers-color-scheme:dark){:root{--muted:#b8ad99;--line:#3a352c}}
body{margin:0;padding:24px;max-width:1100px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;color:var(--accent)}
p.sub{color:var(--muted);margin:0 0 16px}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}
th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line)}th{color:var(--muted);font-weight:600}td.n,th.n{text-align:right}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card{border:1px solid var(--line);border-radius:6px;padding:10px 12px}
.card b{display:block;font-size:22px}.card span{color:var(--muted)}.note{color:var(--muted);font-size:12px}code{font-size:12px}
</style>
<h1>tenet-ui-mcp</h1><p class="sub" id="sub">loading…</p>
<h2>Is it used · is it fast</h2><div class="grid" id="used"></div><table id="tools"><thead><tr><th>tool</th><th class="n">calls</th><th class="n">errors</th><th class="n">principals</th><th class="n">p50 ms</th><th class="n">p95 ms</th><th class="n">bytes p50</th></tr></thead><tbody></tbody></table>
<h2>Is it right</h2><div class="grid" id="right"></div>
<h2>Does it help</h2><div class="grid" id="helps"></div><table id="checks"><thead><tr><th>check (first run)</th><th class="n">pass</th><th class="n">fail</th><th class="n">skipped</th></tr></thead><tbody></tbody></table>
<h2>Did the agent use it <span class="note">(host hooks)</span></h2><div class="grid" id="agent"></div>
<h2>Where the catalog is weak</h2><div class="grid" id="weak"></div>
<h2>Which versions matter</h2><div class="grid" id="versions"></div>
<h2>Is the context budget holding</h2><div class="grid" id="budget"></div>
<p class="note">Server events + hook events from <code>/events</code>, last 7 days. Never arguments, images, file contents or findings text.</p>
<script>
const fmt=(v)=>v===undefined||v===null?'—':typeof v==='number'?(Number.isInteger(v)?v:(v*100).toFixed(0)+'%'):String(v);
const cards=(id,obj)=>{document.getElementById(id).innerHTML=Object.entries(obj).map(([k,v])=>'<div class="card"><b>'+fmt(v)+'</b><span>'+k+'</span></div>').join('')};
fetch('metrics.json'+location.search).then(r=>r.json()).then(m=>{
 document.getElementById('sub').textContent=(m.window.events||0)+' events, '+(m.window.from?m.window.from.slice(0,10)+' → '+m.window.to.slice(0,10):'no data yet');
 cards('used',{calls:m.used.calls,requests:m.used.requests,principals:m.used.principals,sessions:m.used.sessions});
 document.querySelector('#tools tbody').innerHTML=Object.entries(m.used.perTool).sort((a,b)=>b[1].calls-a[1].calls).map(([k,v])=>'<tr><td>'+k+'</td><td class="n">'+v.calls+'</td><td class="n">'+v.errors+'</td><td class="n">'+v.principals+'</td><td class="n">'+v.p50+'</td><td class="n">'+v.p95+'</td><td class="n">'+v.bytesP50+'</td></tr>').join('');
 cards('right',{'elicitation rounds':m.right.elicitationRounds,'completed':m.right.completed,'unresolved picks':m.right.unresolvedPicks,'low-confidence matches':m.right.lowConfidenceMatches});
 cards('helps',{'run_checks calls':m.helps.runChecks,'first-run pass rate':m.helps.firstRunPassRate,'audits':m.helps.audits,'findings / audit':m.helps.findingsPerAudit==null?undefined:Math.round(m.helps.findingsPerAudit*10)/10,'fixed in session':m.helps.findingsFixedInSession,'sessions green':m.helps.sessionsGreen+' / '+m.helps.sessionsTotal,'rounds to green p50':m.helps.roundsToGreenP50,'suppressed':m.helps.suppressedFindings});
 document.querySelector('#checks tbody').innerHTML=Object.entries(m.helps.firstRunByCheck).map(([k,v])=>'<tr><td>'+k+'</td><td class="n">'+v.pass+'</td><td class="n">'+v.fail+'</td><td class="n">'+v.skipped+'</td></tr>').join('')||'<tr><td colspan=4 class="note">no first runs yet</td></tr>';
 cards('agent',{'file writes':m.agentUsedIt.fileWrites,'after a plan':m.agentUsedIt.writesAfter.plan||0,'after an audit':m.agentUsedIt.writesAfter.audit||0,'after checks':m.agentUsedIt.writesAfter.checks||0,'lookups before write':m.agentUsedIt.lookupsBeforeWrite,'hooks reporting':m.agentUsedIt.hooksSeen?'yes':'no'});
 cards('weak',{'zero-result searches':m.catalogWeak.zeroResultSearches,'token exceptions':m.catalogWeak.tokenExceptions,'low-confidence matches':m.catalogWeak.lowConfidenceMatches});
 cards('versions',Object.assign({},m.versions.distribution,{fallbacks:m.versions.fallbacks}));
 cards('budget',Object.assign({'full: true rate':m.budget.fullRate},Object.fromEntries(Object.entries(m.budget.bytesP50ByTool).map(([k,v])=>[k+' bytes p50',v]))));
});
</script>`;
