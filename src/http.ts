// Streamable HTTP endpoint (DESIGN.md §2 transport, §8, §9): POST /mcp, MCP 2026-07-28, stateless,
// JSON responses (SSE only if a handler emits a notification before its result). Validates Origin,
// the bearer token and the tool's scope before the SDK sees the request, then hands it to the SDK's
// createMcpHandler, which builds one McpServer per request, answers server/discover, checks the
// standard and Mcp-Param-* headers, and falls back to stateless 2025-era serving for clients that
// still open with initialize. Serves Protected Resource Metadata and the built-in issuer's metadata.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createMcpHandler, getOAuthProtectedResourceMetadataUrl, TRACEPARENT_META_KEY, type AuthInfo } from '@modelcontextprotocol/server';
import { AuthError, SCOPES, authConfigFromEnv, mintToken, requireScopes, verifyBearer, type AuthConfig, type Principal } from './auth/tokens.js';
import type { CatalogStore } from './catalog/store.js';
import { createMcpServer, requiredScopes, SERVER_INFO } from './server.js';
import type { DesignRows } from './store/design-store.js';
import type { VisionFn } from './design/vision.js';
import { emit, principalHash, traceFromHeader } from './telemetry.js';
import { DASHBOARD_HTML, HookEventSchema, type MetricsStore } from './metrics.js';

export interface HttpOptions {
  store: CatalogStore;
  publicUrl: string;
  auth?: AuthConfig;
  allowedOrigins?: string[];
  /** Optional client-credentials client for CI (DESIGN.md §9 "Machine" row, self-hosted flavour). */
  clientCredentials?: { clientId: string; clientSecret: string; scopes: string[] };
  maxBodyBytes?: number;
  designs?: DesignRows;
  vision?: VisionFn;
  /** Event spool behind /events, /metrics.json and /dashboard (DESIGN.md §7). */
  metrics?: MetricsStore;
}

const MAX_BODY = 6 * 1024 * 1024; // ingest_design images are ≤ 5 MB base64

