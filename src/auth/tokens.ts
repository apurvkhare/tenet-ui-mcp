// Self-hosted authorization (DESIGN.md §9, "Self-hosted" row): the built-in issuer mints HS256
// tokens from one HMAC key in the environment. The key is an issuer secret, never a bearer
// credential. Tokens carry `iss`, `aud` (this server's MCP URL), `sub`, `exp` and `scope`.
import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';

export const SCOPES = ['ds:read', 'design:ingest', 'audit:run', 'checks:run', 'figma:connect'] as const;
export type Scope = (typeof SCOPES)[number];

export interface Principal {
  sub: string;
  scopes: string[];
  clientId: string;
  expiresAt?: number;
}

export type AuthMode = 'none' | 'hs256';

export interface AuthConfig {
  mode: AuthMode;
  issuer: string; // server origin
  audience: string; // the MCP endpoint URL
  key?: Uint8Array;
}

export function authConfigFromEnv(publicUrl: string): AuthConfig {
  const origin = new URL(publicUrl).origin;
  const audience = new URL('/mcp', publicUrl).href;
  const mode = (process.env.AUTH_MODE ?? (process.env.AUTH_HMAC_KEY ? 'hs256' : 'none')) as AuthMode;
  if (mode !== 'none' && mode !== 'hs256') throw new Error(`AUTH_MODE must be none or hs256, got ${mode}`);
  if (mode === 'hs256') {
    const raw = process.env.AUTH_HMAC_KEY;
    if (!raw || raw.length < 32) throw new Error('AUTH_MODE=hs256 needs AUTH_HMAC_KEY with at least 32 characters (e.g. `openssl rand -base64 48`)');
    return { mode, issuer: origin, audience, key: new TextEncoder().encode(raw) };
  }
  return { mode, issuer: origin, audience };
}

export async function mintToken(cfg: AuthConfig, opts: { sub: string; scopes: string[]; ttlSeconds?: number; clientId?: string }): Promise<string> {
  if (!cfg.key) throw new Error('cannot mint a token without an HMAC key');
  const bad = opts.scopes.filter((s) => !(SCOPES as readonly string[]).includes(s));
  if (bad.length) throw new Error(`unknown scope(s): ${bad.join(', ')}; valid: ${SCOPES.join(' ')}`);
  return new SignJWT({ scope: opts.scopes.join(' '), client_id: opts.clientId ?? opts.sub })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(cfg.issuer)
    .setAudience(cfg.audience)
    .setSubject(opts.sub)
    .setIssuedAt()
    .setExpirationTime(`${opts.ttlSeconds ?? 3600}s`)
    .sign(cfg.key);
}

export class AuthError extends Error {
  constructor(readonly status: 401 | 403, readonly code: 'invalid_token' | 'insufficient_scope' | 'unauthorized', message: string, readonly missingScopes: string[] = []) {
    super(message);
    this.name = 'AuthError';
  }
}

export async function verifyBearer(cfg: AuthConfig, authorization: string | undefined): Promise<Principal> {
  if (cfg.mode === 'none') return { sub: 'anonymous', scopes: [...SCOPES], clientId: 'local' };
  const m = authorization?.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new AuthError(401, 'unauthorized', 'missing bearer token');
  try {
    const { payload } = await jwtVerify(m[1]!, cfg.key!, { issuer: cfg.issuer, audience: cfg.audience, algorithms: ['HS256'] });
    const scopes = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : [];
    return { sub: payload.sub ?? 'unknown', scopes, clientId: typeof payload.client_id === 'string' ? payload.client_id : payload.sub ?? 'unknown', expiresAt: payload.exp };
  } catch (err) {
    const reason = err instanceof joseErrors.JWTExpired ? 'token expired' : err instanceof joseErrors.JOSEError ? err.code : 'invalid token';
    throw new AuthError(401, 'invalid_token', reason);
  }
}

export function requireScopes(p: Principal, required: string[]): void {
  const missing = required.filter((s) => !p.scopes.includes(s));
  if (missing.length) throw new AuthError(403, 'insufficient_scope', `missing scope(s): ${missing.join(' ')}`, missing);
}
