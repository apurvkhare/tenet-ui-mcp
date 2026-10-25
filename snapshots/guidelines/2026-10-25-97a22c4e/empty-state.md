---
component: empty-state
related: [heading, text, button, data-table, card]
updated: 2026-09-12
---

# EmptyState — usage guidelines

**When to use:** a table, list, inbox, search or filter that has nothing to show — first run ("No stories yet"), an exhausted filter ("No results for 'budget'"), a cleared queue ("You're all caught up"). For zero records, render it *in place of* the rows, inside the same `Card`/`Table.Container`, so the layout doesn't jump. For an exhausted search or filter, keep the table and its toolbar on screen and pass a compact `EmptyState` (`headingLevel={4}`, no `size="large"`) as `DataTable` `emptyText`. It is not for errors (use `Banner variant="danger"`) or for loading (use `Skeleton`/`Spinner`).

## Rules

- `title` is required and specific: name what is empty and, for filters, echo the query. Avoid "Nothing here" / "Oops".
- `description` explains why and what to do next in one or two sentences; keep it inline content (it renders inside a paragraph).
- `action` is the single step that fixes the emptiness — a `Button variant="primary"` ("Create story", "Clear filters"). `secondaryAction` is optional and quieter (`Button variant="invisible"`, a `Link` to docs). Never two primaries; no action at all is fine when there is nothing the user can do.
- `icon` is decorative and is wrapped `aria-hidden` — the title already carries the meaning. Pass an `Icon` or an inline `<svg>` that uses `currentColor`; it is tinted `fgColor-muted` and sized from the size scale. Don't put text or a status meaning in it.
- `headingLevel` (2–4, default 3) sets the title's **rank** in the outline so it nests under the surrounding page/section heading; its visual size follows `size`. Use `size="large"` only for whole-page or first-run states.
- Don't hand-build one: a centered `<div>` with inline `textAlign` and a `<h3 style>` skips the type scale, the muted tone and the outline rules this component encodes.

## Do / Don't

- ✅ `<EmptyState title="No stories yet" description="Stories you create or are assigned will appear here." action={<Button variant="primary">Create story</Button>} />`
- ✅ `<EmptyState title={`No results for “${query}”`} description="Try a different spelling or clear the filters." action={<Button onClick={clear}>Clear filters</Button>} headingLevel={4} />` passed as `DataTable` `emptyText`, so the toolbar and active filters stay.
- ✅ `<EmptyState size="large" headingLevel={2} icon={<InboxIcon />} title="You're all caught up" />` as a page's only content under its `h1`.
- ❌ `<div style={{ textAlign: 'center', padding: 40 }}><h3>Nothing here</h3></div>` — off-system and unspecific.
- ❌ `<EmptyState title="Error" description="Request failed" />` — failures are a `Banner`, not an empty state.

**See also:** `DataTable` (`emptyText` for an exhausted filter), `Banner` for failures, `Skeleton` while loading; system guidelines `data-display` (when a collection shows an EmptyState) and `content` (title, description, and action copy).
