// Download an npm tarball, verify its integrity, and extract it.
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as tar from 'tar';
import { config } from './config.js';
import { IngestError, ensureDir, fetchBuffer, sha256, sha512b64 } from './util.js';
import type { PackumentVersion } from './registry.js';

export interface ExtractedTarball {
  /** Directory containing the package contents (the tarball's `package/` folder). */
  dir: string;
  tarballUrl: string;
  sha256: string;
  integrity?: string;
  bytes: number;
}

export async function downloadAndExtract(v: PackumentVersion): Promise<ExtractedTarball> {
  const buf = await fetchBuffer(v.dist.tarball);
  if (!buf) throw new IngestError(`tarball ${v.dist.tarball} not found`);
  if (v.dist.integrity) {
    const [algo, expected] = v.dist.integrity.split('-', 2);
    if (algo === 'sha512' && sha512b64(buf) !== expected) throw new IngestError(`tarball integrity mismatch for ${v.version}`);
  }
  const target = join(config.tmpDir, 'packages', v.version);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  ensureDir(target);
  await tar.x({ file: await writeTemp(buf, v.version), cwd: target, strip: 1 });
  return { dir: target, tarballUrl: v.dist.tarball, sha256: sha256(buf), integrity: v.dist.integrity, bytes: buf.length };
}

/** Download and extract any .tgz (used for the baselines release asset). Returns the extraction dir. */
export async function downloadTgz(url: string, name: string, headers?: Record<string, string>): Promise<{ dir: string; sha256: string; bytes: number } | undefined> {
  const buf = await fetchBuffer(url, { optional: true, headers });
  if (!buf) return undefined;
  const target = join(config.tmpDir, 'assets', name);
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  ensureDir(target);
  await tar.x({ file: await writeTemp(buf, name), cwd: target });
  return { dir: target, sha256: sha256(buf), bytes: buf.length };
}

async function writeTemp(buf: Buffer, name: string): Promise<string> {
  const { writeFile } = await import('node:fs/promises');
  ensureDir(join(config.tmpDir, 'downloads'));
  const file = join(config.tmpDir, 'downloads', `${name.replace(/[^a-z0-9.-]/gi, '_')}.tgz`);
  await writeFile(file, buf);
  return file;
}
