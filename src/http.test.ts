import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mintToken, type AuthConfig } from './auth/tokens.js';
import { CatalogStore } from './catalog/store.js';
import { createHttpServer } from './http.js';
import { setTelemetrySink } from './telemetry.js';

const KEY = 'test-hmac-key-with-at-least-32-characters-0123456789';
let baseUrl = '';
let auth: AuthConfig;
let server: ReturnType<typeof createHttpServer>;
const events: Array<Record<string, unknown>> = [];

before(async () => {
  setTelemetrySink((e) => events.push(e));
  // Bind first, then build the auth config from the real port (aud must match the MCP URL).
  const store = new CatalogStore('snapshots');
  const probe = createHttpServer({ store, publicUrl: 'http://127.0.0.1:0', auth: { mode: 'none', issuer: 'http://127.0.0.1', audience: 'x' } });
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((r) => probe.close(() => r()));
  baseUrl = `http://127.0.0.1:${port}`;
  auth = { mode: 'hs256', issuer: baseUrl, audience: `${baseUrl}/mcp`, key: new TextEncoder().encode(KEY) };
  server = createHttpServer({ store, publicUrl: baseUrl, auth, clientCredentials: { clientId: 'ci', clientSecret: 'ci-secret', scopes: ['ds:read', 'checks:run'] } });
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
  assert.deepEqual(tools.map((t) => t.name), ['search_components', 'get_component', 'find_tokens', 'search_icons', 'resolve_value', 'ingest_design', 'match_components', 'resolve_tokens', 'plan_component']);
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
