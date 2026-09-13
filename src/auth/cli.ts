#!/usr/bin/env node
// Mint a token from the built-in issuer, for a developer's client or a CI job.
//   AUTH_HMAC_KEY=… PUBLIC_URL=http://127.0.0.1:3000 npm run token -- --sub apurv --scope ds:read --scope audit:run --ttl 86400
import { authConfigFromEnv, mintToken, SCOPES } from './tokens.js';

const argv = process.argv.slice(2);
const values = (flag: string): string[] => argv.flatMap((a, i) => (a === flag && argv[i + 1] ? [argv[i + 1]!] : []));
const sub = values('--sub')[0] ?? 'dev';
const scopes = values('--scope').flatMap((s) => s.split(/[\s,]+/)).filter(Boolean);
const ttl = Number(values('--ttl')[0] ?? 3600);
const publicUrl = process.env.PUBLIC_URL ?? `http://${process.env.HOST ?? '127.0.0.1'}:${process.env.PORT ?? '3000'}`;

const cfg = authConfigFromEnv(publicUrl);
if (cfg.mode !== 'hs256') {
  console.error('AUTH_MODE is none: no token needed. Set AUTH_HMAC_KEY to enable the built-in issuer.');
  process.exit(2);
}
mintToken(cfg, { sub, scopes: scopes.length ? scopes : ['ds:read'], ttlSeconds: ttl })
  .then((t) => { console.error(`sub=${sub} scopes=${(scopes.length ? scopes : ['ds:read']).join(' ')} aud=${cfg.audience} ttl=${ttl}s (valid scopes: ${SCOPES.join(' ')})`); console.log(t); })
  .catch((err) => { console.error(err.message); process.exit(1); });
