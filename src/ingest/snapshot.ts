// Build one version snapshot from every source, validate it fail-closed, and publish it into the
// snapshot index (DESIGN.md §10 "Keeping it current").
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { fetchBaselines } from './extract/baselines.js';
import { mergeCatalog, type CatalogComponent, type CatalogMismatch, type ShippedCatalog } from './extract/catalog.js';
import { fetchLlms, readPackageGuidelines, type GuidelinesRevision } from './extract/guidelines.js';
import { readChangelog, readDeprecations, readIcons, readPackageMeta, readShippedCatalog, readTokens } from './extract/package-data.js';
import { fetchStories, type StoriesIndex } from './extract/stories.js';
import { extractTypes } from './extract/types.js';
import { checkProvenance, fetchPackument, resolveVersion, type Provenance } from './registry.js';
import { downloadAndExtract } from './tarball.js';
import { IngestError, ensureDir, hashJson, listFiles, nowIso, readJson, readJsonIfExists, sha256, writeJson } from './util.js';

export interface SourceRecord {
  kind: string;
  source: 'npm' | 'storybook' | 'github-release' | 'docs-site';
  sourceRef: string;
  url?: string;
  contentHash: string;
  extractedAt: string;
  status: 'ok' | 'missing';
  detail?: string;
}

export interface SnapshotManifest {
  schemaVersion: 1;
  package: string;
  version: string;
  ingestedAt: string;
  provenance: Provenance;
  sourceRef: { tag: string; commit?: string; tarball: string; tarballSha256: string };
  guidelinesRevision?: string;
  sources: SourceRecord[];
  counts: Record<string, number>;
  files: string[];
}

export interface Gap { component: string; gaps: string[] }
export interface GapsReport {
  version: string;
  summary: Record<string, number>;
  components: Gap[];
  catalogMismatches: CatalogMismatch[];
  storyIdsNotInStorybook: string[];
  unclassifiedExports: string[];
}

export interface IngestOptions {
  /** Sources allowed to be absent without failing: stories, baselines, guidelines, docs, catalog, tokens, icons, deprecations, changelog. */
  allowMissing: Set<string>;
  allowUnattested: boolean;
  allowFewerGuidelines: boolean;
  force: boolean;
  log: (msg: string) => void;
}

export interface SnapshotIndex {
  schemaVersion: 1;
  package: string;
  updatedAt: string;
  latest?: string;
  versions: Record<string, { dir: string; ingestedAt: string; sourceRef: SnapshotManifest['sourceRef']; provenance: Provenance['status']; guidelinesRevision?: string; counts: Record<string, number> }>;
}

const MISSING_KINDS = ['catalog', 'tokens', 'icons', 'deprecations', 'changelog', 'stories', 'baselines', 'guidelines', 'docs'] as const;

