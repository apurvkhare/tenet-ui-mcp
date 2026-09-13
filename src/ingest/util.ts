import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

export class IngestError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = 'IngestError';
  }
}

export const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
export const sha512b64 = (data: Buffer): string => createHash('sha512').update(data).digest('base64');

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function writeJson(file: string, value: unknown): void {
  ensureDir(dirname(file));
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function readJson<T = unknown>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function readJsonIfExists<T = unknown>(file: string): T | undefined {
  return existsSync(file) ? readJson<T>(file) : undefined;
}

/** Stable hash of a JSON value (key order independent). */
export function hashJson(value: unknown): string {
  return sha256(canonical(value));
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** All files under `dir`, as paths relative to it (posix separators), sorted. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out.sort();
}

/** Hash of a directory's contents (paths + bytes). */
export function hashDir(dir: string): string {
  const h = createHash('sha256');
  for (const f of listFiles(dir)) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex');
}

const UA = 'tenet-ui-mcp-ingest/0.1 (+https://github.com/apurvkhare/tenet-ui-mcp)';

export interface FetchOptions {
  headers?: Record<string, string>;
  /** Return undefined instead of throwing on 404. */
  optional?: boolean;
  retries?: number;
}

export async function fetchBuffer(url: string, opts: FetchOptions = {}): Promise<Buffer | undefined> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, ...opts.headers }, redirect: 'follow' });
      if (res.status === 404 && opts.optional) return undefined;
      if (!res.ok) throw new IngestError(`GET ${url} → ${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new IngestError(`GET ${url} failed`, lastErr);
}

export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string | undefined> {
  const buf = await fetchBuffer(url, opts);
  return buf?.toString('utf8');
}

export async function fetchJson<T = unknown>(url: string, opts: FetchOptions = {}): Promise<T | undefined> {
  const text = await fetchText(url, { ...opts, headers: { accept: 'application/json', ...opts.headers } });
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new IngestError(`GET ${url}: response is not JSON`, err);
  }
}

export const nowIso = (): string => new Date().toISOString();

/** Minimal markdown frontmatter parser (--- yaml ---), enough for the guideline pages. */
export function parseFrontmatter(md: string): { data: Record<string, unknown>; content: string } {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, content: md };
  const data: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value: unknown = rawValue!.trim();
    if (typeof value === 'string') {
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      } else if (/^['"].*['"]$/.test(value)) {
        value = value.slice(1, -1);
      } else if (value === 'true' || value === 'false') {
        value = value === 'true';
      }
    }
    data[key!] = value;
  }
  return { data, content: md.slice(m[0].length) };
}

/** Split markdown into sections by heading; the preamble (before the first heading) is section "". */
export function splitSections(md: string): Array<{ heading: string; level: number; body: string }> {
  const lines = md.split(/\r?\n/);
  const sections: Array<{ heading: string; level: number; body: string[] }> = [{ heading: '', level: 0, body: [] }];
  let inFence = false;
  for (const line of lines) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence && line.match(/^(#{1,6})\s+(.*)$/);
    if (h) sections.push({ heading: h[2]!.trim(), level: h[1]!.length, body: [] });
    else sections[sections.length - 1]!.body.push(line);
  }
  return sections
    .map((s) => ({ heading: s.heading, level: s.level, body: s.body.join('\n').trim() }))
    .filter((s) => s.heading || s.body);
}
