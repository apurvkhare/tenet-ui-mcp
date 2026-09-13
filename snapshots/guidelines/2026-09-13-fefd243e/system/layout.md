---
title: Layout
component: system
page: layout
related: [stack, grid, card, divider, typography]
updated: 2026-09-12
---

# Layout

Layout in tenet-ui is composed from two primitives, `Stack` (one axis) and `Grid` (columns), plus the space scale. Margins between siblings do not exist in app code; the parent's `gap` owns the rhythm. This page also settles the recurring question of when a block of content is a `Card` and when it is a plain section.

## Rules

1. Any two siblings with space between them sit inside a `Stack` (one axis) or a `Grid` (columns). App code never sets `margin`, `padding`, `display: flex`, or `display: grid` on its own wrappers to space children.
2. `gap` is the same scale everywhere: `none` (0), `condensed` (`--space-2`, 8px), `normal` (`--space-4`, 16px), `spacious` (`--space-5`, 24px). `Stack` `gap`, `Grid` `gap` and `rowGap`, and `Stack` `padding` map exactly to these values. `Card` `padding` uses the same four names but its `condensed` step is `--space-3` (12px), because a card edge needs more inset than a gap between siblings.
3. The space scale is `--space-1` (4), `--space-2` (8), `--space-3` (12), `--space-4` (16), `--space-5` (24), `--space-6` (32). Nothing is spaced by a value off this scale.
4. Default rhythm: `gap="condensed"` between controls in a toolbar or a button row; `gap="normal"` between fields and between items in a list; `gap="spacious"` between page sections.
5. `Stack` is vertical by default; `direction="horizontal"` is for toolbars, button rows, and label-plus-value pairs. `Stack.Item grow` is the one child that absorbs remaining width (a search field in a toolbar). `wrap` is on for horizontal stacks of chips or tags.
6. `Grid` is for columns. `columns` is a number or a responsive object `{ base, sm, md, lg }`; `Grid.Item span` spans columns. Mobile first: `base` applies below `--breakpoint-sm` and each key applies from its breakpoint up.
7. Breakpoints are `--breakpoint-sm` (640px), `--breakpoint-md` (960px), `--breakpoint-lg` (1280px). Prefer the responsive `columns` object over media queries. A CSS `@media` rule cannot read `var()`, so when an app must write one it uses the same pixel value with a comment naming the token.
8. Container widths: page content is capped at `--breakpoint-lg` (1280px) and centered. A form or a reading column is capped at `--breakpoint-sm` (640px), which keeps `Text` at 60 to 75 characters per line. `Dialog` width comes from its `size` (`small`, `medium`, `large`), never from an override.
9. Card or plain section, the decision test: content is a `Card` when it is a discrete, self-contained object that would still make sense lifted out of the page on its own (a summary tile with one number, a settings group with its own save action, a list container, a pinned item). Content is a plain section (`Heading` plus `Stack`) when it flows with the page and only makes sense in sequence with what is above and below it (a page section, a form's fields, prose). If removing the border would lose nothing, it is a section.
10. Corollaries of the test: a `Card` never contains another `Card`; a page is never a single full-width `Card` wrapping everything; summary tiles in a `Grid` are `Card`s; the fields of one form are a `Stack`, not one `Card` per field.
11. `Card` `padding="none"` when the children own their padding (`Table.Container`, a list whose rows are padded). Otherwise `padding="normal"` (default) or `condensed` for dense tiles.
12. `Divider` marks a boundary that means something (menu groups, an "or" between choices). Vertical rhythm comes from `gap`, never from stacked dividers or empty elements.
13. Fields fill their column with `fullWidth` inside a `Grid.Item` or `Stack.Item`. Widths are never set in pixels on a field.
14. Alignment uses `Stack` `align` and `justify`; there are no wrapper `<div>`s added only to center or right-align a child.

## Page skeleton

| Layer | Component | Gap |
|---|---|---|
| Page | `<Stack gap="spacious">` | sections |
| Section | `<Heading level={2}>` + `<Stack gap="normal">` | items |
| Tiles | `<Grid columns={{ base: 1, sm: 2, lg: 4 }} gap="normal">` of `Card` | tiles |
| Toolbar | `<Stack direction="horizontal" gap="condensed" align="center">` | controls |
| Form | `<Stack gap="normal">` of `FormControl` | fields |

## Do / Don't

- ✅ `<Grid columns={{ base: 1, sm: 2, lg: 4 }} gap="normal"><Card padding="condensed">…</Card></Grid>` (tiles are discrete objects, so they are cards)
- ✅ `<Stack gap="spacious"><Heading level={2}>Recent stories</Heading><Table.Container>…</Table.Container></Stack>` (a page section flows with the page, so it has no card)
- ✅ `<Stack direction="horizontal" gap="condensed" align="center"><Stack.Item grow><TextInput aria-label="Search stories" fullWidth /></Stack.Item><Button>Filters</Button></Stack>` (toolbar rhythm from gap, growth from Stack.Item)
- ✅ `<Card padding="none"><Table.Container>…</Table.Container></Card>` (a list container whose child owns its padding)
- ❌ `<div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>` (raw flex, off-scale gap, margin between siblings)
- ❌ `<Card><Card>…</Card></Card>` (nested cards; the inner one is a section)
- ❌ `<Card><Heading level={1}>Newsroom</Heading>…entire page…</Card>` (a page is not a card)
- ❌ `<TextInput style={{ width: 320 }} />` (pixel width on a field; use `fullWidth` in a sized `Grid.Item`)
