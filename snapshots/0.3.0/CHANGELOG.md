# Changelog

All notable changes to **tenet-ui** are documented here. This project follows
[Semantic Versioning](https://semver.org/). Pre-1.0, breaking changes may land in
a **minor** release.

## 0.3.0 — 2026-06-23

Hardening pass from a systematic audit (accessibility, CSS/layout, and API
reviews across all components, plus a runtime sweep at multiple viewports and in
both themes).

### Changed (potentially breaking)
- **Table** now renders its `<table>` inside a `<div class="Tenet-Table__scroll">`
  scroll viewport so wide tables scroll horizontally instead of being clipped.
  Update any CSS that assumed `<table>` was a direct child of
  `.Tenet-Table__container`.
- **Overlays** (`Menu`, `Select`, `Popover`, `DatePicker`, `Tooltip`) now render
  their floating layer in a portal to `document.body`, positioned to the viewport
  (so they can't be clipped by an `overflow:hidden` ancestor or run off-screen).
  Overlay `z-index` is now `150` (above `Dialog`'s `100`, below `Toast`'s `200`).
  Theming assumes `data-color-mode` is on `<html>`/`<body>`.

### Added
- `Textarea` gains a `size` scale (`small | medium | large`) to match the other
  fields.
- `Select` and `SegmentedControl` now extend their host element's HTML attributes
  and forward `...rest` (so `data-*`, `style`, `onBlur`, etc. pass through).
- New semantic token `--bgColor-backdrop` (modal scrim), themed.
- `ToastEntry` type is now exported.

### Fixed
- **Accessibility:** `aria-describedby` is merged (not overwritten) in `Radio`,
  `RadioGroup`, and `Tooltip`; `Menu`/`Popover` compose the caller's
  `onClick`/`onKeyDown`/`ref` on the trigger instead of clobbering them.
- **Dialog** no longer hides notification layers (`Toast`) from screen readers
  while open (layers marked `data-tenet-layer` are skipped in its `aria-hidden`
  sweep).
- **Layout:** long labels in `Menu`/`Select` and long `Accordion` titles now
  ellipsize/wrap instead of spilling; `Pagination` wraps at narrow widths; a
  global `box-sizing: border-box` reset (scoped to tenet-ui elements) prevents
  `width:100%`+padding overflow (e.g. fields inside a `Dialog`).
- **Tokens:** `Dialog` backdrop and `Switch` focus ring now use tokens instead of
  hardcoded values.
- `docs.json` catalog drift fixed (`Checkbox` `invalid`/`indeterminate`, `Select`
  `className`, `Textarea` `size`).

## 0.2.0 — 2026-06-21

- "Editorial Ink" visual identity (token-layer rebrand) across light and dark.
- Expanded to 36 components.
- Dual-package correctness: per-condition `types` in `exports` (ESM `.d.ts` /
  CJS `.d.cts`), `engines.node >= 18`. publint + @arethetypeswrong/cli clean.

## 0.1.0 — 2026-06-21

- Initial release: design tokens + React component library.
