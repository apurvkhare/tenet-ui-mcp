# tenet-ui companion plugin

Two things for Claude Code: a local colour-measuring script with a skill that says when to use it, and hooks for layer two of the dashboard.

## Measure colours locally

The server makes no model call and does not need the screenshot. The agent's model describes the screenshot as a layout tree for `ingest_design`; its hex colours are guesses, ΔE 3 to 20 off the real pixels, enough to land on the neighbouring token (on the stat-cards baseline a guessed border was closer to `borderColor-muted` than `borderColor-default`). `scripts/measure-colors.mjs` re-measures them from the pixels on the agent's machine, so the screenshot never leaves it:

```bash
node scripts/measure-colors.mjs <screenshot.png> <layout.json> [--out <file>]
```

`<layout.json>` is the object passed as `source.layout`. The script writes it back with the measured colours (or to `--out`) and prints `{layout, count, maxDeltaE, colorCorrections}`. It measures only the colours the layout reports: the interior's dominant colour for a background, a near-uniform line along the edges for a border, the glyph fill for text (including small subpixel-rendered text), and it keeps the estimate when the sample is more than ΔE 30 away. PNG only. Node 22 or later, no dependencies, no network. It is a port of the server's `src/design/pixels.ts` and the tests check both give identical corrections. Skip it for a design from Figma: its values are exact.

The `describe-design` skill walks the agent through it: read `ds://{v}/layout-schema`, describe the screenshot, run the script, call `ingest_design` with `source: {type: "layout", layout}`. An agent that cannot run the script sends the screenshot with the layout and the server measures it the same way.

## Hooks

Layer two of the dashboard (DESIGN.md §7): the server knows what was asked; only the host knows
what the agent did with the answer. This plugin ships three hooks for Claude Code. Opt-in, and
visible in the host's hook settings.

| Hook | Fires | Records |
|---|---|---|
| `PostToolUse` on the server's tools | after `search_components` … `run_checks` | tool name, trace id from the result, outcome (`pass`/`fail` for checks and audits, `isError`) |
| `PostToolUse` on `Write` / `Edit` | after a file write | that a file changed, its extension, a hash of its path, and what it followed: a plan, an audit, a `run_checks` round, or a catalog lookup |
| `Stop` | at the end of the turn | rounds of `run_checks` and whether the last one was green, writes after a plan / audit, lookups before a write, suppressed findings |

Never recorded: arguments, prompts, file contents, findings text, paths in clear.

## Install

```bash
claude plugin add /path/to/tenet-ui-mcp/plugin   # or the marketplace entry once published
```

Then point the hooks at the server (the same bearer token the MCP connection uses):

```bash
export DS_SERVER_URL=https://ds.example.com
export DS_SERVER_TOKEN=…   # scope: any; the token's sub attributes the events
```

Without `DS_SERVER_URL` the events only spool locally under `~/.tenet-ui/hooks/events.jsonl`
(override with `TENET_UI_HOOK_DIR`). With it, each hook also POSTs to `/events`; the server's
dashboard at `/dashboard` joins them with its own request spans by trace id and session id.

The tool matcher is `mcp__<server>__<tool>` for any server name, so `claude mcp add tenet-ui …`
or `claude mcp add ds …` both work.
