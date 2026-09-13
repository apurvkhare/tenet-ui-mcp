// The machine-readable files the package ships next to its code: DTCG token registry (with
// documented contrast pairs), icon manifest, deprecation registry, changelog.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonIfExists } from '../util.js';

export interface PackageMeta {
  name: string;
  version: string;
  homepage?: string;
  repository?: { url?: string } | string;
  exports: string[];
  peerDependencies?: Record<string, string>;
}

export function readPackageMeta(dir: string): PackageMeta {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name: string; version: string; homepage?: string; repository?: PackageMeta['repository']; exports?: Record<string, unknown>; peerDependencies?: Record<string, string> };
  return { name: pkg.name, version: pkg.version, homepage: pkg.homepage, repository: pkg.repository, exports: Object.keys(pkg.exports ?? {}), peerDependencies: pkg.peerDependencies };
}

export interface TokenRecord {
  name: string;
  cssVar?: string;
  type?: string;
  path?: string[];
  description?: string;
  themed?: boolean;
  value?: unknown;
  light?: unknown;
  dark?: unknown;
  contrast?: Record<string, { aa?: string[]; aaLarge?: string[] } | string[]>;
  [k: string]: unknown;
}
export function readTokens(dir: string): { tokens: TokenRecord[]; contrastPairs: number } | undefined {
  const raw = readJsonIfExists<Record<string, TokenRecord> | TokenRecord[]>(join(dir, 'dist', 'tokens.json'));
  if (!raw) return undefined;
  const tokens = (Array.isArray(raw) ? raw : Object.values(raw)).map((t) => ({ ...t }));
  let contrastPairs = 0;
  for (const t of tokens) {
    for (const themePairs of Object.values(t.contrast ?? {})) {
      if (Array.isArray(themePairs)) contrastPairs += themePairs.length;
      else contrastPairs += (themePairs.aa?.length ?? 0) + (themePairs.aaLarge?.length ?? 0);
    }
  }
  return { tokens, contrastPairs };
}

export interface IconsManifest {
  schemaVersion?: number;
  source?: string;
  importPath?: string;
  sizes?: number[];
  icons: Array<{ name: string; component: string; source?: string; category?: string; keywords?: string[] }>;
}
export const readIcons = (dir: string): IconsManifest | undefined => readJsonIfExists<IconsManifest>(join(dir, 'generated', 'icons.json'));

export interface DeprecationsRegistry {
  schemaVersion?: number;
  package?: string;
  version?: string;
  deprecations: Array<{ kind: 'prop' | 'component' | string; component: string; prop?: string; replacement?: string; message?: string; since?: string }>;
}
export const readDeprecations = (dir: string): DeprecationsRegistry | undefined => readJsonIfExists<DeprecationsRegistry>(join(dir, 'generated', 'deprecations.json'));

export const readShippedCatalog = <T>(dir: string): T | undefined => readJsonIfExists<T>(join(dir, 'generated', 'components.json'));

export interface ChangelogEntry { version: string; date?: string; body: string }
export function readChangelog(dir: string): { text: string; entries: ChangelogEntry[] } | undefined {
  const file = join(dir, 'CHANGELOG.md');
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, 'utf8');
  const entries: ChangelogEntry[] = [];
  const re = /^##\s+\[?(\d+\.\d+\.\d+[^\]\s]*)\]?(?:[^\n]*?(\d{4}-\d{2}-\d{2}))?[^\n]*$/gm;
  const heads: Array<{ version: string; date?: string; start: number; end: number }> = [];
  for (let m = re.exec(text); m; m = re.exec(text)) heads.push({ version: m[1]!, date: m[2], start: m.index, end: m.index + m[0].length });
  heads.forEach((h, i) => entries.push({ version: h.version, date: h.date, body: text.slice(h.end, heads[i + 1]?.start ?? text.length).trim() }));
  return { text, entries };
}
