---
component: badge
related: []
updated: 2026-09-12
---

# Badge — usage guidelines

**When to use:** a compact count or presence dot attached to something else — unread counts on a nav item, a "new" dot on an avatar. For a labelled status word on a row (passing / failing) use `Tag`; for a contextual message use `Banner`.

## Rules

- Use `count` for quantities; it collapses to `max+` (default `99+`) past the threshold — don't render "1284" in a badge.
- Use `dot` for pure presence/attention with no number.
- Pick `variant` by meaning. `danger` for things demanding attention (errors, overdue), `accent` for neutral counts.
- A badge is decorative-adjacent: if the count conveys meaning not otherwise on screen, make sure the surrounding control has an accessible name that includes it (e.g. `aria-label="Notifications, 3 unread"`).

## Do / Don't

- ✅ `<Badge variant="danger" count={5} />`
- ✅ `<Badge dot variant="success" />`
- ❌ Using a Badge for a status word — that's `Tag` (a Badge is a count or a dot; a Tag is a word).
- ❌ Relying on the badge alone to convey critical info to screen-reader users.

**See also:** `Tag` for words; system guideline `data-display` (Badge vs Tag, and the deprecated `Label`).
