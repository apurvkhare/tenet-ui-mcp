// The design store on Workers KV: same rows, same principal binding, same 24 h life as the file
// store (src/store/design-store.ts), with KV's own expiry doing the purge. Keys start with a hash
// of the caller's `sub`, so another principal's id is simply a missing key: not-found, never forbidden.
import { isRowId, newRowId, type DesignRows, type Row, type RowKind } from '../store/design-store.js';

export class KvDesignStore implements DesignRows {
  constructor(private readonly kv: KVNamespace, readonly ttlMs = 24 * 60 * 60 * 1000) {}

  private async prefix(sub: string): Promise<string> {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sub));
    return [...new Uint8Array(digest)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /** Seconds left before the row expires; KV refuses anything under 60. */
  private ttlFor(expiresAt: string): number {
    return Math.max(60, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
  }

  async create<T>(kind: RowKind, sub: string, data: T): Promise<Row<T>> {
    const now = Date.now();
    const row: Row<T> = { id: newRowId(kind), kind, sub, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + this.ttlMs).toISOString(), data };
    await this.write(row);
    return row;
  }

  async update<T>(row: Row<T>, data: T): Promise<Row<T>> {
    const next = { ...row, data };
    await this.write(next);
    return next;
  }

  async get<T>(kind: RowKind, sub: string, id: string): Promise<Row<T> | undefined> {
    if (!isRowId(kind, id)) return undefined;
    const row = await this.kv.get<Row<T>>(`${await this.prefix(sub)}/${id}`, 'json');
    if (!row || row.sub !== sub || row.kind !== kind) return undefined;
    if (Date.parse(row.expiresAt) < Date.now()) return undefined;
    return row;
  }

  async putBlob(sub: string, id: string, name: string, bytes: Buffer): Promise<void> {
    // A blob lives as long as a fresh row would; it is only reachable through its row.
    // A plain ArrayBuffer of exactly these bytes: KV does not take a Node Buffer view as-is.
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    await this.kv.put(`${await this.prefix(sub)}/${id}/${name}`, body, { expirationTtl: Math.ceil(this.ttlMs / 1000) });
  }

  async getBlob(sub: string, id: string, name: string): Promise<Buffer | undefined> {
    const buf = await this.kv.get(`${await this.prefix(sub)}/${id}/${name.replace(/[^a-z0-9._-]/gi, '_')}`, 'arrayBuffer');
    return buf ? Buffer.from(buf) : undefined;
  }

  private async write(row: Row<unknown>): Promise<void> {
    await this.kv.put(`${await this.prefix(row.sub)}/${row.id}`, JSON.stringify(row), { expirationTtl: this.ttlFor(row.expiresAt) });
  }
}
