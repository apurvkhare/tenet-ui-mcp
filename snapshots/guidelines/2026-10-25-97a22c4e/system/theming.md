---
title: Theming
component: system
page: theming
layer: foundation
related: [design-tokens, color, accessibility]
updated: 2026-10-17
---

# Theming

A theme swaps token values, never token names. tenet-ui ships two themes, light and dark, and 29 tokens change between them: every `fgColor`, `bgColor` and `borderColor` token, plus `shadow-focus`. Every other token (space, type, radius, sizes) is the same in both. Components and app code reference the name, so switching the theme restyles everything without touching a line of component code.

## How it works

The theme is the `data-color-mode` attribute. Set it on `<html>`:

```html
<html data-color-mode="dark">
```

`tenet-ui/styles.css` defines the light values on `:root`, so a page without the attribute is light, and redefines the 29 themed tokens under `[data-color-mode="light"]` and `[data-color-mode="dark"]`.

| Token | Light | Dark |
|---|---|---|
| `--bgColor-default` | `#ffffff` | `#1a1712` |
| `--fgColor-default` | `#2a241b` | `#f4eee3` |
| `--fgColor-accent` | `#a23e1f` | `#e9a487` |
| `--borderColor-default` | `#ddd2bf` | `#3d3528` |
| `--shadow-focus` | `0 0 0 3px #f5e4db` | `0 0 0 3px #3a2117` |

In the source, the themed tokens sit under `themes.light` and `themes.dark` with identical paths. The build drops the `themes.<theme>` part of the path, so `themes.dark.fgColor.accent` becomes `--fgColor-accent`, the same name as in light.

## Rules

1. The theme is set once, on `<html>`. `Dialog`, `Menu`, `Select`, `Popover`, `DatePicker`, `Tooltip` and `Toast` render into `document.body`, so a theme set on an inner element does not reach them.
2. Code never reads `data-color-mode` to pick a colour, and never branches on the theme in JavaScript. It uses the token and lets the theme resolve it.
3. tenet-ui does not follow the operating-system preference on its own. If the app wants it, the app sets the attribute from `prefers-color-scheme`:
   ```js
   const dark = window.matchMedia('(prefers-color-scheme: dark)');
   const apply = () => (document.documentElement.dataset.colorMode = dark.matches ? 'dark' : 'light');
   apply();
   dark.addEventListener('change', apply);
   ```
4. tenet-ui does not set the CSS `color-scheme` property. Apps that want native scrollbars and form controls to match set `color-scheme: light` or `color-scheme: dark` next to the attribute.
5. Contrast is verified per theme. The AA pairs in [Color](/foundations/color/) are checked against both themes' values at build time, and the build fails if a pair drops below its rating. Overriding a themed token in app CSS skips that check, so app code does not redefine `--fgColor-*`, `--bgColor-*` or `--borderColor-*`.

## Not supported

Stated so that nobody assumes otherwise:

- **High-contrast themes.** There is no high-contrast light or dark theme.
- **Forced-colors mode** (Windows High Contrast). Not tested. Field focus is drawn with `border-color` and `box-shadow`, which forced-colors mode overrides, so the field focus indicator is likely to disappear there. See [Accessibility](/guidelines/accessibility/).
- **Density modes.** Spacing and control sizes are the same everywhere; there is no compact or comfortable mode.
- **Brand or custom themes.** Only the two shipped themes have verified contrast pairs.

## Do / Don't

- ✅ `<html data-color-mode="dark">` (one attribute, at the root)
- ✅ `border: var(--borderWidth-thin) solid var(--borderColor-default);` (the name is the same in both themes)
- ❌ `color: theme === 'dark' ? '#f4eee3' : '#2a241b'` (branching on the theme; use `var(--fgColor-default)`)
- ❌ `<section data-color-mode="dark"><Menu /></section>` (the menu portals to `document.body` and renders in the page's theme)
- ❌ `:root { --bgColor-default: #fafafa; }` (redefining a themed token skips the contrast check)
