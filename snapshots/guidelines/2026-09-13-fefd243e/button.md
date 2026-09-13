---
component: button
related: []
updated: 2026-09-12
---

# Button — usage guidelines

**When to use:** a Button triggers an action (submit, save, delete, open). For navigation to another page, use a link, not a Button.

## Rules

- Use exactly **one** `variant="primary"` per surface — the single most important action.
- Use `variant="default"` for secondary actions, `variant="invisible"` for low-emphasis / tertiary actions.
- Use `variant="danger"` **only** for destructive actions (delete, remove); pair it with a confirmation.
- **Never** hardcode colors, padding, or sizes. All colors come from `fgColor` / `bgColor` / `borderColor` tokens; all spacing from the `space` scale; heights from `control.*`.
- Always provide a visible text label. Icon-only buttons must use `IconButton` with an `aria-label`; icons come from `tenet-ui/icons` and go in `leadingIcon` / `trailingIcon` (decorative).
- Do not nest interactive elements (links, buttons) inside a Button.
- Use `fullWidth` to fill the container (inside a `Stack.Item` or `Grid.Item`); `block` is the deprecated 0.3.0 name and warns.
- Labels are verbs that name the outcome ("Save changes", "Delete article"), sentence case, never "Submit" or "OK".

## Do / Don't

- ✅ `<Button variant="primary">Save changes</Button>`
- ❌ `<button style={{ background: '#0969da', padding: '13px' }}>Save</button>` — raw element, hardcoded color, off-scale padding.
- ❌ `<Button kind="primary">` — `kind` is not a prop; the prop is `variant`.

**See also:** `IconButton` for icon-only actions, `Link` for navigation; system guidelines `content` (button labels) and `color` (one primary per surface).
