// Baselines adapter: the per-story screenshots the design system attaches to each GitHub release
// (`baselines-vX.Y.Z.tgz`, built by its own CI at 1280×800, light and dark). Downloaded, never
// rendered here (DESIGN.md rev 3).
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { downloadTgz } from '../tarball.js';
import { IngestError, ensureDir, fetchJson, readJson } from '../util.js';

export interface BaselineEntry {
  storyId: string;
  component: string;
  name: string;
  importPath?: string;
  theme: string;
  file: string;
  sha256: string;
  hasPlay?: boolean;
}
export interface BaselinesManifest {
  storybookVersion?: string;
  dsVersion?: string;
  viewport?: { width: number; height: number };
  themes?: string[];
  generatedAt?: string;
  entries: BaselineEntry[];
}
export interface BaselinesResult {
  manifest: BaselinesManifest;
  assetUrl: string;
  assetSha256: string;
  assetBytes: number;
  /** Directory the PNGs were copied into. */
  dir: string;
}

interface Release { tag_name: string; html_url: string; assets: Array<{ name: string; browser_download_url: string; size: number }> }

export async function fetchBaselines(version: string, targetDir: string): Promise<BaselinesResult | undefined> {
  const tag = config.tagFor(version);
  const headers: Record<string, string> = config.githubToken ? { authorization: `Bearer ${config.githubToken}` } : {};
  const release = await fetchJson<Release>(`https://api.github.com/repos/${config.repository}/releases/tags/${tag}`, { optional: true, headers });
  if (!release) return undefined;
  const asset = release.assets.find((a) => a.name === config.baselinesAssetFor(version));
  if (!asset) return undefined;

  const dl = await downloadTgz(asset.browser_download_url, `baselines-${version}`, headers);
  if (!dl) return undefined;
  const root = findManifestDir(dl.dir);
  if (!root) throw new IngestError(`${asset.name}: no manifest.json inside the archive`);
  const manifest = readJson<BaselinesManifest>(join(root, 'manifest.json'));
  if (!Array.isArray(manifest.entries)) throw new IngestError(`${asset.name}: manifest.json has no entries[]`);

  ensureDir(targetDir);
  for (const e of manifest.entries) {
    const src = join(root, e.file);
    if (!existsSync(src)) throw new IngestError(`${asset.name}: manifest references missing file ${e.file}`);
    copyFileSync(src, join(targetDir, e.file));
  }
  return { manifest, assetUrl: asset.browser_download_url, assetSha256: dl.sha256, assetBytes: dl.bytes, dir: targetDir };
}

function findManifestDir(dir: string): string | undefined {
  if (existsSync(join(dir, 'manifest.json'))) return dir;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const found = findManifestDir(p);
      if (found) return found;
    }
  }
  return undefined;
}
