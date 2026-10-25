---
component: tag
related: [badge, label, text, empty-state]
updated: 2026-09-12
---

# Tag — usage guidelines

**When to use:** a short word attached to an item. `Tag` is the system's one pill and has two modes:

- **Read-only status or category** (no `onRemove`): `Published`, `In review`, `Draft`, `Culture`. Pick `variant` by meaning.
- **Removable chip** (`onRemove` set): a user-applied token the user can dismiss — an active filter, a selected recipient, a keyword.

**When to use a neighbour instead:**

- For a **count** or presence dot (`3 unread`) use `Badge`. Badge is a number or a dot; Tag is a word.
- For a **contextual message** with a sentence of text use `Banner`, not a long Tag.
- If the chip's whole body should toggle a choice, use `SegmentedControl` or `Checkbox`, not a Tag with a click handler on the span.
- `Label` (0.3.0 and earlier) is **deprecated**: it was a second pill with the same variants. Replace `<Label variant="success">` with `<Tag variant="success">`. The name is now free of the `FormControl.Label` collision.

## Rules

- Choose `variant` by **meaning**, never by colour: `success` for positive/done, `danger` for problems or blocked, `attention` for pending/needs review, `accent` for the active or selected token, `muted` for quiet neutrals (drafts, archived), `default` otherwise. Do not compute your own fills or borders from a hex value — that is the anti-pattern this component removes.
- Map data to a variant once, in one place: `const variant = statusVariant[article.status]`.
- **Tag is stateless.** Setting `onRemove` renders a real `<button>`, but Tag never removes itself — your handler must drop the item from the collection you render from.
- The remove control is a real `<button>` so it is keyboard operable (Tab, then Enter/Space) with a `:focus-visible` ring. Never replace it with a clickable `<span>`.
- The remove button is named automatically: `Remove ${text}` when `children` is a string. If `children` is not a plain string (icon + element), pass `removeLabel`.
- `leadingIcon` and the ✕ glyph are decorative (`aria-hidden`); meaning comes from the text and, for removal, the button label. Use an icon from `tenet-ui/icons` at size 16.
- Tag text is **normal-case, readable words** (sentence case, one or two words). Do not uppercase it and do not put a sentence in it.
- A read-only Tag must not carry `onClick`; if a status needs to be actionable, put the action in a `Menu` or `Button` next to it.

## Do / Don't

- ✅ `<Tag variant="success">Published</Tag>` — read-only status word.
- ✅ `<Tag variant="accent" onRemove={() => setFilters((f) => f.filter((x) => x !== id))}>{name}</Tag>` — removable filter chip; the parent drops the item.
- ✅ `<Tag leadingIcon={<UserIcon />} removeLabel="Remove Ada Lovelace">Ada</Tag>` — named remove button when children are not a plain string.
- ❌ `<Tag onRemove={() => {}}>Design</Tag>` — a no-op handler; the chip looks removable but nothing happens.
- ❌ `<span className="pill" style={{ background: 'rgba(79,111,58,.15)', color: '#3c5630' }}>Published</span>` — hand-tuned colours; reinvents the component.
- ❌ `<Label variant="success">Published</Label>` — deprecated; use `Tag`.
