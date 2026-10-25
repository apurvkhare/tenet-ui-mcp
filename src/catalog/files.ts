// Where the read side gets snapshot files and the server's own content pages. On Node they are
// files on disk; on Cloudflare Workers (src/worker/) there is no disk, so the text files are
// bundled into the Worker and the baseline PNGs are fetched from its static assets. Paths are
// relative to the snapshots root, '/'-separated.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface SnapshotFiles {
  /** A text file's content, or undefined when it does not exist. */
  text(path: string): string | undefined;
  /** Names of the entries directly under `dir`. */
  list(dir: string): string[];
  /** Changes when the file changes (the ingest job rewrites index.json); undefined when absent. */
  stamp(path: string): number | undefined;
  /** A binary file (story baselines), or undefined when it does not exist. */
  bytes(path: string): Promise<Uint8Array | undefined>;
}

export function diskFiles(root: string): SnapshotFiles {
  const abs = (p: string): string => join(root, p);
  return {
    text: (p) => (existsSync(abs(p)) ? readFileSync(abs(p), 'utf8') : undefined),
    list: (dir) => (existsSync(abs(dir)) ? readdirSync(abs(dir)) : []),
    stamp: (p) => (existsSync(abs(p)) ? statSync(abs(p)).mtimeMs : undefined),
    bytes: async (p) => (existsSync(abs(p)) ? readFileSync(abs(p)) : undefined),
  };
}

/** Text files held in memory (keyed by relative path), binaries from a loader. Never changes. */
export function memoryFiles(texts: Record<string, string>, bytes: (path: string) => Promise<Uint8Array | undefined>): SnapshotFiles {
  return {
    text: (p) => texts[p],
    list: (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      return [...new Set(Object.keys(texts).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0]!))];
    },
    stamp: (p) => (p in texts ? 0 : undefined),
    bytes,
  };
}

// The server's own pages (src/content/*.md: the component contract and the audit rule catalog).
// Node reads them next to this module; the Worker registers the copies it bundled.
let contentSource: (name: string) => string | undefined = (name) => {
  const url = new URL(`../content/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, 'utf8') : undefined;
};

export function setContentSource(source: (name: string) => string | undefined): void {
  contentSource = source;
}

export function contentText(name: string): string | undefined {
  return contentSource(name);
}
