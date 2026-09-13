---
title: Iconography
component: system
page: iconography
related: [icon, icon-button, button, text-input, empty-state, banner, accessibility]
updated: 2026-09-12
---

# Iconography

The icon set is part of the package: `import { SearchIcon } from 'tenet-ui/icons'`. Every icon is a React component named `<Thing>Icon`, drawn in `currentColor`, sized `16`, `20`, or `24`, and decorative by default. Meaning comes from the text or control next to an icon, or from its `label` when it stands alone.

## Rules

1. Icons come from `tenet-ui/icons` and are named `<Thing>Icon` in PascalCase (`SearchIcon`, `TrashIcon`, `PlusIcon`). The manifest at `generated/icons.json` lists every name with its keywords; an icon that is not in it does not exist in the system.
2. Arbitrary inline `<svg>` is not written in app code when an icon with that meaning exists in the set. When no icon exists, the gap is a request to add one to `icons/manifest.json`; a one-off `<svg>` in the meantime still follows rules 3, 5, and 6.
3. `size` is `16`, `20`, or `24`. `16` is for icons inline with text and inside controls (`Button` `leadingIcon`, `TextInput` `leadingVisual`, `Tag` `leadingIcon`, `Menu` items, table cells). `20` is for large controls, list rows, and standalone `IconButton`s in toolbars that sit apart from text. `24` is for `EmptyState` `icon`, `Banner` `icon`, and page headers. Nothing else sizes an icon.
4. An icon is decorative by default: it renders `aria-hidden="true"` and screen readers skip it. It stays decorative whenever visible text or an accessible name already carries its meaning: next to a label, inside a named `IconButton`, inside a `Button` with children.
5. An icon is meaningful only when it is the sole carrier of information and that information is not a status (a paperclip marking that a row has attachments, a trend arrow beside a bare number). Then it gets `label`, which sets `role="img"` and `aria-label`. The label names the meaning, not the drawing: `label="Has attachments"`, not `label="Paperclip"`. A status is a word in a `Tag` (rule 12).
6. `IconButton` always has `aria-label` (or `aria-labelledby`) describing the action ("Delete row", not "Trash"). Its `icon` stays decorative; passing `label` to the icon inside an `IconButton` would double-announce.
7. A `Button` with an icon and text keeps the icon decorative; the text is the name. Text is preferred to an icon-only control wherever there is room.
8. Icons take colour from `currentColor`. Colour comes from the parent (`Text tone="danger"`, a `Button` variant), never from a `fill`, `stroke`, or `color` literal on the icon. An icon is never coloured with a status hue unless the status meaning applies (see color.md).
9. Icons align to the text baseline through the component that hosts them (`Button`, `TextInput`, `Tag`, `EmptyState`). App code does not nudge icons with margins or `vertical-align`.
10. One icon per concept across the app: search is always `SearchIcon`, add is always `PlusIcon`, delete is always `TrashIcon`. Two different glyphs for the same action is a defect.
11. Emoji are not icons. A `Menu` trigger, a `Tooltip` example, or a button never uses `⋯`, `🗑`, or `✕` as its glyph; it uses the set.
12. An icon never replaces a status word. A coloured check in a table cell is `<Tag variant="success">Published</Tag>`, not a lone `CheckIcon`.

## Sizes

| `size` | Where |
|---|---|
| `16` | `Button` `leadingIcon`/`trailingIcon`, `TextInput` `leadingVisual`/`trailingVisual`, `Tag` `leadingIcon`, `Menu` items, inline with `Text` |
| `20` | `size="large"` controls, list rows, standalone `IconButton`s in toolbars |
| `24` | `EmptyState` `icon`, `Banner` `icon`, page and dialog headers |

## Do / Don't

- ✅ `import { SearchIcon, TrashIcon } from 'tenet-ui/icons'`
- ✅ `<Button leadingIcon={<PlusIcon />}>Create story</Button>` (decorative icon, text is the name)
- ✅ `<IconButton icon={<TrashIcon size={20} />} variant="danger" aria-label="Delete story" onClick={remove} />` (named action, decorative icon)
- ✅ `<TextInput aria-label="Search stories" leadingVisual={<SearchIcon />} />` (16 inside a control)
- ✅ `<EmptyState icon={<InboxIcon size={24} />} title="No stories yet" description="Stories you draft or import appear here." />`
- ✅ `<Text tone="danger"><AlertTriangleIcon label="Warning" /> 3 stories failed to import</Text>` only when the icon adds information the text lacks; otherwise omit `label`
- ❌ `<svg viewBox="0 0 24 24"><path d="M21 21l-4.35-4.35…" /></svg>` (hand-inlined search glyph; `SearchIcon` exists)
- ❌ `<IconButton icon={<TrashIcon />} onClick={remove} />` (no accessible name)
- ❌ `<IconButton icon={<TrashIcon label="Delete" />} aria-label="Delete" />` (double announcement; the icon stays decorative)
- ❌ `<TrashIcon style={{ color: '#a8341f' }} />` (a `brick.500` literal; wrap in `Text tone="danger"` or use the `danger` variant of the host)
- ❌ `<SearchIcon size={18} />` (off the 16/20/24 scale)
- ❌ `<Button>🗑 Delete</Button>` (an emoji standing in for `TrashIcon`)