export function createHttpServer(opts: HttpOptions): Server {
  const auth = opts.auth ?? authConfigFromEnv(opts.publicUrl);
  const origin = new URL(opts.publicUrl).origin;
  const mcpUrl = new URL('/mcp', opts.publicUrl).href;
  const prmUrl = `${origin}/.well-known/oauth-protected-resource`;
  const prmPathAware = new URL(getOAuthProtectedResourceMetadataUrl(new URL(mcpUrl))).pathname;
  const allowedOrigins = new Set(opts.allowedOrigins ?? []);

  // One handler for the process; the factory runs per request with the principal we verified.
  const handler = createMcpHandler((ctx) => createMcpServer(opts.store, {
    principal: principalFrom(ctx.authInfo),
    traceId: traceFromHeader(ctx.requestInfo?.headers.get('traceparent') ?? undefined).traceId,
    publicUrl: opts.publicUrl,
    designs: opts.designs,
    vision: opts.vision,
  }), {
    maxRequestBodySize: opts.maxBodyBytes ?? MAX_BODY,
    onerror: (err) => emit({ event: 'request', traceId: '-', status: 'sdk_error', detail: err.message }),
  });

  const server = createServer(async (req, res) => {
    const t0 = performance.now();
    let trace = traceFromHeader(header(req, 'traceparent'));
    res.setHeader('traceparent', trace.traceparent);
    const url = new URL(req.url ?? '/', origin);
    let status = 200;
    try {
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, server: SERVER_INFO.name, version: SERVER_INFO.version, latest: opts.store.latest(), versions: opts.store.versions() });
      // RFC 9728: the root document (what the 401 challenge names) and the path-aware form for /mcp.
      if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === prmPathAware) return sendJson(res, 200, prm(mcpUrl, auth));
      if (url.pathname === '/.well-known/oauth-authorization-server') return sendJson(res, 200, asMetadata(origin, auth));
      if (url.pathname === '/oauth/token' && req.method === 'POST') return await tokenEndpoint(req, res, auth, opts);
      if (url.pathname === '/events' || url.pathname === '/metrics.json' || url.pathname === '/dashboard') { status = await observability(req, res, url, auth, opts, trace.traceId); return; }
      if (url.pathname !== '/mcp') { status = 404; return sendJson(res, 404, { error: 'not_found' }); }

      // Origin: browsers send it; a value not on the allowlist is a DNS-rebinding or CSRF attempt.
      const reqOrigin = header(req, 'origin');
      if (reqOrigin && reqOrigin !== origin && !allowedOrigins.has(reqOrigin)) { status = 403; return sendJson(res, 403, { error: 'forbidden_origin' }); }

      if (req.method !== 'POST') { status = 405; res.setHeader('allow', 'POST'); return sendJson(res, 405, { error: 'method_not_allowed', detail: 'stateless server: POST JSON-RPC to /mcp' }); }

      let principal: Principal;
      try {
        principal = await verifyBearer(auth, header(req, 'authorization'));
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        status = err.status;
        emit({ event: 'auth', traceId: trace.traceId, status: err.status, code: err.code });
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${prmUrl}", error="${err.code === 'unauthorized' ? 'invalid_request' : err.code}", error_description="${err.message}", scope="ds:read"`);
        return sendJson(res, err.status, { error: err.code, error_description: err.message });
      }

      const body = await readBody(req, opts.maxBodyBytes ?? MAX_BODY);
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { status = 400; return sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'parse error' }, id: null }); }

      // SEP-414: a traceparent in the request's _meta names the trace; the HTTP header is the fallback.
      const metaTrace = (parsed as { params?: { _meta?: Record<string, unknown> } } | null)?.params?._meta?.[TRACEPARENT_META_KEY];
      if (typeof metaTrace === 'string' && /^00-[0-9a-f]{32}-/i.test(metaTrace)) { trace = traceFromHeader(metaTrace); res.setHeader('traceparent', trace.traceparent); }

      // Scope check per tool, before dispatch: one 403 with every missing scope (DESIGN.md §9).
      try {
        requireScopes(principal, requiredScopes(parsed));
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        status = 403;
        emit({ event: 'auth', traceId: trace.traceId, status: 403, code: err.code, principal: principalHash(principal.sub) });
        res.setHeader('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${err.missingScopes.join(' ')}", resource_metadata="${prmUrl}"`);
        return sendJson(res, 403, { error: 'insufficient_scope', scope: err.missingScopes.join(' ') });
      }

      const authInfo: AuthInfo = { token: '', clientId: principal.clientId, scopes: principal.scopes, expiresAt: principal.expiresAt, extra: { sub: principal.sub } };
      const response = await handler.fetch(toWebRequest(req, url, body, trace.traceparent), { authInfo, parsedBody: parsed });
      status = response.status;
      await sendWeb(res, response);
    } catch (err) {
      status = 500;
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', detail: err instanceof Error ? err.message : String(err) });
      else res.end();
    } finally {
      emit({ event: 'request', traceId: trace.traceId, method: req.method, path: url.pathname, status, durationMs: Math.round(performance.now() - t0) });
    }
  });
  server.on('close', () => { void handler.close(); });
  return server;
}

/** The principal http.ts verified, carried through the SDK as AuthInfo. */
function principalFrom(authInfo: AuthInfo | undefined): Principal {
  if (!authInfo) throw new Error('no AuthInfo: the HTTP layer verifies every request before the SDK sees it');
  const sub = (authInfo.extra as { sub?: string } | undefined)?.sub ?? authInfo.clientId;
  return { sub, clientId: authInfo.clientId, scopes: authInfo.scopes, expiresAt: authInfo.expiresAt };
}

// ---- Node request/response ↔ web Request/Response ------------------------------------------------
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade']);
function toWebRequest(req: IncomingMessage, url: URL, body: string, traceparent: string): Request {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined && !HOP_BY_HOP.has(k)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  headers.set('traceparent', traceparent);
  return new Request(url, { method: req.method, headers, body });
}
async function sendWeb(res: ServerResponse, response: Response): Promise<void> {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  if (response.body) for await (const chunk of response.body) res.write(chunk);
  res.end();
}

