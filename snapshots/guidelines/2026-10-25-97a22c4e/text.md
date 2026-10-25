---
component: text
related: [heading, empty-state, label]
updated: 2026-09-12
---

# Text — usage guidelines

**When to use:** any run of body copy — paragraphs, descriptions, helper and validation messages, captions, table cell text, inline emphasis. `Text` is the body half of the typography system (`Heading` is the display half). Reach for it instead of a `<p>`/`<span>` with an inline `fontSize`/`color`. For a one-word status chip use `Tag`; for a form field's label use `FormControl.Label` (it wires the `htmlFor` and required marker for you).

## Rules

- `size` maps to the body scale: `small`=12, `medium`=14 (default), `large`=16. Don't go bigger — anything larger is a `Heading` (possibly with `as="p"`).
- `tone` is semantic, not decorative: `muted` for secondary copy, `success`/`danger`/`attention` for state and validation messages, `accent` sparingly for emphasis that matches the clay accent. Never pick a tone for its color; never convey a status by color alone — pair it with words or an icon.
- `as` sets the element: `p` for block copy, `span` inline, `strong`/`em` for inline emphasis (they keep their native semantics; `weight` still controls the visual), `label` for a caption that names a control — pass `htmlFor` so it is associated.
- `truncate` clips to a single line with an ellipsis; use it only where the full text is available elsewhere (a tooltip, the row's detail view).
- `align` is logical (`start`/`end`), so it follows RTL. Centering is for empty states and cards, not for running paragraphs.

## Do / Don't

- ✅ `<Text tone="muted" size="small">Last updated 3 minutes ago</Text>`
- ✅ `<Text as="label" htmlFor="email" weight="medium">Email</Text>` (outside `FormControl`)
- ✅ `<Text tone="danger">Enter a valid email address.</Text>` next to `aria-invalid` on the field.
- ❌ `<p style={{ color: '#6e6049', fontSize: 13 }}>` — off-scale, off-token, untethered from dark mode.
- ❌ `<Text tone="success">Draft</Text>` for a table status — a `Tag` gives it the tint + hairline treatment and reads as a status.

**See also:** `Heading` for text that structures the page, `Tag` for status words, `FormControl.Caption` and `FormControl.Validation` for field text; system guidelines `typography` and `color` (which `tone` sits on which surface).
