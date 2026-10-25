// Read side of the snapshots the ingest pipeline writes. One folder per dsVersion, resolved per
// call (DESIGN.md §10 "Resolution per call"): exact version, else the newest patch of that minor,
// else the nearest earlier minor of that major, else the latest of that major, else latest.
import { diskFiles, type SnapshotFiles } from './files.js';
import type { CatalogComponent } from '../ingest/extract/catalog.js';
import type { GuidelinesRevision, GuidelinePage } from '../ingest/extract/guidelines.js';
import type { DeprecationsRegistry, IconsManifest, TokenRecord } from '../ingest/extract/package-data.js';
import type { StoriesIndex } from '../ingest/extract/stories.js';
import type { GapsReport, SnapshotIndex, SnapshotManifest } from '../ingest/snapshot.js';
import { compareSemver } from '../ingest/semver.js';

export interface VersionData {
  version: string;
  manifest: SnapshotManifest;
  components: CatalogComponent[];
  byId: Map<string, CatalogComponent>;
  tokens: TokenRecord[];
  icons: IconsManifest | undefined;
  deprecations: DeprecationsRegistry | undefined;
  stories: StoriesIndex | undefined;
  gaps: GapsReport | undefined;
  changelog: { entries: Array<{ version: string; date?: string; body: string }> } | undefined;
  guidelines: GuidelinesRevision | undefined;
  /** Relative to the snapshots root; read through `store.files`. */
  guidelinesDir: string | undefined;
  /** Story baseline screenshots from the release (served as ds://{v}/baselines/{file}); absent when the release shipped none. `dir` is relative to the snapshots root. */
  baselines: { dir: string; viewport?: { width: number; height: number }; entries: BaselineEntry[] } | undefined;
}

export interface BaselineEntry { storyId: string; name?: string; theme: string; file: string; sha256?: string }

export type ResolveStrategy = 'exact' | 'newest-patch-of-minor' | 'nearest-earlier-minor' | 'latest-of-major' | 'latest';
export interface ResolvedVersion {
  requested: string;
  effective: string;
  strategy: ResolveStrategy;
  /** Present when the effective version is not the requested one. */
  note?: string;
}

export class CatalogStore {
  private index: SnapshotIndex | undefined;
  private indexMtime = 0;
  private cache = new Map<string, VersionData>();
  private revisions = new Map<string, GuidelinesRevision>();

  readonly files: SnapshotFiles;

  /** A snapshots folder on disk, or the files themselves (the Worker bundles them). */
  constructor(source: string | SnapshotFiles) {
    this.files = typeof source === 'string' ? diskFiles(source) : source;
  }

  private json<T>(path: string): T | undefined {
    const text = this.files.text(path);
    return text === undefined ? undefined : (JSON.parse(text) as T);
  }

  private requireJson<T>(path: string): T {
    const v = this.json<T>(path);
    if (v === undefined) throw new Error(`snapshot file missing: ${path}`);
    return v;
  }

  /** Re-reads index.json when it changed on disk (the ingest job commits new snapshots). */
  getIndex(): SnapshotIndex {
    const mtime = this.files.stamp('index.json');
    if (mtime === undefined) throw new Error('no snapshot index (index.json) — run `npm run ingest -- latest` first');
    if (!this.index || mtime !== this.indexMtime) {
      this.index = this.requireJson<SnapshotIndex>('index.json');
      this.indexMtime = mtime;
      this.cache.clear();
    }
    return this.index;
  }

  get packageName(): string {
    return this.getIndex().package;
  }

  versions(): string[] {
    return Object.keys(this.getIndex().versions).sort(compareSemver);
  }

  latest(): string {
    const index = this.getIndex();
    const latest = index.latest ?? this.versions().at(-1);
    if (!latest) throw new Error('snapshot index has no versions');
    return latest;
  }

