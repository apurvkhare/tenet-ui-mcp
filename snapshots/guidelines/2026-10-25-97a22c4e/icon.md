---
component: icon
related: [icon-button, button, empty-state]
updated: 2026-09-12
---

# Icon — usage guidelines

**When to use:** to reinforce an action, status or object next to text, or as the only content of an
`IconButton`. Icons are drawn from the curated tenet set (Lucide, ISC) exported from
`tenet-ui/icons`; `generated/icons.json` is the searchable manifest.

## Sizes

- **16** (default) — inside controls: `Button` leading/trailing icons, `IconButton`, input
  adornments, table-row actions, tag/label prefixes. Sits on the 14px body text line.
- **20** — large controls (`size="large"` buttons), list rows and navigation items with 16px text.
- **24** — empty states, page/section headers, stat tiles, dialog titles. Never larger: for
  illustrations use an image, not a stroked icon.
- Do not set `width`/`height`/`viewBox` yourself; `size` owns geometry so every icon in a row lines
  up. Stroke width is a constant 2 across sizes (Lucide's native weight).

## Decorative vs meaningful — the `label` rule

- **Default is decorative.** An icon renders `aria-hidden="true"`. This is right whenever the
  meaning is already in adjacent text or in the control's name: `<Button leadingIcon={<PlusIcon />}>New
  article</Button>`, a status word with a check next to it, a chevron on a disclosure.
- **Pass `label` only when the icon stands alone.** A lone glyph in a table cell that carries
  information no text does (`<PaperclipIcon label="Has attachments" />`), a sole indicator in a
  header. A *status* is never a lone icon: it is a word in a `Tag` (`<Tag variant="success">Published</Tag>`). `label` sets
  `role="img"` + `aria-label`, so screen readers announce it. Name the **meaning**, not the glyph:
  `label="Published"`, not `label="Check circle"`.
- Never give an icon a `label` that duplicates visible text beside it — the name is read twice.

## Pairing with IconButton and Button

- In `IconButton` the accessible name goes on the **button** (`aria-label="Delete row"`); the icon
  stays decorative. `IconButton` already wraps the icon in an `aria-hidden` span, so do not add a
  `label` to the glyph — the button would then have two competing names.
- `Button`'s `leadingIcon`/`trailingIcon` slots are `aria-hidden` too; pass bare glyphs
  (`<ChevronDownIcon />`) and let the label text speak.
- Icon color is `currentColor`: it inherits the button/text token automatically. Do not set
  `color` on the icon; set it on the parent (or pick a token variant of the parent).

## Naming and imports

- Every glyph is `<Thing>Icon` from `tenet-ui/icons`: `import { SearchIcon, MoreHorizontalIcon }
  from 'tenet-ui/icons'`. The tenet name is in `generated/icons.json` (`search` →
  `SearchIcon`); the Lucide source name may differ (`more-horizontal` is Lucide's `ellipsis`).
- **Never inline arbitrary SVG when an icon exists** in the set. Search `generated/icons.json` by
  keyword first. If a glyph is genuinely missing, add it to `icons/manifest.json` and run
  `node scripts/build-icons.mjs`; as a last resort wrap a one-off path in `<Icon>` so it still gets
  the system's size, stroke and a11y defaults.
- Do not add a runtime dependency on `lucide-react` or another icon package in product code; the
  tenet set is the vocabulary the docs, catalog and MCP tools know about.

## Do / Don't

- ✅ `<Button leadingIcon={<PlusIcon />}>New article</Button>` — decorative icon, text carries meaning.
- ✅ `<IconButton icon={<TrashIcon />} variant="danger" aria-label="Delete row" />` — name on the button.
- ✅ `<PaperclipIcon label="Has attachments" size={16} />` alone in a table cell — meaningful, labelled.
- ❌ `<CheckCircleIcon label="Published" size={16} />` alone in a status cell — a status is a `Tag` word, not a glyph.
- ❌ `<svg width="16" height="16"><path d="M…" /></svg>` — inline SVG for a glyph that exists (`SearchIcon`).
- ❌ `<IconButton icon={<TrashIcon label="Delete" />} />` — name on the icon, button still nameless.
- ❌ `<SearchIcon style={{ width: 18, color: '#c2410c' }} />` — off-scale size and a hardcoded color; use `size` and inherit the parent's token.

**See also:** `IconButton` for an icon-only action, `Button` `leadingIcon` when a label fits, `Tag` for status words; system guidelines `iconography` (sizes, decorative vs meaningful, naming) and `accessibility`.
