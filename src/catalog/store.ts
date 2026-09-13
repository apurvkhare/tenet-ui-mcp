// Read side of the snapshots the ingest pipeline writes. One folder per dsVersion, resolved per
// call (DESIGN.md §10 "Resolution per call"): exact version, else the newest patch of that minor,
// else the nearest earlier minor of that major, else the latest of that major, else latest.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CatalogComponent } from '../ingest/extract/catalog.js';
import type { GuidelinesRevision, GuidelinePage } from '../ingest/extract/guidelines.js';
import type { DeprecationsRegistry, IconsManifest, TokenRecord } from '../ingest/extract/package-data.js';
import type { StoriesIndex } from '../ingest/extract/stories.js';
import type { GapsReport, SnapshotIndex, SnapshotManifest } from '../ingest/snapshot.js';
import { compareSemver } from '../ingest/snapshot.js';
import { readJson, readJsonIfExists } from '../ingest/util.js';

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
  guidelinesDir: string | undefined;
}

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

  constructor(readonly snapshotsDir: string) {}

  /** Re-reads index.json when it changed on disk (the ingest job commits new snapshots). */
  getIndex(): SnapshotIndex {
    const file = join(this.snapshotsDir, 'index.json');
    if (!existsSync(file)) throw new Error(`no snapshot index at ${file} — run \`npm run ingest -- latest\` first`);
    const mtime = statSync(file).mtimeMs;
    if (!this.index || mtime !== this.indexMtime) {
      this.index = readJson<SnapshotIndex>(file);
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
    const dir = join(this.snapshotsDir, entry.dir);
    const manifest = readJson<SnapshotManifest>(join(dir, 'manifest.json'));
    const catalog = readJson<{ components: CatalogComponent[] }>(join(dir, 'components.json'));
    const tokens = readJsonIfExists<{ tokens: TokenRecord[] }>(join(dir, 'tokens.json'))?.tokens ?? [];
    const guidelines = manifest.guidelinesRevision ? this.revision(manifest.guidelinesRevision) : undefined;
    const data: VersionData = {
      version,
      manifest,
      components: catalog.components,
      byId: new Map(catalog.components.map((c) => [c.id, c])),
      tokens,
      icons: readJsonIfExists<IconsManifest>(join(dir, 'icons.json')),
      deprecations: readJsonIfExists<DeprecationsRegistry>(join(dir, 'deprecations.json')),
      stories: readJsonIfExists<StoriesIndex>(join(dir, 'stories.json')),
      gaps: readJsonIfExists<GapsReport>(join(dir, 'gaps.json')),
      changelog: readJsonIfExists<{ entries: Array<{ version: string; date?: string; body: string }> }>(join(dir, 'changelog.json')),
      guidelines,
      guidelinesDir: manifest.guidelinesRevision ? join(this.snapshotsDir, 'guidelines', manifest.guidelinesRevision) : undefined,
    };
    this.cache.set(version, data);
    return data;
  }

  revision(id: string): GuidelinesRevision | undefined {
    const cached = this.revisions.get(id);
    if (cached) return cached;
    const rev = readJsonIfExists<GuidelinesRevision>(join(this.snapshotsDir, 'guidelines', id, 'revision.json'));
    if (rev) this.revisions.set(id, rev);
    return rev;
  }

  /** Every guidelines revision on disk, oldest first. */
  revisionIds(): string[] {
    const dir = join(this.snapshotsDir, 'guidelines');
    return existsSync(dir) ? readdirSync(dir).filter((d) => existsSync(join(dir, d, 'revision.json'))).sort() : [];
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
