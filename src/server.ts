// One McpServer per serving unit (one HTTP request, one stdio connection), MCP 2026-07-28 through
// the v2 SDK: no initialize handshake, `server/discover` answered by the SDK, per-request `_meta`
// envelope. Tools and resources are registered in a fixed order so tools/list is deterministic
// (DESIGN.md §6); every tool returns structuredContent plus a short text summary and resource links;
// every result carries the trace id and effective version.
import { McpServer, ResourceTemplate, TRACEPARENT_META_KEY, type CacheHint, type CallToolResult, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { CatalogStore } from './catalog/store.js';
import { listResources, readResource } from './resources.js';
import { emit, traceFromHeader } from './telemetry.js';
import { CATALOG_TOOLS } from './tools/catalog-tools.js';
import { DESIGN_TOOLS } from './tools/design-tools.js';
import { CHECK_TOOLS } from './tools/checks-tools.js';
import { AUDIT_TOOLS } from './tools/audit-tools.js';
import { TEST_TOOLS } from './tools/test-tools.js';
import { PROMPTS } from './prompts.js';
import type { DesignStore } from './store/design-store.js';
import type { VisionFn } from './design/vision.js';
import { bytes } from './tools/caps.js';
import { ToolError, type ToolContext } from './tools/context.js';
import type { Principal } from './auth/tokens.js';

export const SERVER_INFO = { name: 'tenet-ui-mcp', version: '0.2.0', title: 'tenet-ui design system' } as const;

export const ALL_TOOLS = [...CATALOG_TOOLS, ...DESIGN_TOOLS, ...AUDIT_TOOLS, ...TEST_TOOLS, ...CHECK_TOOLS];
export const TOOL_SCOPES: Record<string, string> = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t.scope]));

export interface RequestScope {
  principal: Principal;
  /** The trace of the HTTP request (or of the stdio connection); a call's own `_meta.traceparent` wins. */
  traceId: string;
  publicUrl: string;
  designs?: DesignStore;
  vision?: VisionFn;
}

// Cacheable results (SEP-2549). Everything sits behind a bearer token, so every scope is private.
const HOUR = 3_600_000;
const CACHE_HINTS: Partial<Record<'tools/list' | 'prompts/list' | 'resources/list' | 'resources/templates/list' | 'server/discover', CacheHint>> = {
  'tools/list': { ttlMs: HOUR, cacheScope: 'private' },
  'prompts/list': { ttlMs: HOUR, cacheScope: 'private' },
  'resources/templates/list': { ttlMs: HOUR, cacheScope: 'private' },
  'server/discover': { ttlMs: HOUR, cacheScope: 'private' },
  'resources/list': { ttlMs: 5 * 60_000, cacheScope: 'private' }, // grows when a version is ingested
};

