import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mintToken, type AuthConfig } from './auth/tokens.js';
import { CatalogStore } from './catalog/store.js';
import { createHttpServer } from './http.js';
import { setTelemetrySink } from './telemetry.js';
import { MetricsStore } from './metrics.js';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const KEY = 'test-hmac-key-with-at-least-32-characters-0123456789';
let baseUrl = '';
let auth: AuthConfig;
let server: ReturnType<typeof createHttpServer>;
const events: Array<Record<string, unknown>> = [];
const metrics = new MetricsStore(mkdtempSync(join(tmpdir(), 'tenet-metrics-')));

before(async () => {
  setTelemetrySink((e) => { events.push(e); if (e.event === 'tool' || e.event === 'request') metrics.record(e); });
  // Bind first, then build the auth config from the real port (aud must match the MCP URL).
  const store = new CatalogStore('snapshots');
  const probe = createHttpServer({ store, publicUrl: 'http://127.0.0.1:0', auth: { mode: 'none', issuer: 'http://127.0.0.1', audience: 'x' } });
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  baseUrl = `http://127.0.0.1:${port}`;
  auth = { mode: 'hs256', issuer: baseUrl, audience: `${baseUrl}/mcp`, key: new TextEncoder().encode(KEY) };
  server = createHttpServer({ store, publicUrl: baseUrl, auth, clientCredentials: { clientId: 'ci', clientSecret: 'ci-secret', scopes: ['ds:read', 'checks:run'] }, metrics });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
});
after(async () => { await new Promise<void>((r) => server.close(() => r())); });

const txt = (r: { contents: unknown[] }): string => (r.contents[0] as { text?: string } | undefined)?.text ?? '';
const connect = async (token?: string): Promise<Client> => {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {});
  await client.connect(transport);
  return client;
};

test('discovery: healthz, protected resource metadata, AS metadata', async () => {
  const health = await (await fetch(`${baseUrl}/healthz`)).json() as { ok: boolean; latest: string };
  assert.equal(health.ok, true);
  assert.equal(health.latest, '0.4.0');
  const prm = await (await fetch(`${baseUrl}/.well-known/oauth-protected-resource`)).json() as { resource: string; authorization_servers: string[]; scopes_supported: string[] };
  assert.equal(prm.resource, `${baseUrl}/mcp`);
  assert.deepEqual(prm.authorization_servers, [baseUrl]);
  assert.ok(prm.scopes_supported.includes('ds:read'));
  const as = await (await fetch(`${baseUrl}/.well-known/oauth-authorization-server`)).json() as { token_endpoint: string };
  assert.equal(as.token_endpoint, `${baseUrl}/oauth/token`);
});

test('no token → 401 with resource_metadata challenge; bad token → 401 invalid_token', async () => {
  const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /resource_metadata="http:\/\/127\.0\.0\.1:\d+\/\.well-known\/oauth-protected-resource"/);
  const bad = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer nope' }, body: '{}' });
  assert.equal(bad.status, 401);
  assert.match(bad.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
});

test('wrong scope → one 403 naming the missing scope', async () => {
  const token = await mintToken(auth, { sub: 'ci', scopes: ['checks:run'] });
  const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_components', arguments: { query: 'button' } } }) });
  assert.equal(res.status, 403);
  assert.match(res.headers.get('www-authenticate') ?? '', /insufficient_scope.*scope="ds:read"/);
});

test('tools/list is deterministic, small, with annotations and the DsVersion header hint', async () => {
  const client = await connect(await mintToken(auth, { sub: 'apurv', scopes: ['ds:read'] }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), ['search_components', 'get_component', 'find_tokens', 'search_icons', 'resolve_value', 'ingest_design', 'match_components', 'resolve_tokens', 'plan_component', 'audit_code', 'audit_page', 'plan_tests', 'run_checks']);
  const size = Buffer.byteLength(JSON.stringify(tools));
  assert.ok(size < tools.length * 2048, `tools/list is ${size} bytes for ${tools.length} tools`);
  for (const t of tools) {
    assert.ok((t.description ?? '').length < 300);
    assert.equal(t.annotations?.readOnlyHint, true);
    assert.ok(t.outputSchema, `${t.name} has no outputSchema`);
  }
  const get = tools.find((t) => t.name === 'get_component')!;
  const dsVersion = (get.inputSchema.properties as Record<string, Record<string, unknown>>).dsVersion!;
  assert.equal(dsVersion['x-mcp-header'], 'DsVersion');
  assert.equal(dsVersion.default, 'latest');
  await client.close();
});

