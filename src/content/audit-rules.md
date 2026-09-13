# Audit rule catalog

The rules `audit_code` and `run_checks` (lint) apply. The first six are `eslint-plugin-tenet-ui`; the rest are contract rules evaluated by the server.

| Rule | Severity | Fires when | Fix hint |
|---|---|---|---|
| `tenet-ui/no-raw-color` | error | A colour literal (hex, rgb, hsl, named) appears in styles or props where a `fgColor`/`bgColor`/`borderColor` token exists | Nearest token and ΔE from `resolve_value` |
| `tenet-ui/no-raw-spacing` | error | A px/rem length appears where the `space` scale applies | Nearest `--space-*` and delta |
| `tenet-ui/no-unknown-token` | error | `var(--x)` names a token this version does not define | Nearest defined token |
| `tenet-ui/prefer-component` | error | Raw `<button>`, `<input>`, `<select>`, `<textarea>`, `<table>`, `<h1>`–`<h6>` where a component exists | The component and its import |
| `tenet-ui/require-styles-import` | error | The entry file does not import `tenet-ui/styles.css` | The runtime contract |
| `tenet-ui/no-deprecated-api` | error | A component or prop in the migration registry for the version | The replacement (autofix for prop renames) |
| `contract/boolean-explosion` | warn | Three or more related boolean props | Collapse into a `variant` union |
| `contract/missing-forward-ref` | warn | A component that renders an element does not `forwardRef` | Forward to the real element |
| `contract/restyled-primitive` | error | A system component is re-styled with raw values | Use the variant or a token |
| `contract/pixel-margin-layout` | error | Margins in px between siblings | `Stack` / `Grid` with a `gap` |
| `a11y/missing-alt` | critical | `<img>` without `alt` | Never guess; ask |
| `a11y/icon-only-without-name` | critical | Icon-only control without an accessible name | `aria-label`, or `IconButton` |
| `a11y/click-on-non-interactive` | error | `onClick` on a div/span | `Button` / `Link` |
| `types/unknown-export` | error | An import from the package this version does not export | The nearest export name |

## Rules of `audit_page` (over a page snapshot)

| Rule | Severity | Fires when | Fix hint |
|---|---|---|---|
| `contract/require-styles-import` | critical | The runtime contract reports the stylesheet did not resolve on the page | Import `tenet-ui/styles.css` once at the root |
| `runtime/console-error` | warn | The page logged errors while settling | Fix them before judging visuals |
| `runtime/theme-mismatch` | warn | `data-color-mode` differs from the theme judged | Pass `theme` or set the attribute |
| `tokens/no-token-color` | error (warn within tolerance) | A computed text, background or border colour on a page element resolves to no semantic token for the theme | Nearest token and ΔE |
| `tokens/no-token-dimension` | error | A computed font size, radius, padding or gap on a page element is not on the scale | Nearest token and delta |
| `tokens/no-token-font-family` | warn | Text set in a family that is none of the system families | `--fontFamily-body` / display / mono |
| `contrast/insufficient` | serious | Text over its effective background is below 4.5:1 (3:1 for large text) | The documented AA pairs for that text token |
| `contrast/undocumented-pair` | info | Both colours are tokens, the ratio passes, but the pair is not documented | The documented pairs |
| `a11y/missing-name` | critical (controls) / serious (form fields) | A button, link, image, tab, menu item or form field in the accessibility tree has no name and axe did not already report it | The primitive that carries the name |
| `a11y/heading-order` | warn | A heading level skips more than one step | `Heading` with `as` |
| `a11y/landmark-one-main` | warn | Zero or several `main` landmarks | One `<main>` |
| `a11y/focus-order` | warn | A focusable element comes after one that is visually below or right of it | Reorder the DOM with `Stack` / `Grid` |
| `axe/<rule>` | axe impact | Any axe violation in the snapshot or in a capture's renders | The primitive that fixes it, the guideline page |
| `visual/ssim` | info | SSIM against the design below 0.85, or a region below 0.7 | Look at both images; advisory |

Elements inside the system's own components (class `Tenet-*`) are not judged for tokens: their computed values are the package's responsibility.
