#!/usr/bin/env node
// stdio dev adapter over the same handlers (DESIGN.md §2): no auth, full scopes, one process per client.
//   npm run stdio   (or point Claude Code at `node --import tsx src/stdio.ts`)
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { randomBytes } from 'node:crypto';
import { SCOPES } from './auth/tokens.js';
import { CatalogStore } from './catalog/store.js';
import { config } from './ingest/config.js';
import { createMcpServer } from './server.js';

const store = new CatalogStore(config.snapshotsDir);
const server = createMcpServer(store, {
  principal: { sub: process.env.USER ?? 'stdio', scopes: [...SCOPES], clientId: 'stdio' },
  traceId: randomBytes(16).toString('hex'),
  publicUrl: process.env.PUBLIC_URL ?? 'http://127.0.0.1:3000',
});
await server.connect(new StdioServerTransport());
