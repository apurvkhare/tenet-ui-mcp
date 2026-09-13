# The component contract

One list, used by the plan, the agent, the audit, and the checks (DESIGN.md §11).

## Component design

- Compose from primitives; never restyle one with raw values.
- Minimal typed props. Related booleans collapse into a `variant` union.
- Text content as props, with the design's text as the default.
- `forwardRef` to the real element; spread `...rest`; accept `className`.
- Layout from `Stack`, `Grid`, and spacing tokens — never pixel margins.
- One component per file; exported props interface; a story per variant; a test per `plan_tests` case.

## Accessibility

- Semantic elements first.
- Every interactive element has an accessible name.
- Missing `alt` is critical, never guessed.
- Focus order follows visual order; focus is visible.
- Colour pairs are checked against the documented contrast pairs (`tokens.contrast`).
- No text in images; meaningful icons are labeled, decorative ones `aria-hidden`.

## Styling

- Every colour, space, radius, font, shadow and border width is a `var(--token)`.
- The `base-*` palette exists to be aliased, never used directly.
- Import `tenet-ui/styles.css` exactly once at the app root; theme with `data-color-mode` on `<html>`.