  resolve(spec: string | undefined): ResolvedVersion {
    const requested = (spec ?? 'latest').trim();
    const versions = this.versions();
    const latest = this.latest();
    if (!requested || requested === 'latest' || requested === '*') return { requested: requested || 'latest', effective: latest, strategy: 'latest' };
    const clean = requested.replace(/^[v^~=]+/, '');
    if (versions.includes(clean)) return { requested, effective: clean, strategy: 'exact' };

    const m = clean.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!m) return { requested, effective: latest, strategy: 'latest', note: `"${requested}" is not a version; serving latest` };
    const major = Number(m[1]);
    const minor = m[2] !== undefined ? Number(m[2]) : undefined;
    const parts = (v: string): [number, number] => { const p = v.split('.'); return [Number(p[0]), Number(p[1] ?? 0)]; };
    const sameMajor = versions.filter((v) => parts(v)[0] === major);
    if (minor !== undefined) {
      const sameMinor = sameMajor.filter((v) => parts(v)[1] === minor);
      if (sameMinor.length) {
        const effective = sameMinor.at(-1)!;
        return { requested, effective, strategy: 'newest-patch-of-minor', note: `${requested} is not snapshotted; serving ${effective}, the newest patch of ${major}.${minor}` };
      }
      const earlier = sameMajor.filter((v) => parts(v)[1] < minor);
      if (earlier.length) {
        const effective = earlier.at(-1)!;
        return { requested, effective, strategy: 'nearest-earlier-minor', note: `${requested} is not snapshotted; serving ${effective}, the nearest earlier minor` };
      }
    }
    if (sameMajor.length) {
      const effective = sameMajor.at(-1)!;
      return { requested, effective, strategy: 'latest-of-major', note: `${requested} is not snapshotted; serving ${effective}, the latest ${major}.x` };
    }
    return { requested, effective: latest, strategy: 'latest', note: `no ${major}.x snapshot; serving latest (${latest})` };
  }

  load(version: string): VersionData {
    const cached = this.cache.get(version);
    if (cached) return cached;
    const entry = this.getIndex().versions[version];
    if (!entry) throw new Error(`no snapshot for ${version}`);
    const dir = entry.dir;
    const manifest = this.requireJson<SnapshotManifest>(`${dir}/manifest.json`);
    const catalog = this.requireJson<{ components: CatalogComponent[] }>(`${dir}/components.json`);
    const tokens = this.json<{ tokens: TokenRecord[] }>(`${dir}/tokens.json`)?.tokens ?? [];
    const guidelines = manifest.guidelinesRevision ? this.revision(manifest.guidelinesRevision) : undefined;
    const data: VersionData = {
      version,
      manifest,
      components: catalog.components,
      byId: new Map(catalog.components.map((c) => [c.id, c])),
      tokens,
      icons: this.json<IconsManifest>(`${dir}/icons.json`),
      deprecations: this.json<DeprecationsRegistry>(`${dir}/deprecations.json`),
      stories: this.json<StoriesIndex>(`${dir}/stories.json`),
      gaps: this.json<GapsReport>(`${dir}/gaps.json`),
      changelog: this.json<{ entries: Array<{ version: string; date?: string; body: string }> }>(`${dir}/changelog.json`),
      guidelines,
      guidelinesDir: manifest.guidelinesRevision ? `guidelines/${manifest.guidelinesRevision}` : undefined,
      baselines: this.baselinesIn(`${dir}/baselines`),
    };
    this.cache.set(version, data);
    return data;
  }

  revision(id: string): GuidelinesRevision | undefined {
    const cached = this.revisions.get(id);
    if (cached) return cached;
    const rev = this.json<GuidelinesRevision>(`guidelines/${id}/revision.json`);
    if (rev) this.revisions.set(id, rev);
    return rev;
  }

  /** Every guidelines revision on disk, oldest first. */
  revisionIds(): string[] {
    return this.files.list('guidelines').filter((d) => this.files.text(`guidelines/${d}/revision.json`) !== undefined).sort();
  }

  private baselinesIn(dir: string): VersionData['baselines'] {
    const m = this.json<{ viewport?: { width: number; height: number }; entries: BaselineEntry[] }>(`${dir}/manifest.json`);
    return m ? { dir, viewport: m.viewport, entries: m.entries } : undefined;
  }

  /** Find a component by id, export name, display name, or a sub-export (case-insensitive). */
  findComponent(data: VersionData, name: string): CatalogComponent | undefined {
    const q = name.trim().toLowerCase();
    const norm = q.replace(/[^a-z0-9]/g, '');
    return (
      data.byId.get(q) ??
      data.components.find((c) => c.name.toLowerCase() === q || c.exportName.toLowerCase() === q) ??
      data.components.find((c) => c.id.replace(/-/g, '') === norm || c.name.toLowerCase() === norm) ??
      data.components.find((c) => c.subcomponents.some((s) => s.exportName?.toLowerCase() === q || s.name.toLowerCase() === q))
    );
  }

  guidelinePage(data: VersionData, id: string, scope?: GuidelinePage['scope']): GuidelinePage | undefined {
    return data.guidelines?.pages.find((p) => p.id === id && (!scope || p.scope === scope));
  }
}

/** URI of a story's baseline screenshot, when the release shipped one. */
export function baselineUri(data: VersionData, storyId: string, theme = 'light'): string | undefined {
  const e = data.baselines?.entries.find((x) => x.storyId === storyId && x.theme === theme);
  return e ? `ds://${data.version}/baselines/${e.file}` : undefined;
}