test('tools/call returns structuredContent, text, resource links and _meta.traceId', async () => {
  const client = await connect(await mintToken(auth, { sub: 'apurv', scopes: ['ds:read'] }));
  const r = await client.callTool({ name: 'get_component', arguments: { name: 'Button', dsVersion: '0.3.0', sections: ['api'] } });
  assert.notEqual(r.isError, true);
  const sc = r.structuredContent as { found: boolean; dsVersion: string; api: { props: Array<{ name: string }> } };
  assert.equal(sc.found, true);
  assert.equal(sc.dsVersion, '0.3.0');
  assert.ok(sc.api.props.some((p) => p.name === 'block'));
  assert.ok(!sc.api.props.some((p) => p.name === 'fullWidth'), '0.3.0 must not know fullWidth');
  const content = r.content as Array<{ type: string; uri?: string; text?: string }>;
  assert.equal(content[0]?.type, 'text');
  assert.ok(content.some((c) => c.type === 'resource_link' && c.uri === 'ds://0.3.0/components/button'));
  assert.ok((r._meta as { traceId?: string })?.traceId);
  const err = await client.callTool({ name: 'resolve_value', arguments: { values: [{ raw: '???' }] } });
  assert.notEqual(err.isError, true);
  const bad = await client.callTool({ name: 'get_component', arguments: { name: 'Button', dsVersion: '0.4.0' } }, undefined, { });
  assert.equal((bad.structuredContent as { dsVersion: string }).dsVersion, '0.4.0');
  await client.close();
});