/** A snapshot read by exact version never changes; `latest`, `versions` and private rows do. */
export function readCacheHint(uri: string, store: CatalogStore): CacheHint {
  const m = uri.match(/^ds:\/\/([^/]+)\//);
  if (m && store.versions().includes(m[1]!)) return { ttlMs: 24 * HOUR, cacheScope: 'private' };
  if (uri.startsWith('ds://')) return { ttlMs: 5 * 60_000, cacheScope: 'private' };
  return { ttlMs: 0, cacheScope: 'private' };
}

/** SEP-414: a W3C trace context in the request's `_meta` names the trace of this call. */
function traceOf(ctx: ServerContext, fallback: string): string {
  const tp = (ctx.mcpReq._meta as Record<string, unknown> | undefined)?.[TRACEPARENT_META_KEY];
  return typeof tp === 'string' && /^00-[0-9a-f]{32}-/i.test(tp) ? traceFromHeader(tp).traceId : fallback;
}

export function createMcpServer(store: CatalogStore, scope: RequestScope): McpServer {
  const server = new McpServer(SERVER_INFO, {
    instructions: [
      `Design-system server for ${store.packageName}. Search-first: search_components → get_component, find_tokens / resolve_value for styling, search_icons for glyphs.`,
      'Always pass dsVersion from the consumer\'s lockfile; results echo the effective version. Read ds://{version}/guidelines/contract before writing code.',
      'Design to code: ingest_design → match_components → resolve_tokens → plan_component → write → capture → run_checks. The server decides close matches and off-scale values itself and says why; never ask the user to choose. Existing UI: audit_code + audit_page (capture.mjs page) → fix by severity → run_checks. Tests: plan_tests → write → run_checks.',
    ].join(' '),
    cacheHints: CACHE_HINTS,
  });
  const baseCtx: ToolContext = { store, traceId: scope.traceId, publicUrl: scope.publicUrl, principal: scope.principal, designs: scope.designs, vision: scope.vision };
  const readCtx = { designs: scope.designs, sub: scope.principal.sub };

  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: z.object(tool.inputSchema),
        outputSchema: z.object(tool.outputSchema),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (args, mcpCtx): Promise<CallToolResult> => {
        const t0 = performance.now();
        const traceId = traceOf(mcpCtx, scope.traceId);
        try {
          const r = await tool.run(args as never, { ...baseCtx, traceId });
          const structured = { ...r.structured } as Record<string, unknown>;
          delete structured._meta;
          const result: CallToolResult = {
            content: [{ type: 'text', text: r.text }, ...(r.links ?? []).map((l) => ({ type: 'resource_link' as const, uri: l.uri, name: l.name, description: l.description, mimeType: l.mimeType }))],
            structuredContent: structured,
            _meta: { traceId, dsVersion: structured.dsVersion, guidelinesRevision: structured.guidelinesRevision, bytes: bytes(structured), cap: tool.cap },
          };
          emit({ event: 'tool', traceId, tool: tool.name, status: 'ok', durationMs: Math.round(performance.now() - t0), dsVersion: structured.dsVersion, bytes: bytes(structured), sub: scope.principal.sub, ...toolMetrics(tool.name, args as Record<string, unknown>, structured) });
          return result;
        } catch (err) {
          const code = err instanceof ToolError ? err.code : 'internal';
          const message = err instanceof Error ? err.message : String(err);
          emit({ event: 'tool', traceId, tool: tool.name, status: 'error', code, durationMs: Math.round(performance.now() - t0), sub: scope.principal.sub });
          return { isError: true, content: [{ type: 'text', text: `${tool.name}: ${message}` }], _meta: { traceId, code, ...(err instanceof ToolError && err.data ? { data: err.data } : {}) } };
        }
      },
    );
  }

  const read = (uri: URL, mcpCtx: ServerContext) => {
    const c = readResource(store, uri.href, readCtx);
    emit({ event: 'resource', traceId: traceOf(mcpCtx, scope.traceId), uri: uri.href, bytes: c.blob ? c.blob.length : Buffer.byteLength(c.text ?? ''), sub: scope.principal.sub });
    return {
      contents: [c.blob ? { uri: c.uri, mimeType: c.mimeType, blob: c.blob.toString('base64') } : { uri: c.uri, mimeType: c.mimeType, text: c.text ?? '' }],
      ...readCacheHint(uri.href, store),
    };
  };

  // Concrete resources.
  for (const r of listResources(store)) {
    server.registerResource(r.name, r.uri, { description: r.description, mimeType: r.mimeType }, (uri, mcpCtx) => read(uri, mcpCtx));
  }
  // Templates.
  const templates: Array<[string, string, string, string]> = [
    ['component', 'ds://{version}/components/{name}', 'text/markdown', 'One component: import, props table (types are the truth), stories, accessibility, guidelines.'],
    ['tokens-group', 'ds://{version}/tokens/{group}.json', 'application/json', 'Every token of a group with light/dark values and documented contrast pairs.'],
    ['guideline', 'ds://{version}/guidelines/{topic}', 'text/markdown', 'System guidelines (color, typography, layout, forms, feedback, data-display, iconography, accessibility, content), a component id, `contract`, or `audit-rules`.'],
    // {+artifact}: reserved expansion, so `matches/{matchId}.json` and `plans/{planId}.md` (two segments) match too.
    ['design', 'design://{designId}/{+artifact}', 'application/json', 'Private, principal-bound: layout.json, screenshot.png, matches/{matchId}.json, plans/{planId}.md, match.json / plan.md (latest).'],
    ['audit', 'audit://{auditId}/{report}', 'application/json', 'Private, principal-bound: findings.json (every finding of a run_checks / audit_code / audit_page report), delta.json, report.json.'],
  ];
  for (const [name, tpl, mimeType, description] of templates) {
    server.registerResource(name, new ResourceTemplate(tpl, {
      list: undefined,
      complete: {
        version: (value) => store.versions().filter((v) => v.startsWith(value)),
        name: (value) => store.load(store.latest()).components.map((c) => c.id).filter((id) => id.startsWith(value)).slice(0, 20),
        group: (value) => [...new Set(store.load(store.latest()).tokens.map((t) => t.path?.[0] ?? ''))].filter((g) => g.startsWith(value)),
        topic: (value) => ['contract', 'audit-rules', ...(store.load(store.latest()).guidelines?.pages.filter((p) => p.scope === 'system').map((p) => p.id) ?? [])].filter((t) => t.startsWith(value)),
        artifact: (value) => ['layout.json', 'screenshot.png', 'match.json', 'plan.md'].filter((a) => a.startsWith(value)),
        report: (value) => ['findings.json', 'delta.json', 'report.json'].filter((a) => a.startsWith(value)),
      },
    }), { description, mimeType }, (uri, _variables, mcpCtx) => read(uri, mcpCtx));
  }

  // Prompts (DESIGN.md §6): the three paths, with the anti-duplicate-call rule and the stop condition.
  for (const p of PROMPTS) {
    server.registerPrompt(p.name, { title: p.title, description: p.description, argsSchema: z.object(p.args) }, (args) => ({ description: p.description, messages: [{ role: 'user', content: { type: 'text', text: p.render(args as Record<string, string | undefined>, store) } }] }));
  }

  return server;
}

