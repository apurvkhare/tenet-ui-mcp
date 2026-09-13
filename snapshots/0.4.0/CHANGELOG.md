# Changelog

All notable changes to **tenet-ui** are documented here. This project follows
[Semantic Versioning](https://semver.org/). Pre-1.0, breaking changes may land in
a **minor** release.

## 0.4.0 — 2026-09-12

tenet-ui now lives in its own repository
([apurvkhare/tenet-ui](https://github.com/apurvkhare/tenet-ui)) with a docs
site, a Storybook, an icon set, an ESLint plugin, and a type-derived catalog.
This release also carries the first **deliberate deprecations**, so consumers
(and tooling) can exercise a migration path.

### Added
- **Heading** — levels 1–4 mapped to the type scale (`--fontSize-5/4/3/2`),
  `as` to decouple the element from the size, `truncate`.
- **Text** — body copy with `size`, `tone`, `weight`, `as`, `truncate`, `align`.
- **Grid** — CSS-grid layout primitive next to `Stack`: `columns` (number or
  `{ base, sm, md, lg }`), `gap`/`rowGap` from the space scale, `Grid.Item span`.
- **Icon** and the **icon set** (`tenet-ui/icons`) — a curated subset of Lucide
  (ISC) re-packaged as React components: `size` 16 | 20 | 24, decorative by
  default, `label` makes an icon meaningful (`role="img"`). The manifest ships
  as `generated/icons.json` for tooling (icon search, docs gallery).
- **EmptyState** — title, description, decorative icon, primary and secondary
  actions; composes Heading, Text and Stack.
- **Tag** gains the status variants `success`, `danger`, `attention`, `muted`
  and is the read-only status pill when `onRemove` is absent (see Deprecated).
- **Tokens:** `fontSize.5` (36px display), `lineHeight.tight` / `.default`,
  `breakpoint.sm` / `.md` / `.lg`. Every `fgColor.*` token now carries
  machine-readable contrast pairs in `$extensions.tenet.contrast` (`aa` and
  `aaLarge` lists of `bgColor.*` tokens), copied to `dist/tokens.json` as
  `contrast` and **verified at build time** (a pair that stops meeting its
  rating fails the build).
- **Catalog:** `generated/components.json` (schema 2) is now derived from the
  TypeScript types (props, defaults, JSDoc `@default` / `@deprecated`, story
  ids), plus a small hand-kept `<Name>.meta.json` per component (`status`,
  `a11yReviewed`, subcomponent → interface mapping, `related`).
  New `generated/deprecations.json` (the migration registry) and
  `generated/guidelines/` (per-component and system guidelines, shipped in the
  tarball).
- **System guidelines** in `guidelines/system/`: color, typography, layout,
  forms, feedback, data display, iconography, accessibility, content.
- **Storybook** (React + Vite) with a light/dark toolbar, play functions on the
  interactive components, `scripts/check-a11y.mjs` (axe over every story in
  both themes), `scripts/build-baselines.mjs` (per-story screenshots at 1280,
  both themes, with a manifest) and `scripts/check-story-ids.mjs`.
- **Docs site** (`docs/`, Astro Starlight) generated from the repo: getting
  started, tokens, components with live examples, icons, foundations,
  changelog; emits `llms.txt`, `llms-full.txt`, `llms-small.txt`.
- **eslint-plugin-tenet-ui** (`packages/eslint-plugin`): `no-raw-color`,
  `no-raw-spacing`, `no-unknown-token`, `prefer-component`,
  `require-styles-import`, `no-deprecated-api`.
- `package.json` gains `repository`, `homepage`, `bugs`, and the exports
  `./icons`, `./generated/icons.json`, `./generated/deprecations.json`.

### Deprecated (still working; removed in 0.5.0)
- The `block` prop is renamed **`fullWidth`** on `Button`, `TextInput`,
  `Textarea`, `NumberInput`, `Select`, `SegmentedControl` and `DatePicker`.
  `block` keeps working with a one-time dev warning; `fullWidth` wins when both
  are passed. Codemod: `sed -i '' 's/\bblock\b/fullWidth/'` on JSX props, or
  `eslint --fix` with the `tenet-ui/no-deprecated-api` rule.
- **`Label` → `Tag`.** `Tag` now covers the read-only status pill, so one
  component owns both status words and removable chips, and the name no longer
  collides with `FormControl.Label`. `<Label variant="x">` becomes
  `<Tag variant="x">` (same variant names). `Label` renders unchanged with a
  dev warning.

### Changed
- Component folders follow one convention: `<Name>.tsx`, `.types.ts`, `.css`,
  `.stories.tsx`, `.guidelines.md` (moved from `guidelines/<name>.md`, with
  frontmatter) and `.meta.json` (replaces `.docs.json`).
- The runtime contract is one stylesheet: `import 'tenet-ui/styles.css'`
  (`src/index.ts` used to say `tokens.css`).
- Stories import from `@storybook/react-vite`.

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
