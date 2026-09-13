#!/usr/bin/env node
// Start the HTTP server.
//   PORT=3000 HOST=127.0.0.1 PUBLIC_URL=http://127.0.0.1:3000 AUTH_MODE=hs256 AUTH_HMAC_KEY=… npm start
import { authConfigFromEnv } from './auth/tokens.js';
import { sealingKey } from './auth/seal.js';
import { createVision } from './design/vision.js';
import { DesignStore } from './store/design-store.js';
import { resolve } from 'node:path';
import { CatalogStore } from './catalog/store.js';
import { createHttpServer } from './http.js';
import { config } from './ingest/config.js';

const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? 3000);
const publicUrl = process.env.PUBLIC_URL ?? `http://${host}:${port}`;
const store = new CatalogStore(config.snapshotsDir);
const auth = authConfigFromEnv(publicUrl);
const cc = process.env.AUTH_CLIENT_ID && process.env.AUTH_CLIENT_SECRET
  ? { clientId: process.env.AUTH_CLIENT_ID, clientSecret: process.env.AUTH_CLIENT_SECRET, scopes: (process.env.AUTH_CLIENT_SCOPES ?? 'ds:read audit:run checks:run').split(/\s+/) }
  : undefined;

const designs = new DesignStore(resolve(process.env.DATA_DIR ?? '.data', 'store'));
setInterval(() => designs.purge(), 60 * 60 * 1000).unref();
const visionEnabled = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.VISION === 'on');
const server = createHttpServer({ store, publicUrl, auth, allowedOrigins: (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean), clientCredentials: cc, designs, sealKey: sealingKey(process.env.AUTH_HMAC_KEY), vision: visionEnabled ? createVision() : undefined });
server.listen(port, host, () => {
  console.error(`tenet-ui-mcp listening on ${publicUrl}/mcp — auth ${auth.mode}${auth.mode === 'hs256' ? ` (aud ${auth.audience})` : ''} — versions ${store.versions().join(', ')} (latest ${store.latest()}) — vision ${visionEnabled ? (process.env.VISION_MODEL ?? 'claude-opus-5') : 'off (layout only)'}`);
});
const stop = (): void => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