/** Names, counts and outcomes only (DESIGN.md §7 layer one): never arguments, images or findings text. */
export function toolMetrics(name: string, args: Record<string, unknown>, out: Record<string, unknown>): Record<string, unknown> {
  const m: Record<string, unknown> = {};
  if (out.dsVersionNote) m.versionFallback = true;
  if (typeof out.decisions === 'number') m.decisions = out.decisions;
  if (typeof out.status === 'string' && (out.status === 'pass' || out.status === 'fail')) m.outcome = out.status;
  if (out.summary && typeof out.summary === 'object') { const s = out.summary as Record<string, unknown>; if (typeof s.total === 'number') m.findings = s.total; if (typeof s.critical === 'number') m.critical = s.critical; }
  if (out.checks && typeof out.checks === 'object') m.checks = Object.fromEntries(Object.entries(out.checks as Record<string, { status?: string }>).map(([k, v]) => [k, v?.status ?? '?']));
  if (out.delta && typeof out.delta === 'object') { const d = out.delta as Record<string, unknown>; m.round = 2; if (typeof d.fixed === 'number') m.fixed = d.fixed; if (typeof d.remaining === 'number') m.remaining = d.remaining; }
  else if (name === 'run_checks' || name.startsWith('audit_')) m.round = 1;
  if (name === 'search_components' || name === 'search_icons' || name === 'find_tokens') m.zeroResults = Array.isArray(out.results) && out.results.length === 0;
  if (name === 'get_component') m.full = args.full === true;
  if (name === 'match_components' && Array.isArray(out.assignments)) { const a = out.assignments as Array<{ confidence?: number; decision?: { basis?: string } }>; m.lowConfidence = a.filter((x) => typeof x.confidence === 'number' && x.confidence < 0.6).length; m.decidedByScore = a.filter((x) => x.decision?.basis === 'score').length; }
  if (name === 'resolve_tokens') { if (typeof out.exceptions === 'number') m.exceptions = out.exceptions; if (typeof out.snappedBeyondTolerance === 'number') m.snappedBeyondTolerance = out.snappedBeyondTolerance; }
  if (typeof args.auditId === 'string') m.withPrevious = true;
  if (typeof args.designId === 'string') m.withDesign = true;
  return m;
}

/** Sanity check used by tests and CI: tools/list must stay small and deterministic. */
export function toolListSummary(): { names: string[]; descriptionsUnder300: boolean } {
  return { names: ALL_TOOLS.map((t) => t.name), descriptionsUnder300: ALL_TOOLS.every((t) => t.description.length < 300) };
}

export { z };
