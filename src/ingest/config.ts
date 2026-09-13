// Ingest configuration. Everything about *where* tenet-ui is published lives here; the pipeline
// itself is generic over these values (DESIGN.md §10).
import { resolve } from 'node:path';

export const config = {
  /** npm package the server serves. */
  packageName: process.env.DS_PACKAGE ?? 'tenet-ui',
  /** GitHub repository the package must be attested to come from (provenance check). */
  repository: process.env.DS_REPOSITORY ?? 'apurvkhare/tenet-ui',
  registry: process.env.NPM_REGISTRY ?? 'https://registry.npmjs.org',
  /** Docs site; the Storybook lives under /storybook/. Falls back to the package's `homepage`. */
  docsUrl: process.env.DS_DOCS_URL,
  storybookUrl: process.env.DS_STORYBOOK_URL,
  /** Where snapshots are written. Committed to this repo so the server image carries them. */
  snapshotsDir: resolve(process.env.SNAPSHOTS_DIR ?? 'snapshots'),
  /** Scratch space for downloads. */
  tmpDir: resolve(process.env.INGEST_TMP_DIR ?? '.tmp'),
  /** Optional GitHub token for release-asset downloads (raises the API rate limit). */
  githubToken: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
  /** Expected tag format for a version. */
  tagFor: (version: string): string => `v${version}`,
  /** Release asset that carries the story baselines. */
  baselinesAssetFor: (version: string): string => `baselines-v${version}.tgz`,
} as const;
