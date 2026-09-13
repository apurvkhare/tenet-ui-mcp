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
