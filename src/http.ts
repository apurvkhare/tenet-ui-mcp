// Streamable HTTP endpoint (DESIGN.md §2 transport, §8, §9): POST /mcp, stateless, JSON responses
// for the fast tools. Validates Origin, the bearer token and the tool's scope before the SDK sees
// the request; serves Protected Resource Metadata and the built-in issuer's metadata.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AuthError, SCOPES, authConfigFromEnv, mintToken, requireScopes, verifyBearer, type AuthConfig, type Principal } from './auth/tokens.js';
import type { CatalogStore } from './catalog/store.js';
import { createMcpServer, SERVER_INFO, TOOL_SCOPES } from './server.js';
import type { DesignStore } from './store/design-store.js';
import type { VisionFn } from './design/vision.js';
import { emit, traceFromHeader } from './telemetry.js';
import { DASHBOARD_HTML, HookEventSchema, type MetricsStore } from './metrics.js';

export interface HttpOptions {
  store: CatalogStore;
  publicUrl: string;
  auth?: AuthConfig;
  allowedOrigins?: string[];
  /** Optional client-credentials client for CI (DESIGN.md §9 "Machine" row, self-hosted flavour). */
  clientCredentials?: { clientId: string; clientSecret: string; scopes: string[] };
  maxBodyBytes?: number;
  designs?: DesignStore;
  sealKey?: Buffer;
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
  const allowedOrigins = new Set(opts.allowedOrigins ?? []);

  return createServer(async (req, res) => {
    const t0 = performance.now();
    const trace = traceFromHeader(header(req, 'traceparent'));
    res.setHeader('traceparent', trace.traceparent);
    const url = new URL(req.url ?? '/', origin);
    let status = 200;
    try {
      if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, server: SERVER_INFO.name, version: SERVER_INFO.version, latest: opts.store.latest(), versions: opts.store.versions() });
      if (url.pathname === '/.well-known/oauth-protected-resource') return sendJson(res, 200, prm(mcpUrl, auth));
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

      // Scope check per tool, before dispatch: one 403 with every missing scope (DESIGN.md §9).
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      const required = new Set<string>();
      for (const m of messages as Array<{ method?: string; params?: { name?: string } }>) {
        if (m?.method === 'tools/call' && m.params?.name) required.add(TOOL_SCOPES[m.params.name] ?? 'ds:read');
        else if (m?.method?.startsWith('resources/')) required.add('ds:read');
      }
      try {
        requireScopes(principal, [...required]);
      } catch (err) {
        if (!(err instanceof AuthError)) throw err;
        status = 403;
        emit({ event: 'auth', traceId: trace.traceId, status: 403, code: err.code, sub: principal.sub });
        res.setHeader('WWW-Authenticate', `Bearer error="insufficient_scope", scope="${err.missingScopes.join(' ')}", resource_metadata="${prmUrl}"`);
        return sendJson(res, 403, { error: 'insufficient_scope', scope: err.missingScopes.join(' ') });
      }

      const dsVersionHeader = header(req, 'dsversion') ?? header(req, 'x-ds-version');
      const server = createMcpServer(opts.store, { principal, traceId: trace.traceId, dsVersionHeader, publicUrl: opts.publicUrl, designs: opts.designs, sealKey: opts.sealKey, vision: opts.vision });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on('close', () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      (req as IncomingMessage & { auth?: unknown }).auth = { token: '', clientId: principal.clientId, scopes: principal.scopes, expiresAt: principal.expiresAt, extra: { sub: principal.sub } };
      await transport.handleRequest(req, res, parsed);
      status = res.statusCode;
    } catch (err) {
      status = 500;
      if (!res.headersSent) sendJson(res, 500, { error: 'internal', detail: err instanceof Error ? err.message : String(err) });
      else res.end();
    } finally {
      emit({ event: 'request', traceId: trace.traceId, method: req.method, path: url.pathname, status, durationMs: Math.round(performance.now() - t0) });
    }
  });
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
      opts.metrics.record({ ...r.data, sub: principal.sub, traceId: r.data.traceId ?? traceId });
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
