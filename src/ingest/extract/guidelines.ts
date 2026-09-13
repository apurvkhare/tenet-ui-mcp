// Guidelines adapters, in the preference order of DESIGN.md §10: markdown in the package (the git
// adapter's equivalent — tenet-ui ships `generated/guidelines/` in the tarball), then the docs
// site's `llms.txt`. A guidelines *revision* is keyed by date + content hash and can move without
// a package release; the version snapshot records which revision it was validated against.
import { copyFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, fetchText, hashDir, parseFrontmatter, sha256, splitSections } from '../util.js';

export interface GuidelinePage {
  id: string;
  scope: 'component' | 'system';
  /** Path inside the revision directory. */
  file: string;
  title: string;
  frontmatter: Record<string, unknown>;
  updated?: string;
  related: string[];
  sections: Array<{ heading: string; level: number; body: string }>;
  contentHash: string;
  bytes: number;
}
export interface GuidelinesRevision {
  id: string;
  date: string;
  contentHash: string;
  adapter: 'package-markdown';
  pages: GuidelinePage[];
  llms?: LlmsSnapshot;
}
export interface LlmsSnapshot {
  url: string;
  indexHash: string;
  fullHash?: string;
  fullBytes?: number;
  pageCount?: number;
  file?: string;
}

/** Read `generated/guidelines/**.md` from the extracted package into `targetDir`; returns the revision. */
export function readPackageGuidelines(packageDir: string, targetDir: string, date: string): GuidelinesRevision | undefined {
  const src = join(packageDir, 'generated', 'guidelines');
  if (!existsSync(src)) return undefined;
  const pages: GuidelinePage[] = [];
  const read = (dir: string, scope: GuidelinePage['scope'], prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue;
      const md = readFileSync(join(dir, name), 'utf8');
      const { data, content } = parseFrontmatter(md);
      const title = content.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? name.replace(/\.md$/, '');
      const file = `${prefix}${name}`;
      ensureDir(join(targetDir, prefix));
      copyFileSync(join(dir, name), join(targetDir, file));
      pages.push({
        id: name.replace(/\.md$/, ''),
        scope,
        file,
        title,
        frontmatter: data,
        updated: typeof data.updated === 'string' ? data.updated : undefined,
        related: Array.isArray(data.related) ? (data.related as string[]) : [],
        sections: splitSections(content),
        contentHash: sha256(md),
        bytes: Buffer.byteLength(md),
      });
    }
  };
  read(src, 'component', '');
  read(join(src, 'system'), 'system', 'system/');
  if (!pages.length) return undefined;
  const contentHash = hashDir(src);
  return { id: `${date}-${contentHash.slice(0, 8)}`, date, contentHash, adapter: 'package-markdown', pages };
}

/** Record the docs site's llms.txt family (index + full) with hashes; stores llms-full.txt in the revision. */
export async function fetchLlms(docsUrl: string, targetDir: string): Promise<LlmsSnapshot | undefined> {
  const base = docsUrl.endsWith('/') ? docsUrl : `${docsUrl}/`;
  const index = await fetchText(`${base}llms.txt`, { optional: true });
  if (index === undefined) return undefined;
  const snap: LlmsSnapshot = { url: `${base}llms.txt`, indexHash: sha256(index) };
  const full = await fetchText(`${base}llms-full.txt`, { optional: true });
  if (full !== undefined) {
    ensureDir(targetDir);
    const file = 'llms-full.txt';
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(targetDir, file), full);
    snap.fullHash = sha256(full);
    snap.fullBytes = Buffer.byteLength(full);
    snap.pageCount = (full.match(/^# /gm) ?? []).length;
    snap.file = file;
  }
  return snap;
}
