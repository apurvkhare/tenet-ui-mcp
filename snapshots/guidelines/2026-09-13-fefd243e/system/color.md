---
title: Color
component: system
page: color
related: [typography, accessibility, button, tag, badge, banner, card]
updated: 2026-09-12
---

# Color

Editorial Ink has one accent (clay, terracotta) and three status hues (olive success, brick danger, ochre attention) on warm paper neutrals. App code never touches a hue directly: it picks a semantic token or a component `variant`, and the token flips between `data-color-mode="light"` and `data-color-mode="dark"` on `<html>`. Every pair listed here passes WCAG AA in both themes; any pairing not listed here is unverified and an audit should flag it.

## Rules

1. App code uses only semantic tokens: `--fgColor-*`, `--bgColor-*`, `--borderColor-*`. It never references a `--base-color-*` primitive (`neutral`, `clay`, `olive`, `brick`, `ochre`, `white`, `black`) and never writes a hex, `rgb()`, or `hsl()` literal for a colour.
2. Text on surfaces: `--fgColor-default` and `--fgColor-muted` are the only body-text colours. They sit on `--bgColor-default`, `--bgColor-muted`, `--bgColor-inset`, or a soft `--bgColor-<status>-muted` tint. They are never placed on a solid `-emphasis` background.
3. Status text (`--fgColor-accent`, `--fgColor-success`, `--fgColor-danger`, `--fgColor-attention`) sits on the three neutral surfaces or on its own soft tint (`--bgColor-<status>-muted`, matched by meaning). It is never placed on a solid `-emphasis` background.
4. `--fgColor-onEmphasis` (white) is used only on `--bgColor-accent-emphasis`, `--bgColor-success-emphasis`, and `--bgColor-danger-emphasis`. It is never used on `--bgColor-emphasis` and never on `--bgColor-attention-emphasis`.
5. The ochre attention solid takes dark text: text on `--bgColor-attention-emphasis` is always `--fgColor-onAttention`. White on ochre fails AA.
6. Text on `--bgColor-emphasis` (the ink surface) is `--bgColor-default`, not `--fgColor-onEmphasis`. The two tokens are designed as inverses per theme, so the pair stays high-contrast in both modes. `Tooltip` owns this pattern; do not rebuild it.
7. Soft tints come in pairs: a `--bgColor-<status>-muted` fill always takes its matching `--borderColor-<status>-muted` hairline and `--fgColor-<status>` text. Never compute a translucent fill (`rgba(...)`, `color-mix(...)`, or `opacity` on a status colour) to fake a tint.
8. The accent appears once per surface as an action: exactly one `Button` or `IconButton` with `variant="primary"` per page, dialog, card, or toolbar. `Link` text and `Tag variant="accent"` (a selected or active token) are the only other accent uses.
9. Status colours carry status meaning only: `success` means done, passing, or published; `danger` means failed, blocked, or destructive; `attention` means a warning or something that needs action. Categories, teams, and brands are never coloured with a status variant; use `default` or `muted`.
10. `Banner` and `Toast` variants are chosen by meaning, not by the colour they produce: `info` (clay), `success` (olive), `warning` (ochre), `danger` (brick).
11. Surfaces nest inward: the page is `--bgColor-inset`, a `Card variant="default"` on it is `--bgColor-default`, and a recessed strip inside that is `Card variant="muted"` (`--bgColor-muted`). A default surface is not placed on another default surface without a `--borderColor-default` edge.
12. Borders: `--borderColor-default` for control outlines and card edges, `--borderColor-muted` for row and list separators. `--borderColor-accent-emphasis` is the focus and selected-state colour and is applied only by components.
13. Colour is never the only signal. A status is a coloured word (`Tag`), a coloured message (`FormControl.Validation`, `Banner`), or an icon plus text, never a bare coloured dot with no name.
14. Theming is not branched in JavaScript. Code never reads `data-color-mode` to pick a colour; it uses the token and lets the theme resolve it.

## AA pairs

Pairs that pass AA for normal text in both themes. The machine-readable form is `$extensions.tenet.contrast` on each `fgColor` token in `tokens/tokens.json` (`aa` and `aaLarge` lists per theme); a pair must be in the `aa` list of both themes to appear here.

| Foreground token | Allowed backgrounds |
|---|---|
| `--fgColor-default` | `--bgColor-default`, `--bgColor-muted`, `--bgColor-inset`, any `--bgColor-<status>-muted` tint |
| `--fgColor-muted` | `--bgColor-default`, `--bgColor-muted`, `--bgColor-inset`, any `--bgColor-<status>-muted` tint |
| `--fgColor-accent` | the three neutral surfaces, `--bgColor-accent-muted` |
| `--fgColor-success` | the three neutral surfaces, `--bgColor-success-muted` |
| `--fgColor-danger` | the three neutral surfaces, `--bgColor-danger-muted` |
| `--fgColor-attention` | the three neutral surfaces, `--bgColor-attention-muted` |
| `--fgColor-onEmphasis` | `--bgColor-accent-emphasis`, `--bgColor-success-emphasis`, `--bgColor-danger-emphasis` only |
| `--fgColor-onAttention` | `--bgColor-attention-emphasis` only |
| `--bgColor-default` (as text) | `--bgColor-emphasis` only (the inverse pair) |

## Do / Don't

- ✅ `<Text tone="muted" size="small">Updated 3 minutes ago</Text>` (secondary copy through the token, not a literal)
- ✅ `<Tag variant="success">Published</Tag>` (status word gets the tint, hairline, and text tokens as a set)
- ✅ `<Stack direction="horizontal" gap="condensed"><Button variant="invisible">Cancel</Button><Button variant="primary">Save changes</Button></Stack>` (one accent action)
- ❌ `<span style={{ color: '#6e6049' }}>Updated</span>` (a `neutral.650` literal; breaks in dark mode)
- ❌ `<span style={{ background: 'var(--bgColor-attention-emphasis)', color: 'var(--fgColor-onEmphasis)' }}>Pending</span>` (white on ochre fails AA; the text token is `--fgColor-onAttention`)
- ❌ `<div style={{ background: 'rgba(194, 80, 46, 0.12)' }}>` (a computed tint; use `--bgColor-accent-muted` or `Tag variant="accent"`)
- ❌ `<Button variant="primary">Save</Button><Button variant="primary">Publish</Button>` (two accents on one surface)
- ❌ `<Tag variant="danger">Design</Tag>` (a team name coloured as a failure)
