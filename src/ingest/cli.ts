#!/usr/bin/env node
// tenet-ui-mcp ingest: build a version snapshot of the design system from its published artifacts.
//
//   npm run ingest -- <version|latest> [--force] [--allow-unattested] [--allow-missing a,b] [--allow-fewer-guidelines]
//   npm run ingest -- --list                 versions in the snapshot index
//   npm run ingest -- --new                  one pass of the registry watch: ingest every version newer than the newest snapshot
//   npm run ingest -- --watch [seconds]      keep polling the npm registry (default 300 s)
//
// Triggers in production (DESIGN.md §10): the registry watch (this --watch loop or the scheduled
// workflow), the design system's release workflow (`repository_dispatch: tenet-ui-released`), and
// the docs deploy webhook. All of them run this same idempotent command.
import { config } from './config.js';
import { fetchPackument } from './registry.js';
import { compareSemver, ingestVersion, readIndex } from './snapshot.js';
import { IngestError } from './util.js';

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const value = (name: string): string | undefined => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; };
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && ['--allow-missing', '--watch'].includes(argv[i - 1]!) && !a.startsWith('--')) );

const opts = {
  allowMissing: new Set((value('allow-missing') ?? '').split(',').map((s) => s.trim()).filter(Boolean)),
  allowUnattested: flag('allow-unattested'),
  allowFewerGuidelines: flag('allow-fewer-guidelines'),
  force: flag('force'),
  log: (m: string) => console.log(m),
};

async function main(): Promise<void> {
  if (flag('list')) {
    const index = readIndex();
    const versions = Object.keys(index.versions).sort(compareSemver);
    if (!versions.length) { console.log(`no snapshots in ${config.snapshotsDir}`); return; }
    for (const v of versions) {
      const e = index.versions[v]!;
      console.log(`${v.padEnd(10)} ${e.ingestedAt}  provenance ${e.provenance.padEnd(14)} guidelines ${e.guidelinesRevision ?? '-'}  ${Object.entries(e.counts).map(([k, n]) => `${k}=${n}`).join(' ')}${index.latest === v ? '  (latest)' : ''}`);
    }
    return;
  }
  if (flag('new')) {
    await ingestNew();
    return;
  }
  if (flag('watch')) {
    const seconds = Number(value('watch')) || 300;
    console.log(`watching ${config.registry}/${config.packageName} every ${seconds}s (Ctrl-C to stop)`);
    for (;;) {
      await ingestNew();
      await new Promise((r) => setTimeout(r, seconds * 1000));
    }
  }
  const spec = positional[0];
  if (!spec) {
    console.error('usage: ingest <version|latest> [--force] [--allow-unattested] [--allow-missing a,b] [--allow-fewer-guidelines] | --list | --new | --watch [seconds]');
    process.exit(2);
  }
  await ingestVersion(spec, opts);
}

/** Ingest every registry version newer than the newest snapshot (the registry-watch trigger). */
async function ingestNew(): Promise<void> {
  const index = readIndex();
  const have = new Set(Object.keys(index.versions));
  const packument = await fetchPackument();
  const newest = Object.keys(index.versions).sort(compareSemver).pop();
  const candidates = Object.keys(packument.versions).filter((v) => !have.has(v) && (!newest || compareSemver(v, newest) > 0)).sort(compareSemver);
  if (!candidates.length) { console.log(`${new Date().toISOString()} nothing new (latest ${packument['dist-tags'].latest})`); return; }
  for (const v of candidates) {
    try { await ingestVersion(v, opts); }
    catch (err) { console.error(`${v}: ${err instanceof IngestError ? err.message : String(err)}`); }
  }
}

main().catch((err) => {
  console.error(err instanceof IngestError ? `ingest: ${err.message}` : err);
  process.exit(1);
});
