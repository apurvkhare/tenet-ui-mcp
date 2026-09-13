---
component: grid
related: [stack, card]
updated: 2026-09-12
---

# Grid — usage guidelines

**When to use:** laying out equal-width columns that reflow with the viewport — a row of stat cards, a card gallery, a two-column form section, a dashboard of panels. `Grid` and `Stack` are the only layout primitives: `Stack` for one axis (toolbars, form fields, vertical rhythm), `Grid` for two. Reach for it instead of `display: grid` with pixel gaps or a hand-written media query.

## Rules

- `columns` is the number of equal tracks, fixed (`columns={3}`) or per breakpoint (`columns={{ base: 1, sm: 2, lg: 4 }}`). It is mobile-first: `base` applies from 0, `sm`/`md`/`lg` switch on at the `breakpoint-sm/md/lg` tokens (640 / 960 / 1280) and a missing step inherits the previous one. Always give a `base` (or a plain number) — a grid that is 4-wide on phones is a bug.
- `gap` maps to the `space` scale (`condensed`=8, `normal`=16, `spacious`=24) and applies to both axes; `rowGap` overrides the row spacing only. **Never** set a pixel gap or margins between grid children.
- Use `Grid.Item span` for a child that should cover several columns (a featured card, a full-width footer row). `span` accepts the same responsive object, so a sidebar can be `span={{ base: 1, md: 2 }}`. Don't let a span exceed the column count at that breakpoint.
- Tracks are `minmax(0, 1fr)`, so long unbroken content truncates or wraps inside its cell rather than widening the column. Put `truncate` on the `Heading`/`Text` inside, not `overflow` on the grid.
- `align` controls block-axis alignment within a row (`stretch` makes cards in a row equal height, `start` keeps short items at the top).
- Don't nest a `Grid` to fake a table — tabular data is a `Table`/`DataTable`.

## Do / Don't

- ✅ `<Grid columns={{ base: 1, sm: 2, lg: 4 }} gap="normal">{stats.map(s => <Card key={s.id}>…</Card>)}</Grid>`
- ✅ `<Grid columns={3}><Grid.Item span={2}>…main…</Grid.Item><aside>…</aside></Grid>`
- ✅ `<Grid columns={2} gap="condensed" rowGap="normal">` — tight columns, roomier rows, both from the scale.
- ❌ `<div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20 }}>` — raw grid, off-scale gap, no responsive story.
- ❌ `<Grid columns={4}>` for a phone-first page — fixed four columns squeeze to nothing at 375px; give it a `base`.

**See also:** `Stack` for one-axis layout, `Card` for the tiles a grid usually holds; system guideline `layout` (gap scale, breakpoints, container widths).
