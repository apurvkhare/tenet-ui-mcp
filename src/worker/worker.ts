/**
 * Remote entry on Cloudflare Workers, the same shape as the expensify MCP server:
 *
 *   OAuthProvider  owns /authorize, /token, /register, both .well-known documents,
 *                  and the bearer check on /mcp and /events. It hands us ctx.props.
 *   createMcpHandler(factory) serves /mcp: the factory runs once per request.
 *
 * Same createMcpServer as the Node entries (src/main.ts, src/stdio.ts). What differs is where state
 * lives: snapshots are bundled (src/worker/catalog.ts) and the design store is Workers KV.
 * /dashboard and /metrics.json stay on the Node server; hook events here go to Workers Logs.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { createMcpHandler, hostHeaderValidationResponse, originValidationResponse, TRACEPARENT_META_KEY, type AuthInfo } from '@modelcontextprotocol/server';
import { HookEventSchema } from '../metrics.js';
import { createMcpServer, requiredScopes } from '../server.js';
import { emit, principalHash, setTelemetrySink, traceFromHeader } from '../telemetry.js';
import { SCOPES_SUPPORTED, USERS, defaultHandler, type AuthProps, type Env } from './auth-ui.js';
import { getStore } from './catalog.js';
import { KvDesignStore } from './kv-design-store.js';

// One JSON line per event: the Cloudflare dashboard indexes JSON fields (filter by tool, status).
setTelemetrySink((e) => console.log(JSON.stringify(e)));

const MAX_BODY = 6 * 1024 * 1024; // ingest_design images are ≤ 5 MB base64

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

/** Protected routes. The provider has already verified the token; we map its props to a principal. */
const api: ExportedHandler<Env> & Required<Pick<ExportedHandler<Env>, 'fetch'>> = {
  async fetch(request, env, ctx) {
    const t0 = performance.now();
    const url = new URL(request.url);
    const allowedHost = new URL(env.PUBLIC_URL).hostname;
    const rejected = hostHeaderValidationResponse(request, [allowedHost, 'localhost', '127.0.0.1']) ?? originValidationResponse(request, [allowedHost, 'localhost', '127.0.0.1']);
    if (rejected) return rejected;

    let trace = traceFromHeader(request.headers.get('traceparent') ?? undefined);
    const props = (ctx as ExecutionContext<AuthProps>).props;
    // A token is only as good as the user behind it: removing someone from USERS cuts off their tokens.
    if (!props?.sub || !USERS[props.sub]) {
      emit({ event: 'auth', traceId: trace.traceId, status: 401, code: 'unknown_user' });
      return json(401, { error: 'invalid_token', error_description: 'This user no longer has access.' }, { 'www-authenticate': 'Bearer error="invalid_token"' });
    }
    const principal = { sub: props.sub, scopes: props.scopes, clientId: props.sub };

    if (url.pathname === '/events') return hookEvents(request, principal.sub, trace.traceId);

    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed', detail: 'stateless server: POST JSON-RPC to /mcp' }, { allow: 'POST' });
    const length = Number(request.headers.get('content-length') ?? 0);
    if (length > MAX_BODY) return json(413, { error: 'payload_too_large', max: MAX_BODY });
    const body = await request.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return json(400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null });
    }

    // SEP-414: a traceparent in the request's _meta names the trace; the HTTP header is the fallback.
    const metaTrace = (parsed as { params?: { _meta?: Record<string, unknown> } } | null)?.params?._meta?.[TRACEPARENT_META_KEY];
    if (typeof metaTrace === 'string' && /^00-[0-9a-f]{32}-/i.test(metaTrace)) trace = traceFromHeader(metaTrace);

    // Scope check per tool, before dispatch: one 403 with every missing scope (DESIGN.md §9).
    const missing = requiredScopes(parsed).filter((s) => !principal.scopes.includes(s));
    if (missing.length) {
      emit({ event: 'auth', traceId: trace.traceId, status: 403, code: 'insufficient_scope', principal: principalHash(principal.sub) });
      const prm = `${env.PUBLIC_URL.replace(/\/+$/, '')}/.well-known/oauth-protected-resource/mcp`;
      return json(403, { error: 'insufficient_scope', scope: missing.join(' ') }, { 'www-authenticate': `Bearer error="insufficient_scope", scope="${missing.join(' ')}", resource_metadata="${prm}"` });
    }

    const authInfo: AuthInfo = { token: '', clientId: principal.clientId, scopes: principal.scopes, extra: { sub: principal.sub } };
    const handler = createMcpHandler(
      () => createMcpServer(getStore(env), { principal, traceId: trace.traceId, publicUrl: env.PUBLIC_URL, designs: new KvDesignStore(env.DESIGNS) }),
      { maxRequestBodySize: MAX_BODY, onerror: (err) => emit({ event: 'request', traceId: trace.traceId, status: 'sdk_error', detail: err.message }) },
    );
    let status = 500;
    try {
      const forwarded = new Request(request.url, { method: 'POST', headers: request.headers, body });
      const response = await handler.fetch(forwarded, { authInfo, parsedBody: parsed });
      status = response.status;
      const headers = new Headers(response.headers);
      headers.set('traceparent', trace.traceparent);
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    } finally {
      emit({ event: 'request', traceId: trace.traceId, method: request.method, path: url.pathname, status, durationMs: Math.round(performance.now() - t0) });
      ctx.waitUntil(handler.close());
    }
  },
};

/** The hooks plugin's events (DESIGN.md §7 layer two). On Workers they go to the logs, not a spool. */
async function hookEvents(request: Request, sub: string, traceId: string): Promise<Response> {
  if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' }, { allow: 'POST' });
  const text = await request.text();
  if (text.length > 256 * 1024) return json(413, { error: 'payload_too_large' });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (items.length > 200) return json(400, { error: 'too_many_events', max: 200 });
  let accepted = 0;
  const rejected: string[] = [];
  for (const it of items) {
    const r = HookEventSchema.safeParse(it);
    if (!r.success) {
      rejected.push(r.error.issues[0]?.message ?? 'invalid');
      continue;
    }
    console.log(JSON.stringify({ ...r.data, principal: principalHash(sub), traceId: r.data.traceId ?? traceId }));
    accepted++;
  }
  return json(202, { accepted, rejected: rejected.length, ...(rejected.length ? { reasons: rejected.slice(0, 3) } : {}) });
}

/** The provider needs the public URL for its metadata, and env is only known per request, so build it lazily. */
let provider: OAuthProvider<Env> | undefined;
let providerFor: string | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  if (provider && providerFor === env.PUBLIC_URL) return provider;
  const origin = env.PUBLIC_URL.replace(/\/+$/, '');
  providerFor = env.PUBLIC_URL;
  provider = new OAuthProvider<Env>({
    apiRoute: ['/mcp', '/events'],
    apiHandler: api,
    defaultHandler,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    // 2026-07-28 prefers Client ID Metadata Documents; DCR stays on for older hosts.
    clientIdMetadataDocumentEnabled: true,
    clientRegistrationEndpoint: '/register',
    scopesSupported: SCOPES_SUPPORTED,
    // The provider insists on an https issuer. Deployed, state the metadata; on http://localhost
    // (wrangler dev) let it derive resource and issuer from the request.
    resourceMetadata: origin.startsWith('https://')
      ? { resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: SCOPES_SUPPORTED, resource_name: 'tenet-ui design system' }
      : { scopes_supported: SCOPES_SUPPORTED, resource_name: 'tenet-ui design system' },
    accessTokenTTL: 60 * 60,
  });
  return provider;
}

export default {
  fetch(request, env, ctx) {
    return getProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