export async function ingestVersion(spec: string, opts: IngestOptions): Promise<SnapshotManifest> {
  const { log } = opts;
  const packument = await fetchPackument();
  const v = resolveVersion(packument, spec);
  const version = v.version;
  const finalDir = join(config.snapshotsDir, version);
  const index = readIndex();
  if (index.versions[version] && !opts.force) {
    log(`${config.packageName}@${version}: already ingested (${index.versions[version]!.ingestedAt}); use --force to redo`);
    return readJson<SnapshotManifest>(join(finalDir, 'manifest.json'));
  }
  log(`${config.packageName}@${version}: resolved (${v.dist.tarball})`);

  // 1. Provenance (fail-closed unless allowed).
  const provenance = await checkProvenance(config.packageName, version);
  log(`  provenance: ${provenance.status}${provenance.commit ? ` (${provenance.repository}@${provenance.commit.slice(0, 7)}, ${provenance.workflow})` : ''}${provenance.detail ? ` — ${provenance.detail}` : ''}`);
  if (provenance.status === 'mismatch') throw new IngestError(`refusing ${version}: ${provenance.detail}`);
  if (provenance.status === 'none' && !opts.allowUnattested) throw new IngestError(`refusing ${version}: no provenance attestation (pass --allow-unattested for versions published before trusted publishing)`);

  // 2. Tarball.
  const tarball = await downloadAndExtract(v);
  const pkgMeta = readPackageMeta(tarball.dir);
  log(`  tarball: ${(tarball.bytes / 1024).toFixed(0)} KB, exports ${pkgMeta.exports.join(' ')}`);
  const docsUrl = config.docsUrl ?? pkgMeta.homepage;
  const storybookUrl = config.storybookUrl ?? (docsUrl ? new URL('storybook/', docsUrl).href : undefined);

  const staging = join(config.snapshotsDir, `.staging-${version}`);
  if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  ensureDir(staging);
  const sources: SourceRecord[] = [];
  const counts: Record<string, number> = {};
  const at = nowIso();
  const record = (kind: string, source: SourceRecord['source'], sourceRef: string, contentHash: string, url?: string, detail?: string): void => {
    sources.push({ kind, source, sourceRef, url, contentHash, extractedAt: at, status: 'ok', detail });
  };
  const missing = (kind: (typeof MISSING_KINDS)[number], source: SourceRecord['source'], detail: string): void => {
    sources.push({ kind, source, sourceRef: version, contentHash: '', extractedAt: at, status: 'missing', detail });
    if (!opts.allowMissing.has(kind)) throw new IngestError(`refusing ${version}: ${kind} missing — ${detail} (pass --allow-missing ${kind} if this version genuinely has none)`);
    log(`  ${kind}: missing — ${detail} (allowed)`);
  };
  const npmRef = `${config.packageName}@${version}`;

  // 3. Types from the .d.ts (always required: types are the structure).
  const dts = join(tarball.dir, 'dist', 'index.d.ts');
  if (!existsSync(dts)) throw new IngestError(`refusing ${version}: no dist/index.d.ts in the tarball`);
  const extracted = extractTypes(dts);
  writeJson(join(staging, 'types.json'), extracted);
  record('types', 'npm', npmRef, hashJson(extracted), v.dist.tarball, `TypeScript ${extracted.typescript}`);
  counts.exportedComponents = extracted.components.filter((c) => c.kind === 'component').length;
  counts.exportedHooks = extracted.components.filter((c) => c.kind === 'hook').length;
  counts.exportedTypes = extracted.types.length;
  log(`  types: ${counts.exportedComponents} components, ${counts.exportedHooks} hooks, ${counts.exportedTypes} types from dist/index.d.ts`);

  // 4. Guidelines revision (package markdown) + docs-site llms.txt.
  const date = at.slice(0, 10);
  const guidelinesTmp = join(staging, '.guidelines');
  const revision = readPackageGuidelines(tarball.dir, guidelinesTmp, date);
  let guidelinesRevisionId: string | undefined;
  if (revision) {
    const revDir = join(config.snapshotsDir, 'guidelines', revision.id);
    if (docsUrl) {
      const llms = await fetchLlms(docsUrl, guidelinesTmp);
      if (llms) { revision.llms = llms; record('docs', 'docs-site', llms.url, llms.fullHash ?? llms.indexHash, llms.url, `${llms.pageCount ?? '?'} pages in llms-full.txt`); }
      else missing('docs', 'docs-site', `${docsUrl}llms.txt not reachable`);
    }
    // Fail-closed: never publish a thinner revision than the current one.
    const prev = latestGuidelineRevision();
    if (prev && revision.pages.length < prev.pages.length && !opts.allowFewerGuidelines) {
      throw new IngestError(`refusing ${version}: guidelines adapter returned ${revision.pages.length} pages, previous revision ${prev.id} had ${prev.pages.length}`);
    }
    if (!existsSync(revDir)) {
      ensureDir(join(config.snapshotsDir, 'guidelines'));
      renameSync(guidelinesTmp, revDir);
      writeJson(join(revDir, 'revision.json'), revision);
    } else {
      rmSync(guidelinesTmp, { recursive: true, force: true });
    }
    guidelinesRevisionId = revision.id;
    record('guidelines', 'npm', npmRef, revision.contentHash, undefined, `${revision.pages.length} pages → revision ${revision.id}`);
    counts.guidelinePages = revision.pages.length;
    log(`  guidelines: ${revision.pages.length} pages, revision ${revision.id}${existsSync(revDir) ? '' : ' (new)'}`);
  } else {
    missing('guidelines', 'npm', 'no generated/guidelines/ in the tarball');
  }
  const guidelineIds = new Set(revision?.pages.filter((p) => p.scope === 'component').map((p) => p.id) ?? []);

  // 5. Catalog: types + shipped curation.
  const shipped = readShippedCatalog<ShippedCatalog>(tarball.dir);
  if (!shipped) missing('catalog', 'npm', 'no generated/components.json in the tarball (props still come from the types; status/stories/related unknown)');
  const merged = mergeCatalog(extracted, shipped, pkgMeta.name, (id) => guidelineIds.has(id));
  const catalog = { schemaVersion: 1 as const, package: pkgMeta.name, version, guidelinesRevision: guidelinesRevisionId, components: merged.components };
  writeJson(join(staging, 'components.json'), catalog);
  record('catalog', 'npm', npmRef, hashJson(catalog), undefined, shipped ? `merged with generated/components.json schema ${shipped.schemaVersion}` : 'types only');
  counts.components = merged.components.filter((c) => c.kind === 'component').length;
  counts.props = merged.components.reduce((n, c) => n + c.props.length, 0);
  log(`  catalog: ${counts.components} components, ${counts.props} props, ${merged.mismatches.length} mismatch(es) vs shipped catalog`);

  // 6. Tokens, icons, deprecations, changelog.
  const tokens = readTokens(tarball.dir);
  if (tokens) { writeJson(join(staging, 'tokens.json'), tokens); record('tokens', 'npm', npmRef, hashJson(tokens), undefined, `${tokens.tokens.length} tokens, ${tokens.contrastPairs} documented contrast pairs`); counts.tokens = tokens.tokens.length; counts.contrastPairs = tokens.contrastPairs; }
  else missing('tokens', 'npm', 'no dist/tokens.json');
  const icons = readIcons(tarball.dir);
  if (icons) { writeJson(join(staging, 'icons.json'), icons); record('icons', 'npm', npmRef, hashJson(icons), undefined, `${icons.icons.length} icons`); counts.icons = icons.icons.length; }
  else missing('icons', 'npm', 'no generated/icons.json');
  const deprecations = readDeprecations(tarball.dir);
  if (deprecations) { writeJson(join(staging, 'deprecations.json'), deprecations); record('deprecations', 'npm', npmRef, hashJson(deprecations), undefined, `${deprecations.deprecations.length} entries`); counts.deprecations = deprecations.deprecations.length; }
  else missing('deprecations', 'npm', 'no generated/deprecations.json');
  const changelog = readChangelog(tarball.dir);
  if (changelog) { const { writeFileSync } = await import('node:fs'); writeFileSync(join(staging, 'CHANGELOG.md'), changelog.text); writeJson(join(staging, 'changelog.json'), { entries: changelog.entries }); record('changelog', 'npm', npmRef, sha256(changelog.text), undefined, `${changelog.entries.length} releases`); counts.changelogEntries = changelog.entries.length; }
  else missing('changelog', 'npm', 'no CHANGELOG.md');
  log(`  package data: ${counts.tokens ?? 0} tokens (${counts.contrastPairs ?? 0} contrast pairs), ${counts.icons ?? 0} icons, ${counts.deprecations ?? 0} deprecations, ${counts.changelogEntries ?? 0} changelog entries`);

  // 7. Stories from the deployed Storybook.
  let stories: StoriesIndex | undefined;
  if (storybookUrl) {
    stories = await fetchStories(storybookUrl);
    if (stories) { writeJson(join(staging, 'stories.json'), stories); record('stories', 'storybook', stories.storybookUrl, stories.contentHash, `${stories.storybookUrl}index.json`, `${stories.stories.length} stories, ${stories.stories.filter((s) => s.hasPlay).length} with play functions`); counts.stories = stories.stories.length; counts.storiesWithPlay = stories.stories.filter((s) => s.hasPlay).length; log(`  stories: ${counts.stories} from ${stories.storybookUrl} (${counts.storiesWithPlay} with play)`); }
    else missing('stories', 'storybook', `${storybookUrl}index.json not reachable`);
  } else missing('stories', 'storybook', 'no Storybook URL (package has no homepage and DS_STORYBOOK_URL is unset)');

  // 8. Baselines from the GitHub release.
  const baselines = await fetchBaselines(version, join(staging, 'baselines'));
  if (baselines) { writeJson(join(staging, 'baselines', 'manifest.json'), baselines.manifest); record('baselines', 'github-release', config.tagFor(version), baselines.assetSha256, baselines.assetUrl, `${baselines.manifest.entries.length} screenshots at ${baselines.manifest.viewport?.width}×${baselines.manifest.viewport?.height}`); counts.baselines = baselines.manifest.entries.length; log(`  baselines: ${counts.baselines} screenshots from release ${config.tagFor(version)}`); }
  else missing('baselines', 'github-release', `no ${config.baselinesAssetFor(version)} on release ${config.tagFor(version)}`);

  // 9. Gaps: the maintenance queue (ds://{v}/gaps).
  const gaps = computeGaps(version, merged.components, merged.mismatches, stories, baselines?.manifest.entries.map((e) => e.storyId), extracted.unclassified);
  writeJson(join(staging, 'gaps.json'), gaps);
  log(`  gaps: ${Object.entries(gaps.summary).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);

  // 10. Manifest, validation, publish.
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    package: pkgMeta.name,
    version,
    ingestedAt: at,
    provenance,
    sourceRef: { tag: config.tagFor(version), commit: provenance.commit, tarball: v.dist.tarball, tarballSha256: tarball.sha256 },
    guidelinesRevision: guidelinesRevisionId,
    sources,
    counts,
    files: [],
  };
  manifest.files = listFiles(staging).filter((f) => !f.startsWith('.'));
  writeJson(join(staging, 'manifest.json'), manifest);
  validateSnapshot(staging, manifest);

  if (existsSync(finalDir)) rmSync(finalDir, { recursive: true, force: true });
  renameSync(staging, finalDir);
  const fresh = readIndex();
  fresh.versions[version] = { dir: version, ingestedAt: at, sourceRef: manifest.sourceRef, provenance: provenance.status, guidelinesRevision: guidelinesRevisionId, counts };
  fresh.latest = Object.keys(fresh.versions).sort(compareSemver).pop();
  fresh.updatedAt = at;
  writeJson(join(config.snapshotsDir, 'index.json'), fresh);
  log(`  published snapshots/${version} (latest: ${fresh.latest})`);
  return manifest;
}

// ---- validation (fail-closed) ---------------------------------------------------------------
function validateSnapshot(dir: string, manifest: SnapshotManifest): void {
  const must = (file: string): void => { if (!existsSync(join(dir, file))) throw new IngestError(`snapshot ${manifest.version}: missing ${file}`); };
  must('types.json');
  must('components.json');
  must('manifest.json');
  for (const f of manifest.files) if (f.endsWith('.json')) { try { readJson(join(dir, f)); } catch (err) { throw new IngestError(`snapshot ${manifest.version}: ${f} does not parse`, err); } }
  const catalog = readJson<{ components: CatalogComponent[] }>(join(dir, 'components.json'));
  for (const c of catalog.components) {
    if (c.guidelines && manifest.guidelinesRevision && !existsSync(join(config.snapshotsDir, 'guidelines', manifest.guidelinesRevision, c.guidelines.replace(/^guidelines\//, '')))) {
      throw new IngestError(`snapshot ${manifest.version}: ${c.id} references ${c.guidelines} which is not in revision ${manifest.guidelinesRevision}`);
    }
  }
  const baselines = readJsonIfExists<{ entries: Array<{ file: string }> }>(join(dir, 'baselines', 'manifest.json'));
  for (const e of baselines?.entries ?? []) must(join('baselines', e.file));
}

function computeGaps(version: string, components: CatalogComponent[], mismatches: CatalogMismatch[], stories: StoriesIndex | undefined, baselineIds: string[] | undefined, unclassified: string[]): GapsReport {
  const storyIds = new Set(stories?.stories.map((s) => s.id) ?? []);
  const baselineSet = new Set(baselineIds ?? []);
  const out: Gap[] = [];
  const notInStorybook: string[] = [];
  for (const c of components) {
    if (c.kind !== 'component') continue;
    const gaps: string[] = [];
    if (!c.stories.length) gaps.push('no-story');
    if (stories && c.stories.length && !c.stories.some((s) => storyIds.has(s.id))) gaps.push('story-ids-not-in-storybook');
    for (const s of c.stories) if (stories && !storyIds.has(s.id)) notInStorybook.push(s.id);
    if (baselineIds && c.stories.length && !c.stories.some((s) => baselineSet.has(s.id))) gaps.push('no-baseline');
    if (!c.guidelines) gaps.push('no-guideline');
    if (!c.a11yReviewed) gaps.push('a11y-not-reviewed');
    if (c.status === 'unlisted') gaps.push('not-in-package-catalog');
    if (gaps.length) out.push({ component: c.id, gaps });
  }
  const summary: Record<string, number> = {};
  for (const g of out) for (const k of g.gaps) summary[k] = (summary[k] ?? 0) + 1;
  if (mismatches.length) summary['catalog-mismatch'] = mismatches.length;
  return { version, summary, components: out, catalogMismatches: mismatches, storyIdsNotInStorybook: notInStorybook, unclassifiedExports: unclassified };
}

// ---- index helpers ----------------------------------------------------------------------------
export function readIndex(): SnapshotIndex {
  return readJsonIfExists<SnapshotIndex>(join(config.snapshotsDir, 'index.json')) ?? { schemaVersion: 1, package: config.packageName, updatedAt: nowIso(), versions: {} };
}

function latestGuidelineRevision(): GuidelinesRevision | undefined {
  const dir = join(config.snapshotsDir, 'guidelines');
  if (!existsSync(dir)) return undefined;
  const ids = readdirSync(dir).filter((d) => existsSync(join(dir, d, 'revision.json'))).sort();
  const last = ids[ids.length - 1];
  return last ? readJson<GuidelinesRevision>(join(dir, last, 'revision.json')) : undefined;
}

export function compareSemver(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  const pb = b.split(/[.-]/).map((x) => (Number.isNaN(Number(x)) ? x : Number(x)));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}
