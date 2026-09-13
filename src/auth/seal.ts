// `requestState` sealing (DESIGN.md §8, §12): an AEAD blob holding the principal, a ten-minute
// expiry, a digest of the original arguments and the partial result. The same secret that signs
// tokens derives the sealing key; in AUTH_MODE=none a per-process random key is used.
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export interface SealedPayload<T = unknown> {
  sub: string;
  /** epoch ms */
  exp: number;
  argsDigest: string;
  kind: string;
  state: T;
}

export class SealError extends Error {
  constructor(message: string) { super(message); this.name = 'SealError'; }
}

export function sealingKey(secret: string | undefined): Buffer {
  return createHash('sha256').update(secret ?? randomBytes(32).toString('hex')).update(':requestState:v1').digest();
}

export const argsDigest = (args: unknown): string => createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 32);

export function seal<T>(key: Buffer, payload: SealedPayload<T>): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${Buffer.concat([iv, tag, body]).toString('base64url')}`;
}

export function unseal<T>(key: Buffer, token: string, expect: { sub: string; kind: string; argsDigest?: string }): SealedPayload<T> {
  if (!token.startsWith('v1.')) throw new SealError('requestState: unknown format');
  let raw: Buffer;
  try { raw = Buffer.from(token.slice(3), 'base64url'); } catch { throw new SealError('requestState: not decodable'); }
  if (raw.length < 12 + 16 + 2) throw new SealError('requestState: too short');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const body = raw.subarray(28);
  let payload: SealedPayload<T>;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    payload = JSON.parse(Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8')) as SealedPayload<T>;
  } catch {
    throw new SealError('requestState: seal verification failed (tampered, or issued by another server)');
  }
  if (payload.kind !== expect.kind) throw new SealError(`requestState: issued for ${payload.kind}, not ${expect.kind}`);
  if (payload.sub !== expect.sub) throw new SealError('requestState: not found'); // another principal: not-found, never forbidden
  if (payload.exp < Date.now()) throw new SealError('requestState: expired (10 minutes); call the tool again without it');
  if (expect.argsDigest && payload.argsDigest !== expect.argsDigest) throw new SealError('requestState: the original arguments changed; retry with the same arguments plus inputResponses');
  return payload;
}
