# tenet-ui-mcp

The design-to-code MCP server for the [tenet-ui](https://github.com/apurvkhare/tenet-ui) design system, built to the design in `mcp-masterclass/design/ds-mcp-server/DESIGN.md` (rev 4). The server supplies context and judgment; the agent writes the code and runs the checks. The server never asks the user anything: it decides and explains.

Status: **build order steps 1 to 4 done**, on MCP 2026-07-28 with the TypeScript SDK v2: ingest pipeline, five catalog tools, resources, Streamable HTTP with self-hosted auth, path one (ingest_design → match_components → resolve_tokens → plan_component) with the server deciding close matches and off-scale values, `run_checks` judging the capture script's results, path two (`audit_code`, `audit_page`), `plan_tests`, the three prompts, the hooks plugin and the first dashboard. The talk needs these four. Step 5 (Figma) is dropped: no Figma source exists for tenet-ui. Next: step 6, the eval harness, the skill moved into the plugin, external OAuth.

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

Environment: `PORT`, `HOST`, `PUBLIC_URL` (the `aud` of tokens and the resource in PRM), `AUTH_MODE` (`none` | `hs256`), `AUTH_HMAC_KEY`, `AUTH_CLIENT_ID` / `AUTH_CLIENT_SECRET` / `AUTH_CLIENT_SCOPES` (optional client-credentials client for CI at `POST /oauth/token`), `ALLOWED_ORIGINS`, `SNAPSHOTS_DIR`, `DATA_DIR` (design store + event spool, default `.data/`), `TELEMETRY=off`.

Dashboard: `GET /dashboard` (HTML) and `GET /metrics.json?days=7`, bearer-authenticated (header or `?token=`), read the event spool the server writes for its own calls and the companion plugin posts to `POST /events`.

## What the server serves

**Catalog tools** (`ds:read`, read-only, idempotent; fixed order; every tool returns `structuredContent` + a text summary + `resource_link`s + `_meta.traceId`):

| Tool | Cap | What it does |
|---|---|---|
| `search_components` | 2 KB | Ranked, synonym-aware search (dropdown → Select, Menu). Zero results return the five nearest names. |
| `get_component` | 8 KB (64 KB with `full`) | Import, props from the types with defaults and deprecations, subcomponents, stories, a11y, guidelines. `sections` scoping with requery hints. |
| `find_tokens` | 4 KB | Tokens by meaning or group, per theme, with documented AA contrast pairs. |
| `search_icons` | 2 KB | Icons by keyword with the exact import statement. |
| `resolve_value` | 4 KB | Nearest token for raw values: colours by ΔE in Lab against semantic tokens, dimensions by distance, with tolerance and alternatives. |

Every tool takes `dsVersion`. Its JSON schema carries `x-mcp-header: DsVersion`, so a 2026-07-28 client mirrors it as the `Mcp-Param-DsVersion` request header and the SDK checks the header against the argument: a mismatch or a missing header is `400` with JSON-RPC error `-32020`. Resolution: exact → newest patch of that minor → nearest earlier minor → latest of that major → latest, and the effective version is echoed in every result.

**Path one, design to code** (`design:ingest`; DESIGN.md §4):

| Tool | Cap | What it does |
|---|---|---|
| `ingest_design` | 6 KB | A screenshot (≤ 5 MB PNG/JPEG/WebP/GIF, sniffed) goes to the vision model with a fixed template and an output schema in the catalog's vocabulary; or the host passes a `layout` tree and no model is called. Stores the design; returns `designId`. |
| `match_components` | 8 KB | Ranks catalog components per region (role and label synonyms, the analyser's candidates, structural cues such as icon-only, bordered vs plain containers, children) and records confidence. Where the top two are within 0.15 it decides with the guideline test for that pair (Card or plain section, Tag or Badge, Menu or Select, Tabs or SegmentedControl, Banner or Toast, Button or Link, and others) and returns the pick with the rule, a short reason, the guideline pages it cites, the confidence and the runner-up. Never asks. Returns `matchId`. |
| `resolve_tokens` | 6 KB | Every raw value the analyser read → nearest token with delta and the runner-up token. A value beyond tolerance is snapped to the nearest scale step with the delta, or kept as a documented exception with a reason when snapping would change its meaning (a colour visibly different from every semantic token) or `tolerance: strict` is set. Never asks. |
| `plan_component` | 24 KB | The plan: tree with exact imports, prop mapping per node (variant from colour and state, heading level from size, placeholders, wrappers), token references, a11y per node, files, contract rules, catalog excerpts, story and test ideas. A plan, never source. |

**Checks** (`checks:run`; DESIGN.md §5, §11, rev 3):

| Tool | Cap | What it does |
|---|---|---|
| `run_checks` | 16 KB | Takes the files the agent wrote and the `results.json` the skill's capture script produced (tsc, lint, tests, axe, screenshots). Scans the files itself for raw colours and lengths (nearest token + delta), unknown tokens, deprecated components and props from the migration registry, hand-built elements where a component exists, unlabeled icon buttons, `onClick` on non-interactive elements, missing `alt`, a missing stylesheet import, and imports this version does not export. Maps the agent's results to findings with fix hints: type errors to the documented prop (nearest name, allowed union values), lint rules to guideline pages, axe violations to the primitive that fixes them, failed tests to the rule they protect. Screenshots with embedded bytes (`--embed-screenshots`) are compared to the design image by SSIM with a 4×4 region map, advisory only. Returns one report sorted by severity with `checks`, `skipped` (never assumed green), pagination by file, and `delta` against a previous `auditId`. Types, lint, tokens, deprecations, tests and a11y gate; contract and visual inform. Nothing runs on the server. |

**Path two, audit and test** (DESIGN.md §5):

| Tool | Scope | Cap | What it does |
|---|---|---|---|
| `audit_code` | `audit:run` | 16 KB | The static scan of `run_checks` over source and style files, plus the contract rules: boolean prop explosions (three or more booleans on one props interface), exported components that do not `forwardRef`, system primitives re-styled inline or via CSS that targets `Tenet-*` classes, pixel margins between siblings. `rules` narrows by id or prefix. Per-file summary with the package imports and exported components. Paginated by file; `byRule` counts; `auditId` for fixed / new / remaining on the next run. |
| `audit_page` | `audit:run` | 16 KB | Judges `snapshot.json` from `capture.mjs page <url>`: the runtime contract (critical when the stylesheet did not resolve), console errors; every computed colour, font size, radius, padding and gap on the page's own elements resolved to a token for the theme (elements inside `Tenet-*` components are the system's responsibility and are not judged); text contrast over the effective background (walks `parent` links) against WCAG and the documented pairs; missing accessible names, heading order and one `main` from the accessibility tree (axe-reported nodes are not double-counted); focus order against visual order; axe violations mapped to the primitive that fixes them; SSIM against a `designId` when the screenshot is embedded, advisory. Paginated by rule; `auditId`. |
| `plan_tests` | `ds:read` | 12 KB | From the component's files (props interface, callbacks, unions, the primitives it imports, its stories) or from a `matchId` (the latest plan for it): a render case per variant and text prop, an interaction and a keyboard case per callback (and an inert-when-disabled case), a11y cases from the contract and from the primitives used (IconButton needs a name, Dialog traps focus and closes on Escape, Tabs arrow keys, …), the forwardRef/rest-props contract case, and a visual case per story with its Storybook id. Each case names the primitive it exercises and the rule it protects; `run_checks` maps failed tests back by name. Includes a test-file skeleton with one `it.todo` per case. |

**Reports** from `run_checks`, `audit_code` and `audit_page` share one shape and one store: `audit://{auditId}/findings.json` (every finding, beyond the inline page), `delta.json`, `report.json`; private to the principal, 24 h.

**Prompts:** `design-to-code`, `audit-ui`, `test-ui`: the path, the anti-duplicate-call rule, the stop condition (no critical or serious finding, or three rounds), and the rule that the agent acts on the server's decisions and reports them instead of asking the user to choose.

**Hooks plugin** (`plugin/`, DESIGN.md §7 layer two): a Claude Code plugin with a `PostToolUse` hook on the server's tools, a `PostToolUse` hook on `Write`/`Edit`, and a `Stop` hook. It records tool name, trace id and outcome; that a file changed and what it followed (plan, audit, checks, catalog lookup); and at the end of the turn the rounds of `run_checks`, whether the last one was green, writes after a plan, lookups before a write, suppressed findings. Spooled locally under `~/.tenet-ui/hooks/` and posted to `POST /events` when `DS_SERVER_URL` and `DS_SERVER_TOKEN` are set. Never arguments, contents or paths in clear. See `plugin/README.md`.

**Dashboard** (`GET /dashboard`): the eight questions of DESIGN.md §7. Calls and principals per tool, p50/p95 and bytes per tool, close calls decided, decisions that fell back to the structural score, values snapped beyond tolerance, first-run pass rate per check, findings per audit and fixed in session, rounds to green and writes after a plan (from hooks), zero-result searches and token exceptions, version distribution and fallbacks, `full: true` rate. Server events carry names, counts, durations, outcomes and per-check statuses only.

**Decisions.** The server holds the design system's knowledge, so it decides and never puts a question to the user or the agent. No tool returns `input_required` or an elicitation form. A close match is settled by a guideline test over the design's structure: a region inside a Card is a plain section (Cards never nest), a page root is never a Card, repeated same-size tiles are Cards, an own heading or action makes a Card, a borderless block that flows with the page is plain. When no guideline test separates two candidates, the higher structural score wins and the decision says `basis: "score"`, so the dashboard can count those. Every decision lists the rule, the reason, the `ds://` guideline pages it cites, the confidence and the runner-up, and the plan carries them under "Decisions" and "Documented exceptions". Decisions are deterministic for a given design and `dsVersion`.

**Design store:** rows (`dsg_…`, `mtc_…`, `pln_…`, `aud_…`) are bound to the caller's `sub`, expire after 24 h, live under `DATA_DIR` (default `.data/`). Another principal gets not-found, never forbidden. Private resources: `design://{designId}/layout.json`, `screenshot.png`, `match.json`, `matches/{matchId}.json`, `plan.md`, `plans/{planId}.md|.json`.

**Vision:** `@anthropic-ai/sdk`, model `VISION_MODEL` (default `claude-opus-5`), structured output via `betaZodOutputFormat`, server-side refusal fallbacks on. Enabled when `ANTHROPIC_API_KEY` (or an `ant auth login` profile with `VISION=on`) is present; otherwise `ingest_design` accepts layouts only and says so.

**Resources:** `ds://versions`, `ds://{v}/components/{name}` (markdown), `ds://{v}/tokens/{group}.json`, `ds://{v}/guidelines/{topic}` (the nine system pages, any component id, `contract`, `audit-rules`), `ds://{v}/gaps`, `ds://{v}/changelog`, `ds://{v}/deprecations`.

**Discovery:** `GET /healthz`, `GET /.well-known/oauth-protected-resource` (also at the path-aware `/.well-known/oauth-protected-resource/mcp`), `GET /.well-known/oauth-authorization-server`. MCP clients call `server/discover` for versions, capabilities and server info. No token → `401` with `WWW-Authenticate: Bearer resource_metadata=…`; missing scope → one `403 insufficient_scope` naming every missing scope.

**Telemetry:** one JSON line per request / tool call / resource read on stderr with a W3C trace id. The trace comes from `params._meta.traceparent` (SEP-414) when the client sends one, else from the `traceparent` header, else a fresh one; it is echoed back in the response header and in each result's `_meta.traceId`. Names, durations, statuses, versions, byte counts. Never arguments or findings.

## Protocol note

The server runs on the TypeScript MCP SDK v2 (`@modelcontextprotocol/server` 2.3.1; tests use `@modelcontextprotocol/client` 2.3.1), which implements MCP **2026-07-28**:

- **No initialize, no sessions.** Every request carries its protocol version, client info and capabilities in `_meta`. `src/http.ts` builds one `createMcpHandler` per process and the SDK makes a fresh `McpServer` per request from the same factory; `src/stdio.ts` uses `serveStdio` with that factory.
- **`server/discover`** is answered by the SDK: supported versions, capabilities, instructions, and server info in the result's `_meta`.
- **List caching (SEP-2549).** `tools/list`, `prompts/list`, `resources/templates/list` and `server/discover` carry `ttlMs` of one hour, `resources/list` five minutes, all `cacheScope: "private"`. A `ds://` read at an exact version is cached for 24 h; `latest` and `ds://versions` for five minutes; `design://` and `audit://` reads have `ttlMs: 0`.
- **Header mirroring (SEP-2243).** The SDK requires `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name`, and validates `Mcp-Param-DsVersion` against the `dsVersion` argument.
- **Trace propagation (SEP-414).** `traceparent` in `_meta` is read through the SDK's `TRACEPARENT_META_KEY`.
- **Older hosts.** A client on 2025-11-25 is still served through the SDK's stateless legacy path (`initialize` answered, no session id). Header mirroring does not apply to those requests, so the `dsVersion` argument alone decides.

`tools/list` is about 26 KB for thirteen tools with output schemas. The 7 KB figure in DESIGN.md §6 is not reachable with per-tool output schemas and is tracked as a budget of 2 KB per tool in the tests.

## Layout

```
src/ingest/            the data pipeline (DESIGN.md §10), see below
src/catalog/store.ts   snapshot reads + dsVersion resolution
src/catalog/resolve.ts nearest-token resolution (ΔE / distance)
src/catalog/synonyms.ts what people call components and token groups
src/tools/             tools as plain functions (unit-tested without a transport): catalog-, design-, audit-, test-, checks-tools
src/design/            layout schema, vision call, matcher, token resolution, plan builder, test-plan builder
src/checks/            static scan + contract rules, source parser, judgment over capture results, page judgment, SSIM, shared report plumbing
src/store/             the design store (principal-bound rows, 24 h TTL; designs, matches, plans, reports)
src/resources.ts       ds:// public, design:// and audit:// private resources
src/prompts.ts         design-to-code, audit-ui, test-ui
src/metrics.ts         event spool, the §7 summary, the dashboard page
src/server.ts          McpServer factory: registration order, structured output, cache hints, _meta, telemetry with derived metrics
src/http.ts            Streamable HTTP via createMcpHandler: Origin, bearer, scopes, PRM, AS metadata, client credentials; /events, /metrics.json, /dashboard
src/stdio.ts           stdio via serveStdio, same server factory
plugin/                the companion Claude Code plugin: hooks.json + ds-hook.mjs (layer two)
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

DESIGN.md §15 step 6 (step 5, Figma, is dropped: no Figma source for tenet-ui): the dual-path eval harness over golden screenshots and golden source files, the skill moved into this repo's plugin next to the hooks, external OAuth (PRM against a real authorization server, CIMD) if the server is ever shared beyond one team. `design_to_plan` as a Task once the composite is worth it; a live vision run once credentials are available (the vision path is wired but has never been exercised against the model).
