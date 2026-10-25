---
title: Versioning
component: system
page: versioning
layer: release
related: [migrating-to-0-5, design-tokens]
updated: 2026-10-25
---

# Versioning

tenet-ui ships as one npm package, `tenet-ui`: components, icons (`tenet-ui/icons`), tokens (`tenet-ui/tokens.css`, `tenet-ui/tokens.json`), the stylesheet and the machine-readable catalog under `tenet-ui/generated/*`. Everything in it is versioned together. This page says what a version number promises, what each component status means, and how something is retired.

## Version numbers

tenet-ui follows [Semantic Versioning](https://semver.org/). Before 1.0:

- A **patch** (0.4.0 to 0.4.1) only fixes bugs. Nothing that worked stops working.
- A **minor** (0.4 to 0.5) adds features and may remove APIs that were deprecated in an earlier minor (see the deprecation policy below).

From 1.0, removals move to majors only, and a minor never breaks anything.

Every release is listed in the [Changelog](/changelog/), with Added, Changed, Deprecated, Fixed and Removed sections as needed.

## Component status

Each component's status is in its `meta.json`, in `generated/components.json`, and as a badge on its docs page.

| Status | What it promises |
|---|---|
| `stable` | Ready for production. Its props, defaults and behaviour change only through the deprecation policy. |
| `experimental` | Usable, but the API may change in any minor without a deprecation period. Not used by any component today. |
| `deprecated` | Still works, but has a named replacement and will be removed. The docs page and the deprecation registry say what to use instead and since when. |

Separately, `a11yReviewed` records whether a component has had a manual accessibility review on top of the automated checks. All 41 components are reviewed today.

## Deprecation policy

1. Nothing `stable` is removed without a deprecation first.
2. A deprecation lands in a minor release. The old API keeps working, with a warning, through every patch of that minor. The earliest it can be removed is the next minor. For example, the 0.4.0 deprecations could be removed in 0.5.0. They are kept in 0.5.0 and are removed in 0.6.0, as the changelog and every warning say.
3. Every deprecation is announced in five places at once:
   - the Deprecated section of the [Changelog](/changelog/);
   - an `@deprecated` JSDoc tag naming the replacement, so editors strike it through;
   - an entry in `generated/deprecations.json` (kind, component, prop, replacement, message, `since`), which the docs, eslint-plugin-tenet-ui and the design-system MCP server read;
   - a one-time `console.warn` in development builds (silent in production);
   - a Deprecated badge on the component's docs page.
4. `eslint-plugin-tenet-ui`'s `no-deprecated-api` rule reports every use, and autofixes prop renames.
5. Every minor that removes something has a migration guide listing each removal with before and after code. The current one is [Migrating to 0.5](/releases/migrating-to-0-5/), which covers the 0.4.0 deprecations (removed in 0.6.0) and the 0.5.0 token changes.

## Tokens

Token names are a public API: CSS reads the variables, and tools read `tenet-ui/tokens.json`. So token names follow the same policy as components. A token is not renamed or removed in a patch, and a rename keeps the old name working for at least the rest of that minor, listed in the changelog's Deprecated section.

Token values may change in a minor (a palette adjustment, for example). The contrast pairs in [Color](/foundations/color/) are re-verified by every build, so a value change cannot silently break a documented pair.

## Do / Don't

- ✅ Before moving to a new minor, read its migration guide and run `eslint --fix` with `tenet-ui/no-deprecated-api` enabled
- ✅ Treat a `tenet-ui:` deprecation warning in the dev console as a task for this minor, not the next
- ❌ Upgrading to a new minor without reading its Removed section
- ❌ Copying a deprecated component's CSS into app code to keep it alive after removal
