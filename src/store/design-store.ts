// The design store (DESIGN.md §3): the only mutable state. Rows are keyed by the caller's `sub`
// and expire after 24 h. Another principal gets not-found, never forbidden. File-backed so one
// container needs nothing else; the Worker (src/worker/kv-design-store.ts) implements the same
// DesignRows interface on Workers KV.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type RowKind = 'design' | 'match' | 'plan' | 'audit';
const PREFIX: Record<RowKind, string> = { design: 'dsg', match: 'mtc', plan: 'pln', audit: 'aud' };

export interface Row<T> {
  id: string;
  kind: RowKind;
  sub: string;
  createdAt: string;
  expiresAt: string;
  data: T;
}

/** What the tools and resources use. Async so a remote store (Workers KV) can sit behind it. */
export interface DesignRows {
  create<T>(kind: RowKind, sub: string, data: T): Promise<Row<T>>;
  update<T>(row: Row<T>, data: T): Promise<Row<T>>;
  /** Not-found for another principal's row, an unknown id, or an expired row. */
  get<T>(kind: RowKind, sub: string, id: string): Promise<Row<T> | undefined>;
  putBlob(sub: string, id: string, name: string, bytes: Buffer): Promise<void>;
  getBlob(sub: string, id: string, name: string): Promise<Buffer | undefined>;
}

export const ROW_PREFIX = PREFIX;
/** Row ids are `<prefix>_<24 hex>`; anything else is not-found without touching storage. */
export const isRowId = (kind: RowKind, id: string): boolean => /^[a-z]{3}_[0-9a-f]{24}$/.test(id) && id.startsWith(PREFIX[kind]);
export const newRowId = (kind: RowKind): string => `${PREFIX[kind]}_${randomBytes(12).toString('hex')}`;

export class DesignStore implements DesignRows {
  constructor(readonly dir: string, readonly ttlMs = 24 * 60 * 60 * 1000) {
    mkdirSync(dir, { recursive: true });
  }

  private subDir(sub: string): string {
    return join(this.dir, createHash('sha256').update(sub).digest('hex').slice(0, 24));
  }

  async create<T>(kind: RowKind, sub: string, data: T): Promise<Row<T>> {
    const id = newRowId(kind);
    const now = Date.now();
    const row: Row<T> = { id, kind, sub, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString(), data };
    this.write(row);
    return row;
  }

  async update<T>(row: Row<T>, data: T): Promise<Row<T>> {
    const next = { ...row, data };
    this.write(next);
    return next;
  }

  async get<T>(kind: RowKind, sub: string, id: string): Promise<Row<T> | undefined> {
    if (!isRowId(kind, id)) return undefined;
    const file = join(this.subDir(sub), `${id}.json`);
    if (!existsSync(file)) return undefined;
    const row = JSON.parse(readFileSync(file, 'utf8')) as Row<T>;
    if (row.sub !== sub || row.kind !== kind) return undefined;
    if (Date.parse(row.expiresAt) < Date.now()) { rmSync(file, { force: true }); return undefined; }
    return row;
  }

  async putBlob(sub: string, id: string, name: string, bytes: Buffer): Promise<void> {
    const d = join(this.subDir(sub), id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, name), bytes);
  }

  async getBlob(sub: string, id: string, name: string): Promise<Buffer | undefined> {
    const file = join(this.subDir(sub), id, name.replace(/[^a-z0-9._-]/gi, '_'));
    return existsSync(file) ? readFileSync(file) : undefined;
  }

  /** Remove expired rows and their blobs. Cheap enough to run on a timer. */
  purge(): number {
    let removed = 0;
    if (!existsSync(this.dir)) return 0;
    for (const subDir of readdirSync(this.dir)) {
      const d = join(this.dir, subDir);
      if (!statSync(d).isDirectory()) continue;
      for (const name of readdirSync(d)) {
        if (!name.endsWith('.json')) continue;
        try {
          const row = JSON.parse(readFileSync(join(d, name), 'utf8')) as Row<unknown>;
          if (Date.parse(row.expiresAt) < Date.now()) { rmSync(join(d, name), { force: true }); rmSync(join(d, row.id), { recursive: true, force: true }); removed++; }
        } catch { rmSync(join(d, name), { force: true }); removed++; }
      }
    }
    return removed;
  }

  private write(row: Row<unknown>): void {
    const d = this.subDir(row.sub);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, `${row.id}.json`), JSON.stringify(row));
  }
}
