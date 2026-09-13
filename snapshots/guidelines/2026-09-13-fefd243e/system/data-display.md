---
title: Data display
component: system
page: data-display
related: [table, data-table, badge, tag, empty-state, avatar, skeleton, spinner, progress-bar, pagination, label]
updated: 2026-09-12
---

# Data display

Records, statuses, counts, and loading states each have one component. This page settles the pairs that get confused: `Table` against `DataTable`, `Badge` against `Tag`, the deprecated `Label`, and when a collection shows an `EmptyState` instead of an empty table. It also fixes how loading is shown.

## Rules

1. `Table` is for static, hand-composed markup: `Table.Container`, `Table.Title`, `Table.Subtitle`, `Table.Actions`, then `Table.Head`, `Table.Body`, `Table.Row`, `Table.Header`, `Table.Cell`. Use it when the layout is bespoke (grouped rows, custom toolbars, server-driven paging) or the data does not change.
2. `DataTable` is for a list of records the user sorts, searches, or filters client-side. It takes `columns` and `data`, and builds the toolbar, sort buttons, and filter dropdowns. If the code around a `Table` starts holding sort or filter state, it should be a `DataTable`.
3. In a `DataTable` column, `accessor` returns the raw value used for sorting and filtering; `cell` is display only. Sorting never runs on rendered output.
4. Numeric columns use `align="end"` on both `Table.Header` and `Table.Cell`. A sortable `Table.Header` sets `sortDirection` (`ascending`, `descending`, `none`) and handles `onClick`; the component renders a real button and `aria-sort`.
5. Paged data uses `Pagination` below the table with `page`, `pageCount`, `onPageChange`. Row density comes from `density` (`condensed`, `normal`, `spacious`), never from cell padding.
6. `Badge` is a count or a dot attached to something else (unread count on a nav item, a presence dot on an avatar). It shows `count` (collapsing past `max`, default `99+`) or `dot`. A `Badge` never contains a word.
7. `Tag` is a word. `Tag` without `onRemove` is a read-only status or category pill (`<Tag variant="success">Published</Tag>`); `Tag` with `onRemove` is a removable chip (an active filter, a recipient). `variant` is `default`, `accent`, `success`, `danger`, `attention`, or `muted`, chosen by meaning.
8. `Label` is deprecated since 0.4.0. New code uses `Tag` for status pills; existing `<Label variant="…">` maps one-to-one to `<Tag variant="…">`.
9. Status colours on a `Tag` mean status: `success` for published or passing, `danger` for failed or blocked, `attention` for needs review. Categories and teams use `default` or `muted`. A status is always a word, never a bare coloured dot.
10. `EmptyState` renders when a collection has zero records. Its `title` names what is empty ("No stories yet"); its `description` says why or what to do next ("Stories you draft or import appear here."); `action` is at most one `Button variant="primary"`; `secondaryAction` is an optional `Button variant="invisible"` or `Link`; `icon` is optional and decorative (no `label`). `headingLevel` (`2`, `3`, `4`) sets the title's rank to fit the page outline; `size="large"` is for a whole-page or first-run state, `medium` (default) for an empty region inside a page.
11. An empty search or filter result does not replace the table. The table, its toolbar, and the active filters stay on screen, and the message goes through `DataTable` `emptyText` (default "No matching rows."): either a sentence ("No stories match these filters.") or, when the user needs a way out, a compact `EmptyState` with `headingLevel={4}` whose title echoes the query and whose `action` is "Clear filters". A hand-composed `Table` renders one `Table.Cell` with the same kind of content. A full-size `EmptyState` in place of the table is only for zero records (rule 10).
12. `Avatar` always receives `name`; it produces the initials fallback and the accessible name. `shape="circle"` is for people, `shape="rounded"` for organisations and repositories. Sizes come from `size`, never from width and height overrides.
13. Loading a layout whose shape is known uses `Skeleton` blocks matching the final content, inside a container with `aria-busy="true"` and a visually hidden status text. `Skeleton` is `aria-hidden` on its own.
14. A short indeterminate wait with no shape to mimic uses `Spinner` with a meaningful `label` ("Loading stories"). A measurable job uses `ProgressBar` with `value`, `max`, and `aria-label`; an unknown-duration job uses `ProgressBar` without `value`.
15. Skeletons and spinners are never shown at the same time for the same region, and neither replaces an `EmptyState` once the data has loaded empty.

## Which one

| Need | Component |
|---|---|
| Rows that never re-sort in the browser | `Table` |
| Rows the user sorts, searches, or filters | `DataTable` |
| A number or a dot on another control | `Badge` |
| A status or category word | `Tag` (no `onRemove`) |
| A user-removable token | `Tag` with `onRemove` |
| A status pill in 0.3.0 code | `Label`, deprecated; migrate to `Tag` |
| Zero records in a collection | `EmptyState` |
| A filter that matches nothing | `DataTable` `emptyText` (a sentence, or a compact `EmptyState headingLevel={4}`) |
| Known layout still loading | `Skeleton` |
| Unknown wait, compact | `Spinner` |
| Measurable job | `ProgressBar` |

## Do / Don't

- ✅ `<DataTable columns={cols} data={stories} title="Stories" rowKey={(s) => s.id} />` with `{ id: 'status', header: 'Status', accessor: (s) => s.status, filterable: true, cell: (s) => <Tag variant={s.status === 'published' ? 'success' : 'muted'}>{s.statusLabel}</Tag> }`
- ✅ `<Badge variant="danger" count={unread} />` next to an `aria-label` that includes the count ("Inbox, 3 unread")
- ✅ `stories.length === 0 ? <EmptyState icon={<InboxIcon size={24} />} title="No stories yet" description="Stories you draft or import appear here." action={<Button variant="primary" onClick={create}>Create story</Button>} /> : <DataTable … />`
- ✅ `<div aria-busy="true"><Skeleton variant="text" /><Skeleton variant="text" width="80%" /></div>` while a card body loads
- ❌ `<Badge variant="success">Published</Badge>` (a word in a badge; use `Tag`)
- ❌ `<Tag variant="accent">3</Tag>` (a count in a tag; use `Badge`)
- ❌ `<Label variant="danger">failing</Label>` in new code (deprecated; `<Tag variant="danger">Failing</Tag>`)
- ❌ `filtered.length === 0 ? <EmptyState title="No results" /> : <DataTable … />` (replacing the table and its filters when a search returns nothing; the table stays and `emptyText` speaks)
- ❌ `<EmptyState title="Nothing here" action={<Button>Import</Button>} secondaryAction={<Button variant="primary">Create</Button>} />` (title does not name what is empty; two primary-looking actions)
- ❌ A `<div>` of flex rows with hardcoded borders standing in for a table (no `<table>` semantics; use `Table` or `DataTable`)
