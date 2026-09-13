# tenet-ui-mcp

The design-to-code MCP server for the [tenet-ui](https://github.com/apurvkhare/tenet-ui) design system, built to the design in `mcp-masterclass/design/ds-mcp-server/DESIGN.md` (rev 3). The server supplies context and judgment; the agent writes the code and runs the checks.

Status: **step 1 of the build order, in progress.** The ingest pipeline is done; the catalog tools, transport and auth come next.

## What is here

```
src/ingest/            the data pipeline (DESIGN.md §10)
  cli.ts               npm run ingest -- <version|latest> | --new | --watch | --list
  registry.ts          npm packument, version resolution, provenance claim check
  tarball.ts           download, sha512 integrity, extract
  extract/types.ts     the published .d.ts → components, props, unions, @default, @deprecated (TypeScript compiler API)
  extract/catalog.ts   types + the package's own generated/components.json → one catalog, mismatches reported
  extract/stories.ts   the deployed Storybook's index.json
  extract/baselines.ts the baselines-vX.Y.Z.tgz release asset (downloaded, never rendered)
  extract/guidelines.ts generated/guidelines/**.md → a guidelines revision; docs-site llms.txt recorded alongside
  extract/package-data.ts tokens (+ contrast pairs), icons, deprecations, changelog
  snapshot.ts          assemble, validate fail-closed, publish into snapshots/index.json
snapshots/             one folder per ingested version + one per guidelines revision (committed; the server image carries them)
.github/workflows/     ci.yml · ingest.yml (repository_dispatch from tenet-ui's release, 6-hourly registry watch, manual)
```

## Ingest

```bash
npm ci
npm run ingest -- 0.4.0            # one version
npm run ingest -- latest
npm run ingest -- --new            # every registry version newer than the newest snapshot (the registry watch)
npm run ingest -- --list
```

Sources, in the order they are read, and what each yields:

| Source | Read from | Yields |
|---|---|---|
| Provenance | npm attestations endpoint | The SLSA statement must name `apurvkhare/tenet-ui`; the commit becomes `sourceRef.commit`. Refused otherwise (`--allow-unattested` for versions published before trusted publishing). Claim check only; signatures are not verified yet. |
| Types | `dist/index.d.ts` in the tarball | Every export: components, hooks, props with types, literal unions expanded, required flags, `@default`, `@deprecated`, compound members (`FormControl.Label`), local inheritance |
| Catalog | `generated/components.json` in the tarball | Status, `a11yReviewed`, story ids, related, subcomponent grouping. Merged with the types; every disagreement is listed in `gaps.json` |
| Guidelines | `generated/guidelines/**.md` in the tarball, plus the docs site's `llms.txt` / `llms-full.txt` | A guidelines revision `snapshots/guidelines/<date>-<hash>/`, sectioned per page. A revision with fewer pages than the previous one is refused. |
| Tokens, icons, deprecations, changelog | `dist/tokens.json`, `generated/icons.json`, `generated/deprecations.json`, `CHANGELOG.md` | The token registry with documented contrast pairs; the icon manifest; the migration registry; parsed releases |
| Stories | `<homepage>/storybook/index.json` | Story ids, titles, play-function tags |
| Baselines | `baselines-vX.Y.Z.tgz` on the GitHub release | 1280×800 screenshots per story per theme with a sha256 manifest |

Every snapshot carries a `manifest.json` listing each source with its `sourceRef`, content hash and `extractedAt`, and a `gaps.json` (typed components with no story, no baseline, no guideline, catalog mismatches). The version index is only updated after the whole snapshot validates. Missing sources fail the run unless named in `--allow-missing`.

Environment: `DS_PACKAGE`, `DS_REPOSITORY`, `DS_DOCS_URL`, `DS_STORYBOOK_URL`, `SNAPSHOTS_DIR`, `GITHUB_TOKEN` (release-asset download rate limit).

## Keeping it current

`ingest.yml` runs the same command on three triggers: a `repository_dispatch` of type `tenet-ui-released` from tenet-ui's release workflow (set `DS_MCP_REPO_TOKEN` there), a 6-hourly schedule that ingests anything new on the registry, and a manual run. A successful ingest commits the snapshot to `main`.

## Next

DESIGN.md §15: the five read-only catalog tools over these snapshots, `ds://` resources, Streamable HTTP with header validation, the built-in HS256 issuer with `AUTH_MODE=none`, structured output, spans. Then ingest → match → plan, then checks over the capture script's results, then audit and tests.
