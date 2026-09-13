# tenet-ui-mcp

The design-to-code MCP server for the [tenet-ui](https://github.com/apurvkhare/tenet-ui) design system, built to the design in `mcp-masterclass/design/ds-mcp-server/DESIGN.md` (rev 3). The server supplies context and judgment; the agent writes the code and runs the checks.

Status: **build order step 1 done** (ingest, catalog tools, resources, Streamable HTTP, self-hosted auth, structured output, telemetry). Next: ingest → match → plan (step 2).

## Run it

```bash
npm ci
npm run ingest -- latest                      # or use the committed snapshots/
AUTH_MODE=none npm start                      # http://127.0.0.1:3000/mcp, no auth (local rehearsal)
```

With the built-in issuer (DESIGN.md §9, self-hosted row):

```bash
export AUTH_HMAC_KEY="$(openssl rand -base64 48)"   # issuer secret, never a bearer credential
npm start                                           # AUTH_MODE defaults to hs256 when the key is set
npm run token -- --sub apurv --scope ds:read        # prints a bearer token for a client
```

Claude Code, Cursor or any Streamable HTTP client: endpoint `http://127.0.0.1:3000/mcp`, header `Authorization: Bearer <token>`. For a local stdio client: `npm run stdio`.

Environment: `PORT`, `HOST`, `PUBLIC_URL` (the `aud` of tokens and the resource in PRM), `AUTH_MODE` (`none` | `hs256`), `AUTH_HMAC_KEY`, `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` / `AUTH_CLIENT_SCOPES` (optional client-credentials client for CI at `POST /oauth/token`), `ALLOWED_ORIGINS`, `SNAPSHOTS_DIR`, `TELEMETRY=off`.

## What the server serves

**Tools** (all `ds:read`, read-only, idempotent; fixed order; `tools/list` stays under 7 KB; every tool returns `structuredContent` + a text summary + `resource_link`s + `_meta.traceId`):

| Tool | Cap | What it does |
|---|---|---|
| `search_components` | 2 KB | Ranked, synonym-aware search (dropdown → Select, Menu). Zero results return the five nearest names. |
| `get_component` | 8 KB (64 KB with `full`) | Import, props from the types with defaults and deprecations, subcomponents, stories, a11y, guidelines. `sections` scoping with requery hints. |
| `find_tokens` | 4 KB | Tokens by meaning or group, per theme, with documented AA contrast pairs. |
| `search_icons` | 2 KB | Icons by keyword with the exact import statement. |
| `resolve_value` | 4 KB | Nearest token for raw values: colours by ΔE in Lab against semantic tokens, dimensions by distance, with tolerance and alternatives. |

Every tool takes `dsVersion` (JSON schema carries `x-mcp-header: DsVersion`; a `DsVersion` request header is validated against the argument). Resolution: exact → newest patch of that minor → nearest earlier minor → latest of that major → latest, and the effective version is echoed in every result.

**Resources:** `ds://versions`, `ds://{v}/components/{name}` (markdown), `ds://{v}/tokens/{group}.json`, `ds://{v}/guidelines/{topic}` (the nine system pages, any component id, `contract`, `audit-rules`), `ds://{v}/gaps`, `ds://{v}/changelog`, `ds://{v}/deprecations`.

**Discovery:** `GET /healthz`, `GET /.well-known/oauth-protected-resource`, `GET /.well-known/oauth-authorization-server`. No token → `401` with `WWW-Authenticate: Bearer resource_metadata=…`; missing scope → one `403 insufficient_scope` naming every missing scope.

**Telemetry:** one JSON line per request / tool call / resource read on stderr with a W3C trace id (from the `traceparent` header when the client sends one; echoed back). Names, durations, statuses, versions, byte counts. Never arguments or findings.

## Protocol note

`@modelcontextprotocol/sdk` 1.30 implements MCP **2025-11-25**: initialize handshake, `tools/list`, structured output, resource templates, Tasks. The stateless, no-handshake `server/discover` and MRTR elicitation that DESIGN.md §8 describes for the 2026-07-28 revision are not in the SDK yet. The server is stateless today (one `McpServer` per request, no session id), so the handshake is a formality and the move is contained in `src/http.ts`.

## Layout

```
src/ingest/            the data pipeline (DESIGN.md §10) — see below
src/catalog/store.ts   snapshot reads + dsVersion resolution
src/catalog/resolve.ts nearest-token resolution (ΔE / distance)
src/catalog/synonyms.ts what people call components and token groups
src/tools/             the five tools as plain functions (unit-tested without a transport)
src/resources.ts       ds:// resources
src/server.ts          McpServer factory: registration order, structured output, _meta, telemetry
src/http.ts            Streamable HTTP: Origin, bearer, scopes, PRM, AS metadata, client credentials
src/auth/tokens.ts     HS256 issuer + verifier (jose); src/auth/cli.ts mints tokens
src/content/           the component contract and audit rule catalog (ds://…/guidelines/contract, audit-rules)
snapshots/             one folder per ingested version + one per guidelines revision (committed)
.github/workflows/     ci.yml · ingest.yml
Dockerfile             single container, no browser
```

## Ingest

```bash
npm run ingest -- 0.4.0            # one version
npm run ingest -- --new            # every registry version newer than the newest snapshot (the registry watch)
npm run ingest -- --list
```

| Source | Read from | Yields |
|---|---|---|
| Provenance | npm attestations endpoint | The SLSA statement must name `apurvkhare/tenet-ui`; the commit becomes `sourceRef.commit`. Refused otherwise (`--allow-unattested` for versions published before trusted publishing). Claim check only; signatures are not verified yet. |
| Types | `dist/index.d.ts` in the tarball | Every export: components, hooks, props with types, literal unions expanded, required flags, `@default`, `@deprecated`, compound members (`FormControl.Label`), local inheritance |
| Catalog | `generated/components.json` in the tarball | Status, `a11yReviewed`, story ids, related, subcomponent grouping. Merged with the types; every disagreement is listed in `gaps.json` |
| Guidelines | `generated/guidelines/**.md` in the tarball, plus the docs site's `llms.txt` / `llms-full.txt` | A guidelines revision `snapshots/guidelines/<date>-<hash>/`, sectioned per page. A revision with fewer pages than the previous one is refused. |
| Tokens, icons, deprecations, changelog | `dist/tokens.json`, `generated/icons.json`, `generated/deprecations.json`, `CHANGELOG.md` | The token registry with documented contrast pairs; the icon manifest; the migration registry; parsed releases |
| Stories | `<homepage>/storybook/index.json` | Story ids, titles, play-function tags |
| Baselines | `baselines-vX.Y.Z.tgz` on the GitHub release | 1280×800 screenshots per story per theme with a sha256 manifest |

Every snapshot carries a `manifest.json` (each source with `sourceRef`, content hash, `extractedAt`) and a `gaps.json`. The version index is only updated after the whole snapshot validates. `ingest.yml` runs on `repository_dispatch: tenet-ui-released` from tenet-ui's release workflow, on a 6-hourly schedule, and by hand, and commits new snapshots.

## Next

DESIGN.md §15 step 2: `ingest_design` (vision call constrained to the catalog vocabulary, or a host-supplied layout), the design store and handles, `match_components` with the first elicitation, `plan_component`. Then step 3 (`resolve_tokens`, `run_checks` over the capture script's `results.json`) and step 4 (`audit_code`, `audit_page`, `plan_tests`, hooks).
