# tenet-ui companion plugin (hooks)

Layer two of the dashboard (DESIGN.md §7): the server knows what was asked; only the host knows
what the agent did with the answer. This plugin ships three hooks for Claude Code. Opt-in, and
visible in the host's hook settings.

| Hook | Fires | Records |
|---|---|---|
| `PostToolUse` on the server's tools | after `search_components` … `run_checks` | tool name, trace id from the result, outcome (`pass`/`fail`, `input_required`) |
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
