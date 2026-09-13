---
component: data-table
related: []
updated: 2026-09-12
---

# DataTable — usage guidelines

**When to use:** rendering a list of records where users need to **search, filter, or sort** without you wiring it all by hand. It's built on the `Table` primitives plus `TextInput` + `Select`, so it stays on-system. For a bespoke layout (grouped rows, custom toolbars, server-driven paging), drop down to `Table.*` directly.

## Rules

- Describe the table with `columns` (id, header, optional `accessor`/`cell`, `align`, `sortable`, `filterable`) + `data`. Don't hand-roll `<th>`/`<td>`.
- `accessor` returns the **raw** value used for sorting + filtering; `cell` is only for display (e.g. wrapping a status in a `Tag`). Keep them consistent — sort on the value, not the badge.
- Turn on `sortable` per column for click-to-sort (asc → desc → off), and `filterable` for a per-column dropdown built from the column's distinct values.
- Provide a `rowKey` when rows can reorder or the list is large — falling back to the index is fine only for static data.
- Use numeric `align="end"` for number columns so they line up.
- `emptyText` speaks when a search or filter matches no rows and the table stays on screen. When the collection itself has zero records, render an `EmptyState` instead of the table.
- This is **client-side** (filters/sort run over the `data` you pass). For huge or server-paged data, drive `Table.*` yourself and fetch on change.

## Do / Don't

- ✅ `<DataTable columns={cols} data={rows} title="Repositories" />`
- ✅ a status column: `{ id: 'status', header: 'CI', filterable: true, cell: r => <Tag variant={r.variant}>{r.status}</Tag> }`
- ❌ Building search/filter/sort state around a raw `Table` when DataTable already does it.
- ❌ Sorting/filtering on the rendered `cell` output instead of the underlying value.

**See also:** `Table` for hand-composed markup, `EmptyState` for an empty collection, `Pagination` for paged data; system guideline `data-display`.