// ---- observability: hook events in, metrics and the dashboard out (DESIGN.md §7) ----------------
async function observability(req: IncomingMessage, res: ServerResponse, url: URL, auth: AuthConfig, opts: HttpOptions, traceId: string): Promise<number> {
  if (!opts.metrics) { sendJson(res, 404, { error: 'not_found', detail: 'metrics are not enabled (DATA_DIR)' }); return 404; }
  let principal: Principal;
  try {
    principal = await verifyBearer(auth, header(req, 'authorization') ?? (url.searchParams.get('token') ? `Bearer ${url.searchParams.get('token')}` : undefined));
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
    res.setHeader('WWW-Authenticate', `Bearer error="${err.code === 'unauthorized' ? 'invalid_request' : err.code}"`);
    sendJson(res, err.status, { error: err.code, error_description: err.message });
    return err.status;
  }
  if (url.pathname === '/events') {
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); sendJson(res, 405, { error: 'method_not_allowed' }); return 405; }
    const body = await readBody(req, 256 * 1024);
    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { sendJson(res, 400, { error: 'invalid_json' }); return 400; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    if (items.length > 200) { sendJson(res, 400, { error: 'too_many_events', max: 200 }); return 400; }
    let accepted = 0;
    const rejected: string[] = [];
    for (const it of items) {
      const r = HookEventSchema.safeParse(it);
      if (!r.success) { rejected.push(r.error.issues[0]?.message ?? 'invalid'); continue; }
      opts.metrics.record({ ...r.data, principal: principalHash(principal.sub), traceId: r.data.traceId ?? traceId });
      accepted++;
    }
    sendJson(res, 202, { accepted, rejected: rejected.length, ...(rejected.length ? { reasons: rejected.slice(0, 3) } : {}) });
    return 202;
  }
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? 7) || 7));
  if (url.pathname === '/metrics.json') { sendJson(res, 200, opts.metrics.summary(days)); return 200; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(DASHBOARD_HTML);
  return 200;
}

// ---- discovery documents -----------------------------------------------------------------------
function prm(mcpUrl: string, auth: AuthConfig): unknown {
  return {
    resource: mcpUrl,
    authorization_servers: auth.mode === 'none' ? [] : [auth.issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: SERVER_INFO.title,
    ...(auth.mode === 'none' ? { 'x-auth-mode': 'none' } : {}),
  };
}
function asMetadata(origin: string, auth: AuthConfig): unknown {
  return {
    issuer: origin,
    token_endpoint: `${origin}/oauth/token`,
    grant_types_supported: ['client_credentials'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: [...SCOPES],
    response_types_supported: [],
    'x-issuer': auth.mode === 'hs256' ? 'built-in HS256' : 'none',
  };
}

/** Client-credentials for CI against the built-in issuer. Interactive OAuth is the production path (external AS). */
async function tokenEndpoint(req: IncomingMessage, res: ServerResponse, auth: AuthConfig, opts: HttpOptions): Promise<void> {
  if (auth.mode !== 'hs256' || !opts.clientCredentials) return sendJson(res, 501, { error: 'unsupported_grant_type', error_description: 'no client-credentials client configured (AUTH_CLIENT_ID / AUTH_CLIENT_SECRET)' });
  const body = await readBody(req, 64 * 1024);
  const params = new URLSearchParams(body);
  let clientId = params.get('client_id');
  let clientSecret = params.get('client_secret');
  const basic = header(req, 'authorization')?.match(/^Basic\s+(.+)$/i);
  if (basic) { const [id, secret] = Buffer.from(basic[1]!, 'base64').toString('utf8').split(':', 2); clientId = id ?? null; clientSecret = secret ?? null; }
  if (params.get('grant_type') !== 'client_credentials') return sendJson(res, 400, { error: 'unsupported_grant_type' });
  if (clientId !== opts.clientCredentials.clientId || clientSecret !== opts.clientCredentials.clientSecret) return sendJson(res, 401, { error: 'invalid_client' });
  const requested = (params.get('scope') ?? opts.clientCredentials.scopes.join(' ')).split(/\s+/).filter(Boolean);
  const denied = requested.filter((s) => !opts.clientCredentials!.scopes.includes(s));
  if (denied.length) return sendJson(res, 400, { error: 'invalid_scope', error_description: `not allowed: ${denied.join(' ')}` });
  const ttl = 3600;
  const token = await mintToken(auth, { sub: `client:${clientId}`, clientId: clientId!, scopes: requested, ttlSeconds: ttl });
  return sendJson(res, 200, { access_token: token, token_type: 'Bearer', expires_in: ttl, scope: requested.join(' ') });
}

// ---- helpers -----------------------------------------------------------------------------------
const header = (req: IncomingMessage, name: string): string | undefined => { const v = req.headers[name.toLowerCase()]; return Array.isArray(v) ? v[0] : v; };
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
function readBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > max) { reject(new Error(`body exceeds ${max} bytes`)); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
