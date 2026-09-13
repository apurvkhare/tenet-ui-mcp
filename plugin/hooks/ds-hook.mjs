#!/usr/bin/env node
// Layer two of DESIGN.md §7: what the host sees and the server cannot. Three sub-commands, each
// reading the hook payload from stdin:
//   post-tool        after a call to one of the server's tools: records the tool, its trace id and outcome
//   file-written     after Write/Edit: records that a file changed and what it followed (plan / audit / checks / catalog)
//   session-outcome  at Stop: rounds of run_checks to green, writes after a plan, lookups before a write, suppressions
// Events carry names, ids, counts and booleans only — never arguments, file contents or findings text.
// They are spooled to $TENET_UI_HOOK_DIR (default ~/.tenet-ui/hooks) and, when DS_SERVER_URL and
// DS_SERVER_TOKEN are set, posted to <DS_SERVER_URL>/events with the same bearer token.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';

const cmd = process.argv[2];
const dir = process.env.TENET_UI_HOOK_DIR || join(homedir(), '.tenet-ui', 'hooks');
const serverUrl = process.env.DS_SERVER_URL;
const token = process.env.DS_SERVER_TOKEN;
const TOOLS = new Set(['search_components', 'get_component', 'find_tokens', 'search_icons', 'resolve_value', 'ingest_design', 'match_components', 'resolve_tokens', 'plan_component', 'audit_code', 'audit_page', 'plan_tests', 'run_checks']);
const LOOKUPS = new Set(['search_components', 'get_component', 'find_tokens', 'search_icons', 'resolve_value']);

let input = {};
try { input = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no payload: nothing to record */ }
const sessionId = String(input.session_id || 'unknown').slice(0, 80);
mkdirSync(dir, { recursive: true });
const stateFile = join(dir, `${sessionId}.json`);
const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { toolCalls: 0, rounds: 0, green: false, lastTool: null, lastTraceId: null, lastKind: 'none', lookupsSinceWrite: 0, lookupsBeforeWrite: 0, writesAfterPlan: 0, writesAfterAudit: 0, writes: 0, suppressed: 0, lastReport: null, events: [] };
const save = () => writeFileSync(stateFile, JSON.stringify(state));
const events = [];
const push = (e) => { const line = { ts: new Date().toISOString(), sessionId, host: 'claude-code', ...e }; events.push(line); appendFileSync(join(dir, 'events.jsonl'), JSON.stringify(line) + '\n'); };

const toolName = (raw) => { const m = String(raw || '').match(/^mcp__[^_].*__([a-z_]+)$/); return m ? m[1] : null; };
const traceIdOf = (resp) => {
  if (!resp || typeof resp !== 'object') return null;
  if (resp._meta && typeof resp._meta.traceId === 'string') return resp._meta.traceId;
  if (typeof resp.traceId === 'string') return resp.traceId;
  return null;
};
const structuredOf = (resp) => (resp && typeof resp === 'object' && resp.structuredContent && typeof resp.structuredContent === 'object' ? resp.structuredContent : resp && typeof resp === 'object' ? resp : {});

if (cmd === 'post-tool') {
  const tool = toolName(input.tool_name);
  if (tool && TOOLS.has(tool)) {
    const resp = input.tool_response;
    const out = structuredOf(resp);
    const traceId = traceIdOf(resp);
    state.toolCalls++;
    state.lastTool = tool;
    state.lastTraceId = traceId;
    if (LOOKUPS.has(tool)) state.lookupsSinceWrite++;
    if (tool === 'plan_component' || tool === 'plan_tests') state.lastKind = 'plan';
    else if (tool === 'audit_code' || tool === 'audit_page') { state.lastKind = 'audit'; state.lastReport = typeof out.auditId === 'string' ? out.auditId : state.lastReport; }
    else if (tool === 'run_checks') { state.lastKind = 'checks'; state.rounds++; state.green = out.status === 'pass'; state.lastReport = typeof out.reportId === 'string' ? out.reportId : state.lastReport; }
    else if (LOOKUPS.has(tool)) state.lastKind = 'catalog';
    push({ event: 'hook.tool', tool, traceId: traceId || undefined, outcome: typeof out.status === 'string' ? out.status : undefined, isError: Boolean(resp && resp.isError) });
  }
} else if (cmd === 'file-written') {
  const path = String((input.tool_input && (input.tool_input.file_path || input.tool_input.notebook_path)) || '');
  if (path) {
    state.writes++;
    if (state.lastKind === 'plan') state.writesAfterPlan++;
    if (state.lastKind === 'audit' || state.lastKind === 'checks') state.writesAfterAudit++;
    state.lookupsBeforeWrite += state.lookupsSinceWrite;
    const content = input.tool_input && typeof input.tool_input.content === 'string' ? input.tool_input.content : input.tool_input && typeof input.tool_input.new_string === 'string' ? input.tool_input.new_string : '';
    if (/eslint-disable[^\n]*tenet-ui|impeccable-disable|tenet-ui-ignore/.test(content)) state.suppressed++;
    push({ event: 'hook.file', after: state.lastKind, ext: extname(path).slice(0, 12), fileHash: createHash('sha256').update(path).digest('hex').slice(0, 16), traceId: state.lastTraceId || undefined });
    state.lookupsSinceWrite = 0;
  }
} else if (cmd === 'session-outcome') {
  if (state.toolCalls || state.writes) {
    push({ event: 'hook.session', rounds: state.rounds, green: state.green, accepted: !input.stop_hook_active, suppressed: state.suppressed, writesAfterPlan: state.writesAfterPlan, writesAfterAudit: state.writesAfterAudit, lookupsBeforeWrite: state.lookupsBeforeWrite, toolCalls: state.toolCalls, traceId: state.lastTraceId || undefined });
  }
} else {
  process.stderr.write('usage: ds-hook.mjs post-tool | file-written | session-outcome (hook payload on stdin)\n');
  process.exit(2);
}
save();

if (events.length && serverUrl && token) {
  const url = new URL('/events', serverUrl).href;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(events), signal: AbortSignal.timeout(5000) });
    if (!res.ok) appendFileSync(join(dir, 'errors.log'), `${new Date().toISOString()} POST ${url} → ${res.status}\n`);
  } catch (err) {
    appendFileSync(join(dir, 'errors.log'), `${new Date().toISOString()} POST ${url} failed: ${err && err.message ? err.message : err}\n`);
  }
}
