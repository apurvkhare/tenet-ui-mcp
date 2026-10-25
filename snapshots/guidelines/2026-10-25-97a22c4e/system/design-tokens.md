---
title: Design tokens
component: system
page: design-tokens
layer: foundation
related: [color, typography, layout, theming, versioning]
updated: 2026-10-17
---

# Design tokens

A design token is a named design decision: `--fgColor-accent` is "the colour of accent text", and the theme decides which hex that is. tenet-ui has 104 tokens in one source file, `tokens/tokens.json`, written in the DTCG 2025.10 format. The build turns it into CSS custom properties (`tenet-ui/styles.css`, `tenet-ui/tokens.css`) and a flat registry for tools (`tenet-ui/tokens.json`). The [token reference](/tokens/) lists every token with its tier, value and description.

## Three tiers

Every token carries its tier in `$extensions.tenet.tier`. The tier says what a token is for, so it decides who may use it.

| Tier | What it holds | Groups | Count | Who uses it |
|---|---|---|---|---|
| `base` | Raw values with no meaning: a palette step, a size | `base.color.*`, `base.size.*` | 39 | Semantic tokens alias them. App code never uses them. |
| `semantic` | A decision with a meaning: "default text", "danger background", "page section gap" | `fgColor`, `bgColor`, `borderColor`, `shadow`, `space`, `fontFamily`, `fontSize`, `fontWeight`, `lineHeight`, `borderRadius`, `borderWidth`, `breakpoint` | 61 | App code and components. Start here. |
| `component` | A decision that belongs to one family of components | `control.*.size`, `letterSpacing.tag` | 4 | Components; app code only to line a custom element up with controls. |

One chain, read from the top:

| Step | Light | Dark |
|---|---|---|
| App code writes `var(--fgColor-accent)` | | |
| Semantic token `themes.<theme>.fgColor.accent` | `{base.color.clay.600}` | `{base.color.clay.300}` |
| Base token | `#a23e1f` | `#e9a487` |

The semantic name stays the same in both themes; only the alias behind it changes. See [Theming](/foundations/theming/).

## Rules

1. App code uses `semantic` tokens first. It never references a `--base-*` token: base values have no meaning, so nothing tells you whether `--base-color-clay-600` is still the right colour after a theme change.
2. A token is chosen by meaning, not by value. If `--bgColor-default` and `--fgColor-onEmphasis` are both white, the role decides which one a property uses; matching the hex is not enough.
3. A value with no token is a design question, not a literal. Use the nearest token on the scale, or raise a new token; never hardcode the value.
4. Not every semantic token aliases a base token. The type, radius, border-width, shadow and breakpoint scales hold their values directly, and 9 light and 12 dark colours (the soft tints, the backdrops and the dark surfaces) are literals. The tier is about use, not about whether the value is an alias.
5. Components are the one exception to rule 1, and only for sizes. 22 of the 41 component stylesheets use `--base-size-*` directly for fixed widths and heights (icon boxes, avatars, checkboxes, tag and badge heights, progress tracks, skeleton blocks), because there are no semantic size tokens for those yet. `SegmentedControl` also uses one for padding, and the `Switch` thumb uses `--base-color-white`.
6. Token names are a public API. CSS, the registry, eslint-plugin-tenet-ui and the design-system MCP server all read them, so a name only changes through the deprecation process in [Versioning](/releases/versioning/).

## Naming

A CSS variable name is the token's path joined with `-`. For themed tokens the `themes.<theme>` prefix is dropped, which is why both themes define the same names.

| Pattern | Examples | Used for |
|---|---|---|
| `{property}-{role}` and `{property}-{role}-{emphasis}` | `--fgColor-muted`, `--bgColor-danger-emphasis`, `--borderColor-accent-muted` | Colour. `property` is `fgColor`, `bgColor` or `borderColor`; `emphasis` is `emphasis` (solid) or `muted` (tint). |
| `{scale}-{step}` with numbers | `--space-1` to `--space-6`, `--fontSize-0` to `--fontSize-5` | Ordered scales. A higher number is larger. |
| `{scale}-{size}` with t-shirt sizes | `--borderRadius-medium`, `--control-small-size`, `--breakpoint-lg` | Small sets where the names read better than numbers. |
| `{scale}-{name}` | `--fontWeight-semibold`, `--lineHeight-tight`, `--shadow-resting`, `--fontFamily-display` | Values with an obvious name. |
| `base-{kind}-{family}-{step}` | `--base-color-clay-500`, `--base-size-16` | Tier 1 only. |

## Source format

`tokens/tokens.json` follows the [DTCG 2025.10](https://www.designtokens.org/tr/2025.10/) Format and Color modules. Every token has `$value` and `$type`; most have `$description`; references use curly braces.

```json
"space": {
  "4": { "$value": "{base.size.16}", "$type": "dimension", "$description": "16px" }
},
"base": {
  "size": {
    "16": { "$value": { "value": 16, "unit": "px" }, "$type": "dimension" }
  },
  "color": {
    "clay": {
      "500": { "$value": { "colorSpace": "srgb", "components": [0.7608, 0.3137, 0.1804], "hex": "#c2502e" }, "$type": "color" }
    }
  }
}
```

| Type | Value format in the source | Serialised to CSS as |
|---|---|---|
| `color` | `{ colorSpace: "srgb", components, alpha?, hex }` | `#c2502e`, or `rgba(...)` when `alpha` is below 1 |
| `dimension` | `{ value, unit }`, unit `px` or `rem` | `16px` (`0` for zero) |
| `number` | a JSON number | `1.5` |
| `fontWeight` | a number from 1 to 1000 | `600` |
| `fontFamily` | an array of family names, most preferred first | `'Iowan Old Style', Georgia, serif` |
| `shadow` | `{ color, offsetX, offsetY, blur, spread }` | `0 1px 2px rgba(31, 27, 22, 0.06)` |

`scripts/build-tokens.mjs` checks every value against these shapes and fails the build if one is wrong, so the source cannot drift back to plain strings. The outputs (`dist/tokens.css`, `dist/tokens.json`) stay plain CSS strings, so tools that read them do not need a DTCG parser.

Where tenet-ui departs from the spec's recommendations (none of these are requirements):

- Themes are two groups in one file (`themes.light`, `themes.dark`) rather than a separate Resolver module document.
- The vendor key in `$extensions` is `tenet`, not a reverse-domain name.
- The file is `tokens.json`, not `tokens.tokens.json`.
- `letterSpacing.tag` is stored as `0.48px`. The design is `0.04em`, but DTCG dimensions allow only `px` and `rem`; every use is at `--fontSize-0` (12px), where the two are equal.

## Do / Don't

- ✅ `color: var(--fgColor-muted);` (a semantic token, so it follows the theme)
- ✅ `gap: var(--space-4);` (a step on the space scale)
- ✅ `height: var(--control-medium-size);` (a custom toolbar slot that lines up with medium controls)
- ❌ `color: var(--base-color-neutral-650);` (a base token in app code; it will not change with the theme)
- ❌ `background: var(--fgColor-onEmphasis);` (white, but chosen because of the hex: `--bgColor-default` is the background role)
- ❌ `padding: 14px;` (off the scale; use `--space-3` or `--space-4`, or ask for a token)
