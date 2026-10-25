---
title: Migrating to 0.5
component: system
page: migrating-to-0-5
layer: release
related: [versioning, tag, button, text-input, design-tokens]
updated: 2026-10-25
---

# Migrating to 0.5

tenet-ui 0.4.0 deprecated eight APIs. They still work in 0.5.0, with a dev warning, and are removed in 0.6.0. This guide lists each one with before and after code, plus the token output changes in 0.5.0. Migrate on 0.4.x or 0.5.x, where the old and new APIs both work, before you move to 0.6.

## Quick path

1. Enable `tenet-ui/no-deprecated-api` in your ESLint config and run `eslint --fix`. It rewrites every `block` prop to `fullWidth`.
2. Replace each `Label` with `Tag` by hand (below). The rule reports them but does not rewrite them.
3. Check the dev console: no `tenet-ui:` deprecation warnings should remain.

## `block` is now `fullWidth`

Seven components renamed the prop. The behaviour is identical. If both are passed, `fullWidth` wins.

Components: `Button`, `DatePicker`, `NumberInput`, `SegmentedControl`, `Select`, `TextInput`, `Textarea`.

```tsx
// Before (0.3)
<Button variant="primary" block>Save changes</Button>
<TextInput block aria-label="Search stories" />

// After (0.4 and later)
<Button variant="primary" fullWidth>Save changes</Button>
<TextInput fullWidth aria-label="Search stories" />
```

## `Label` is now `Tag`

`Tag` takes the same `variant` values (`default`, `accent`, `success`, `danger`, `attention`, `muted`) and the same `size` values (`small`, `medium`), and is read-only when `onRemove` is absent, so it covers every `Label` use. The new name no longer collides with `FormControl.Label`.

```tsx
// Before
import { Label } from 'tenet-ui';
<Label variant="success">Published</Label>

// After
import { Tag } from 'tenet-ui';
<Tag variant="success">Published</Tag>
```

Two visible differences: `Label` set its text in tracked uppercase at semibold weight, while `Tag` shows the text as written, at medium weight. Per [Content](/guidelines/content/), tag text is sentence case ("In review"), so check that the strings you pass read well without the uppercase styling.

## Token output changes

These affect only code that reads `tenet-ui/tokens.json` or a specific token value. CSS that uses `var(--shadow-focus)` or `var(--letterSpacing-tag)` needs no change.

| Token | Before | After | Why |
|---|---|---|---|
| `shadow-focus` | One value, `0 0 0 3px var(--bgColor-accent-muted)` | Themed: `light` `0 0 0 3px #f5e4db`, `dark` `0 0 0 3px #3a2117` | Its colour differs per theme. The old value was computed once on `:root`, so a dark section inside a light page got the light halo. |
| `letterSpacing-tag` | `0.04em` | `0.48px` | DTCG 2025.10 dimensions allow only `px` and `rem`. Every use is at 12px, where the two are equal. |

In `tenet-ui/tokens.json`, a themed token has `themed: true` with `light` and `dark` values instead of `value`. Tools that read `value` should fall back to `light` (or to the active theme).

The token source, `tokens/tokens.json`, now uses the DTCG 2025.10 value formats (see [Design tokens](/foundations/design-tokens/)). That file is not in the npm package, so this only matters if you build from the repository.

## Do / Don't

- ✅ Migrate on 0.4.x or 0.5.x, where `block` and `fullWidth` both work, before 0.6.0 removes `block`
- ✅ `<Tag variant="attention">Needs edit</Tag>` (sentence case, without Label's uppercase styling)
- ❌ `<Tag variant="attention">NEEDS EDIT</Tag>` (recreating Label's caps by typing them)
- ❌ Passing both `block` and `fullWidth` "to be safe" (`fullWidth` wins and the warning still fires)
