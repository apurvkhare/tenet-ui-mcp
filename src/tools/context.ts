import type { CatalogStore, ResolvedVersion, VersionData } from '../catalog/store.js';

export interface ToolContext {
  store: CatalogStore;
  /** The `DsVersion` request header, if the client mirrored it (DESIGN.md §8). */
  dsVersionHeader?: string;
  traceId: string;
  /** Public base URL of this server, for resource links. */
  publicUrl: string;
}

export interface Versioned {
  resolved: ResolvedVersion;
  data: VersionData;
}

/** Resolve dsVersion from the argument, validating it against the mirrored header when both are present. */
export function pickVersion(ctx: ToolContext, dsVersion: string | undefined): Versioned {
  if (ctx.dsVersionHeader && dsVersion && ctx.dsVersionHeader !== dsVersion) {
    throw new ToolError(`DsVersion header (${ctx.dsVersionHeader}) does not match dsVersion argument (${dsVersion})`, 'version_mismatch');
  }
  const resolved = ctx.store.resolve(dsVersion ?? ctx.dsVersionHeader);
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
