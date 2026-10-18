import type { Principal } from '../auth/tokens.js';
import type { CatalogStore, ResolvedVersion, VersionData } from '../catalog/store.js';
import type { VisionFn } from '../design/vision.js';
import type { DesignStore } from '../store/design-store.js';

export interface ToolContext {
  store: CatalogStore;
  traceId: string;
  /** Public base URL of this server, for resource links. */
  publicUrl: string;
  /** Present on transports that carry a principal (HTTP, stdio); design tools need all three. */
  principal?: Principal;
  designs?: DesignStore;
  /** Opt-in perception (VISION=on); undefined by default, when the agent supplies the layout. */
  vision?: VisionFn;
}

export interface Versioned {
  resolved: ResolvedVersion;
  data: VersionData;
}

/**
 * Resolve dsVersion from the argument. Over Streamable HTTP the client mirrors it into the
 * `Mcp-Param-DsVersion` header (SEP-2243, from `x-mcp-header`) and the SDK rejects a mismatch with
 * 400 / -32020 before the tool runs, so the argument is the only source here.
 */
export function pickVersion(ctx: ToolContext, dsVersion: string | undefined): Versioned {
  const resolved = ctx.store.resolve(dsVersion);
  return { resolved, data: ctx.store.load(resolved.effective) };
}

export class ToolError extends Error {
  constructor(message: string, readonly code: string, readonly data?: Record<string, unknown>) {
    super(message);
    this.name = 'ToolError';
  }
}

export const storybookUrlFor = (data: VersionData, storyId: string): string | undefined =>
  data.stories ? `${data.stories.storybookUrl}?path=/story/${storyId}` : undefined;

export const versionMeta = (v: Versioned): Record<string, unknown> => ({
  dsVersion: v.resolved.effective,
  ...(v.resolved.note ? { dsVersionNote: `requested ${v.resolved.requested}: ${v.resolved.note}` } : {}),
  guidelinesRevision: v.data.manifest.guidelinesRevision,
});