test('resources: list, templates, read markdown / json, not-found is an error', async () => {
  const client = await connect(await mintToken(auth, { sub: 'apurv', scopes: ['ds:read'] }));
  const { resources } = await client.listResources();
  assert.ok(resources.some((r) => r.uri === 'ds://versions'));
  assert.ok(resources.some((r) => r.uri === 'ds://0.4.0/gaps'));
  const { resourceTemplates } = await client.listResourceTemplates();
  assert.ok(resourceTemplates.some((t) => t.uriTemplate === 'ds://{version}/components/{name}'));
  const md = await client.readResource({ uri: 'ds://0.4.0/components/tag' });
  assert.match(txt(md), /^# Tag/);
  assert.match(txt(md), /\| variant \|/);
  const tokens = await client.readResource({ uri: 'ds://latest/tokens/space.json' });
  const parsed = JSON.parse(txt(tokens)) as { group: string; count: number };
  assert.equal(parsed.group, 'space');
  const contract = await client.readResource({ uri: 'ds://0.4.0/guidelines/contract' });
  assert.match(txt(contract), /component contract/i);
  const color = await client.readResource({ uri: 'ds://0.4.0/guidelines/color' });
  assert.match(txt(color), /title: Color/);
  const gaps = await client.readResource({ uri: 'ds://0.3.0/gaps' });
  assert.ok(JSON.parse(txt(gaps)).summary['no-guideline'] > 0);
  await assert.rejects(client.readResource({ uri: 'ds://0.4.0/components/nope' }), /no component/);
  await client.close();
});

test('client-credentials token endpoint mints a usable token; telemetry carries the trace id', async () => {
  const res = await fetch(`${baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_id=ci&client_secret=ci-secret&scope=ds:read' });
  assert.equal(res.status, 200);
  const { access_token } = await res.json() as { access_token: string };
  const client = await connect(access_token);
  const r = await client.callTool({ name: 'search_icons', arguments: { query: 'search' } });
  assert.match(String((r.content as Array<{ text?: string }>)[0]?.text), /SearchIcon/);
  await client.close();
  const denied = await fetch(`${baseUrl}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials&client_id=ci&client_secret=ci-secret&scope=design:ingest' });
  assert.equal(denied.status, 400);
  const toolEvents = events.filter((e) => e.event === 'tool');
  assert.ok(toolEvents.length > 0 && toolEvents.every((e) => typeof e.traceId === 'string' && e.traceId));
});

test('prompts: the three paths are listed and render with the effective version', async () => {
  const token = await mintToken(auth, { sub: 'apurv', clientId: 'cli', scopes: ['ds:read'], ttlSeconds: 60 });
  const client = await connect(token);
  const list = await client.listPrompts();
  assert.deepEqual(list.prompts.map((p) => p.name), ['design-to-code', 'audit-ui', 'test-ui']);
  const p = await client.getPrompt({ name: 'audit-ui', arguments: { dsVersion: '0.4.0', url: 'http://localhost:5173' } });
  const text = (p.messages[0]!.content as { text: string }).text;
  assert.match(text, /audit_code/);
  assert.match(text, /audit_page/);
  assert.match(text, /dsVersion "0\.4\.0"/);
  await client.close();
});

test('/events accepts hook events under a bearer token; /metrics.json and /dashboard read them back; the hook script posts them', async () => {
  const token = await mintToken(auth, { sub: 'apurv', clientId: 'cli', scopes: ['ds:read'], ttlSeconds: 60 });
  const unauth = await fetch(`${baseUrl}/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]' });
  assert.equal(unauth.status, 401);
  const bad = await fetch(`${baseUrl}/events`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify([{ event: 'hook.tool', sessionId: 's1', tool: 'run_checks', secret: 'x'.repeat(10) }, { event: 'nope', sessionId: 's1' }]) });
  assert.equal(bad.status, 202);
  const accepted = await bad.json() as { accepted: number; rejected: number };
  assert.deepEqual([accepted.accepted, accepted.rejected], [1, 1]);

  // A call through the MCP endpoint lands in the same spool.
  const client = await connect(await mintToken(auth, { sub: 'apurv', clientId: 'cli', scopes: ['ds:read'], ttlSeconds: 60 }));
  await client.callTool({ name: 'search_components', arguments: { query: 'zzzz', dsVersion: '0.4.0', limit: 3 } });
  await client.close();

  // The hook script: three sub-commands, spooled locally and posted to /events.
  const hookDir = mkdtempSync(join(tmpdir(), 'tenet-hooks-'));
  const env = { ...process.env, TENET_UI_HOOK_DIR: hookDir, DS_SERVER_URL: baseUrl, DS_SERVER_TOKEN: token };
  // Async spawn: the server under test lives in this process, so the hook's POST must not block the loop.
  const run = (cmd: string, payload: unknown): Promise<void> => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['plugin/hooks/ds-hook.mjs', cmd], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error('ds-hook ' + cmd + ' exited ' + code + ': ' + stderr))));
    child.stdin.end(JSON.stringify(payload));
  });
  await run('post-tool', { session_id: 'sess-1', tool_name: 'mcp__tenet-ui__plan_component', tool_response: { _meta: { traceId: 'abc123' }, structuredContent: { planId: 'pln_x' } } });
  await run('post-tool', { session_id: 'sess-1', tool_name: 'Read', tool_response: {} });
  await run('file-written', { session_id: 'sess-1', tool_name: 'Write', tool_input: { file_path: '/tmp/x/ArticleCard.tsx', content: 'export const x = 1;' } });
  await run('post-tool', { session_id: 'sess-1', tool_name: 'mcp__ds__run_checks', tool_response: { structuredContent: { reportId: 'aud_y', status: 'fail' } } });
  await run('post-tool', { session_id: 'sess-1', tool_name: 'mcp__ds__run_checks', tool_response: { structuredContent: { reportId: 'aud_z', status: 'pass', delta: { fixed: 3 } } } });
  await run('session-outcome', { session_id: 'sess-1', stop_hook_active: false });
  const spool = readFileSync(join(hookDir, 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  assert.deepEqual(spool.map((e) => e.event), ['hook.tool', 'hook.file', 'hook.tool', 'hook.tool', 'hook.session']);
  assert.equal(spool[0]!.traceId, 'abc123');
  assert.equal(spool[1]!.after, 'plan');
  assert.ok(!('path' in spool[1]!) && typeof spool[1]!.fileHash === 'string', 'paths are hashed, never sent in clear');
  const outcome = spool[4]!;
  assert.equal(outcome.rounds, 2);
  assert.equal(outcome.green, true);
  assert.equal(outcome.writesAfterPlan, 1);
  assert.ok(!existsSync(join(hookDir, 'errors.log')), existsSync(join(hookDir, 'errors.log')) ? readFileSync(join(hookDir, 'errors.log'), 'utf8') : '');

  const m = await (await fetch(`${baseUrl}/metrics.json?token=${token}`)).json() as { used: { calls: number; sessions: number; perTool: Record<string, { calls: number }> }; helps: { sessionsGreen: number; roundsToGreenP50: number }; agentUsedIt: { writesAfter: Record<string, number>; hooksSeen: boolean }; catalogWeak: { zeroResultSearches: number } };
  assert.ok(m.used.perTool.search_components!.calls >= 1);
  assert.ok(m.used.sessions >= 1);
  assert.equal(m.agentUsedIt.hooksSeen, true);
  assert.equal(m.agentUsedIt.writesAfter.plan, 1);
  assert.equal(m.helps.sessionsGreen, 1);
  assert.equal(m.helps.roundsToGreenP50, 2);
  assert.ok(m.catalogWeak.zeroResultSearches >= 1);
  const dash = await fetch(`${baseUrl}/dashboard`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(dash.status, 200);
  assert.match(dash.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await dash.text(), /Is it used/);
});
