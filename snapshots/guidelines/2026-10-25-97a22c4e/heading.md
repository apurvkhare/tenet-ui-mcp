---
component: heading
related: [text, empty-state, stack]
updated: 2026-09-12
---

# Heading — usage guidelines

**When to use:** every page, section, card and dialog title. `Heading` is the only way to put the display (serif) type scale on screen — reach for it instead of a raw `<h1 className="page-title">` with custom CSS. For body copy, captions and labels use `Text`.

## Rules

- `level` (1–4) picks the **size** from the type scale (36 / 28 / 20 / 16) and the default element (`h1`…`h4`). Never set `fontSize` or `fontFamily` inline — the scale is the token.
- `as` picks the **element** when semantics and size must differ. Keep the document outline honest: one `h1` per page, then `h2`, `h3`… in order without skipping ranks. If a section title should *look* big but sit under the page `h1`, write `<Heading level={1} as="h2">`; if a card title is visually small but is the card's own `h2`, write `<Heading level={4} as="h2">`.
- Use `as="p"` / `"div"` / `"span"` for display-styled text that is *not* a heading (a hero stat, a decorative quote) so screen readers don't announce a false section.
- `truncate` clips to one line with an ellipsis — use it in constrained rows (table titles, cards in a grid); make sure the full text is reachable elsewhere (a tooltip, the detail page).
- Color is always `fgColor-default`; a muted or accent title is a `Text` with `weight="semibold"`, not a recolored heading.

## Do / Don't

- ✅ `<Heading level={1}>Newsroom</Heading>` — the page title.
- ✅ `<Heading level={3} as="h2">Recent stories</Heading>` — a section `h2` at the level-3 size.
- ✅ `<Heading level={4} truncate>{story.title}</Heading>` — a card title that must fit one line.
- ❌ `<h1 style={{ fontSize: 36, fontFamily: 'Georgia' }}>` — off-scale, off-token.
- ❌ `<Heading level={4} as="h1">Settings</Heading>` next to `<Heading level={1} as="h5">` — the outline no longer matches what people see; keep ranks in reading order.

**See also:** `Text` for everything that is not a section title; system guidelines `typography` (the scale, one `level={1}` per page, `as` for honest ranks) and `content` (sentence case).
