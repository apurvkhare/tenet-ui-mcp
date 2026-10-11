#!/usr/bin/env node
// stdio dev adapter over the same handlers (DESIGN.md §2): no auth, full scopes, one process per
// client. serveStdio builds a server per connection from the factory and answers server/discover;
// a 2025-era client that opens with initialize is served too.
//   npm run stdio   (or point Claude Code at `node --import tsx src/stdio.ts`)
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { SCOPES } from './auth/tokens.js';
import { CatalogStore } from './catalog/store.js';
import { createVision } from './design/vision.js';
import { config } from './ingest/config.js';
import { createMcpServer } from './server.js';
import { DesignStore } from './store/design-store.js';
import { emit } from './telemetry.js';

const store = new CatalogStore(config.snapshotsDir);
const designs = new DesignStore(resolve(process.env.DATA_DIR ?? '.data', 'store'));
const vision = process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.VISION === 'on' ? createVision() : undefined;
const principal = { sub: process.env.USER ?? 'stdio', scopes: [...SCOPES], clientId: 'stdio' };

serveStdio(() => createMcpServer(store, {
  principal,
  // Per connection; a call's own _meta.traceparent (SEP-414) takes precedence.
  traceId: randomBytes(16).toString('hex'),
  publicUrl: process.env.PUBLIC_URL ?? 'http://127.0.0.1:3000',
  designs,
  vision,
}), { onerror: (err) => emit({ event: 'request', traceId: '-', status: 'sdk_error', detail: err.message }) });
