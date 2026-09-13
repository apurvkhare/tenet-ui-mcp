import type { Principal } from '../auth/tokens.js';
import type { CatalogStore, ResolvedVersion, VersionData } from '../catalog/store.js';
import type { VisionFn } from '../design/vision.js';
import type { DesignStore } from '../store/design-store.js';

export interface ToolContext {
  store: CatalogStore;
  /** The `DsVersion` request header, if the client mirrored it (DESIGN.md §8). */
  dsVersionHeader?: string;
  traceId: string;
  /** Public base URL of this server, for resource links. */
  publicUrl: string;
  /** Present on transports that carry a principal (HTTP, stdio); design tools need all three. */
  principal?: Principal;
  designs?: DesignStore;
  sealKey?: Buffer;
  /** Perception; undefined when no model credentials are configured. */
  vision?: VisionFn;
}

export interface Versioned {
  resolved: ResolvedVersion;
  data: VersionData;
}

/** Resolve dsVersion from the argument, validating it against the mirrored header when both are present. */
export function pickVersion(ctx: ToolContext, dsVersion: string | undefined): Versioned {
  if (ctx.dsVersionHeader && dsVersion && dsVersion !== 'latest' && ctx.dsVersionHeader !== dsVersion) {
    throw new ToolError(`DsVersion header (${ctx.dsVersionHeader}) does not match dsVersion argument (${dsVersion})`, 'version_mismatch');
  }
  const resolved = ctx.store.resolve(dsVersion && dsVersion !== 'latest' ? dsVersion : ctx.dsVersionHeader ?? dsVersion);
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
