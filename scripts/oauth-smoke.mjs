#!/usr/bin/env node
/**
 * Walks the OAuth 2.1 flow against the Worker the way a host does, then calls every tool and a few
 * resources and prints how long each took. Rehearsal without a host, and the timing check for the
 * free plan's CPU limit (compare with the CPU column of `npm run logs` or the Workers dashboard).
 *
 *   node scripts/oauth-smoke.mjs http://localhost:8789                     # guest: catalog tools only
 *   OWNER_PASSWORD=... node scripts/oauth-smoke.mjs <url> apurv            # owner: every tool
 *
 * The owner run feeds a real 1280 px story baseline through ingest_design (pixel colour
 * correction) and run_checks (SSIM), the two heaviest code paths.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const base = (process.argv[2] ?? 'http://localhost:8789').replace(/\/+$/, '');
const user = process.argv[3] ?? 'guest';
const mcpUrl = `${base}/mcp`;

// 1. Discovery from the 401 challenge, then authorization server metadata.
const r401 = await fetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
const prmUrl = /resource_metadata="([^"]+)"/.exec(r401.headers.get('www-authenticate') ?? '')?.[1] ?? `${base}/.well-known/oauth-protected-resource/mcp`;
const prm = await (await fetch(prmUrl)).json();
const issuer = prm.authorization_servers[0].replace(/\/+$/, '');
const as = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
console.log(`401 challenge ok (${r401.status}); resource ${prm.resource}; scopes ${prm.scopes_supported.join(' ')}`);

// 2. Dynamic Client Registration, PKCE authorization as `user`, token exchange.
const redirectUri = 'http://localhost:6274/oauth/callback';
const reg = await (await fetch(as.registration_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'oauth-smoke', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }),
})).json();
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(8).toString('hex');
const authUrl = new URL(as.authorization_endpoint);
for (const [k, v] of Object.entries({ response_type: 'code', client_id: reg.client_id, redirect_uri: redirectUri, scope: prm.scopes_supported.join(' '), state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: prm.resource })) authUrl.searchParams.set(k, v);
const form = new URLSearchParams({ user });
if (process.env.OWNER_PASSWORD) form.set('password', process.env.OWNER_PASSWORD); // from the environment, never argv
const consent = await fetch(authUrl, { method: 'POST', body: form, redirect: 'manual' });
const location = consent.headers.get('location');
if (consent.status !== 302 || !location) { console.error(`sign-in refused (${consent.status})${user === 'guest' ? '' : '; set OWNER_PASSWORD'}`); process.exit(1); }
const cb = new URL(location);
if (cb.searchParams.get('state') !== state) throw new Error('state mismatch');
const tok = await (await fetch(as.token_endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code: cb.searchParams.get('code'), redirect_uri: redirectUri, client_id: reg.client_id, code_verifier: verifier, resource: prm.resource }),
})).json();
if (!tok.access_token) throw new Error(`token exchange failed: ${JSON.stringify(tok)}`);
console.log(`signed in as ${user}; granted ${tok.scope}`);

// 3. Every tool and a few resources, timed.
const client = new Client({ name: 'oauth-smoke', version: '0.1.0' });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), { requestInit: { headers: { authorization: `Bearer ${tok.access_token}` } } }));
const rows = [];
const notes = [];
async function time(label, fn) {
  const t0 = performance.now();
  try {
    const r = await fn();
    const err = r?.isError ? String(r.content?.[0]?.text ?? 'error').slice(0, 90) : '';
    rows.push([label, Math.round(performance.now() - t0), err ? `tool error: ${err}` : 'ok']);
    return r;
  } catch (e) {
    rows.push([label, Math.round(performance.now() - t0), `failed: ${String(e.message ?? e).slice(0, 90)}`]);
    return undefined;
  }
}
const call = (name, args) => time(name, () => client.callTool({ name, arguments: args }));
const read = (uri) => time(`read ${uri}`, () => client.readResource({ uri }));

const latest = (await (await fetch(`${base}/healthz`)).json()).latest;
const tools = await time('tools/list', () => client.listTools());
await call('search_components', { query: 'dropdown', dsVersion: 'latest', limit: 5 });
await call('get_component', { name: 'button', dsVersion: 'latest' });
await call('find_tokens', { query: 'focus', dsVersion: 'latest' });
await call('search_icons', { query: 'search', dsVersion: 'latest' });
await call('resolve_value', { values: [{ raw: '#a23e1f', role: 'foreground' }, { raw: '14px' }], dsVersion: 'latest' });
await read(`ds://${latest}/guidelines/color`);
await read(`ds://${latest}/guidelines/contract`);
const baselineList = await read(`ds://${latest}/baselines`);
const firstPng = baselineList ? JSON.parse(baselineList.contents[0].text).entries[0]?.uri : undefined;
if (firstPng) await read(firstPng);

const canDesign = (tok.scope ?? '').split(' ').includes('design:ingest');
if (!canDesign) {
  await call('ingest_design', { source: { type: 'layout', layout: { viewport: { width: 10, height: 10 }, theme: 'light', regions: [] } }, dsVersion: 'latest' });
  rows.at(-1)[2] += rows.at(-1)[2] === 'ok' ? '' : ' (expected: guest has ds:read only)';
} else {
  const schema = await read(`ds://${latest}/layout-schema`);
  const example = JSON.parse(schema.contents[0].text).example;
  const png = readFileSync(new URL('../snapshots/0.5.0/baselines/components-card--default.light.png', import.meta.url));
  const ing = await call('ingest_design', { source: { type: 'layout', layout: example.layout ?? example, image: { data: png.toString('base64'), mediaType: 'image/png' } }, dsVersion: 'latest' });
  const designId = ing?.structuredContent?.designId;
  const corrections = ing?.structuredContent?.colorCorrections;
  notes.push(`ingest_design: ${String(ing?.content?.[0]?.text ?? '').slice(0, 160)}`);
  const m = designId ? await call('match_components', { designId }) : undefined;
  const matchId = m?.structuredContent?.matchId;
  if (matchId) {
    await call('resolve_tokens', { matchId, theme: 'light' });
    await call('plan_component', { matchId, name: 'Smoke' });
    await call('plan_tests', { matchId, runner: 'vitest', dsVersion: 'latest' });
    await read(`design://${designId}/plan.md`);
  }
  const files = [{ path: 'src/Smoke.tsx', content: "import { Button } from 'tenet-ui';\nexport const Smoke = () => <div style={{ color: '#a23e1f', padding: 13 }}><Button block>Go</Button></div>;\n" }];
  await call('audit_code', { files, dsVersion: 'latest' });
  const results = { schemaVersion: 1, checks: { visual: { status: 'captured', screenshots: [{ story: 'Default', theme: 'light', status: 'captured', data: png.toString('base64') }] } } };
  const rc = await call('run_checks', { files, results, dsVersion: 'latest', designId });
  notes.push(`run_checks visual: ${JSON.stringify(rc?.structuredContent?.visual?.screenshots?.map((x) => ({ ssim: x.ssim, comparedAt: x.comparedAt })) ?? rc?.structuredContent?.visual ?? 'none')}`);
}
await client.close();

console.log(`\n${tools?.tools?.length ?? '?'} tools listed. Wall time per call (network included):\n`);
for (const [label, ms, outcome] of rows) console.log(`  ${label.padEnd(58)} ${String(ms).padStart(6)} ms  ${outcome}`);
for (const n of notes) console.log(`\n${n}`);
