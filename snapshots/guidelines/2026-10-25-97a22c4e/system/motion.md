---
title: Motion
component: system
page: motion
layer: foundation
related: [accessibility, feedback, spinner, skeleton, progress-bar, toast, tooltip, accordion, switch]
updated: 2026-10-17
---

# Motion

Editorial Ink barely moves. Motion confirms that something responded (a hover, a toggle, a new toast) and shows that something is still working (a spinner, a skeleton). It never decorates. All motion lives inside components; app code adds none of its own.

tenet-ui has no motion tokens yet. The durations below are written in each component's CSS, and this page records them so that new components match.

## The steps

| Step | Duration and easing | Used for | Components |
|---|---|---|---|
| Feedback | `0.12s ease` | Colour, border and shadow changes on hover, focus and selection | `Button`, `IconButton`, `TextInput`, `Textarea`, `NumberInput`, `Select`, `DatePicker`, `Tabs`, `SegmentedControl`, `Pagination`, `Calendar`, `Table` (row hover), `Accordion` (header background), `Tooltip` (fade) |
| Movement | `0.16s ease` | Something changes place or appears | `Switch` (track colour and thumb slide), `Accordion` (chevron turn), `Toast` (enter) |
| Progress | `0.3s ease` | A determinate bar filling | `ProgressBar` |
| Loop | `0.6s linear` to `1.6s ease-in-out`, infinite | Work in progress | `Spinner` (spin), `Skeleton` (shimmer), `ProgressBar` (indeterminate sweep) |

## Reduced motion

Under `prefers-reduced-motion: reduce`, the components that move or loop change what they do:

| Component | Normal | Reduced |
|---|---|---|
| `Spinner` | Spinning ring | Slow opacity pulse (1.2s) |
| `Skeleton` | Moving shimmer | Slow opacity pulse (1.6s) |
| `ProgressBar` (indeterminate) | Sweeping bar | Full-width bar with an opacity pulse (1.6s) |
| `Toast` | Fades and slides up | Appears with no animation |
| `Tooltip` | Fades | Appears with no transition |
| `Accordion` | Chevron turns | Chevron jumps |

The colour, border and shadow transitions in the Feedback row do not move anything, so they are not reduced (the `Tooltip` fade is). `Switch` is the one gap: its thumb still slides (`0.16s`) under reduced motion.

## Rules

1. Motion comes from components. App code writes no `animation` or `transition` of its own. When it must, the rule sits inside `@media (prefers-reduced-motion: no-preference)` and uses a duration from the table above.
2. Nothing moves to draw attention. Status changes are announced with words (`Toast`, `Banner`, `FormControl.Validation`), not with shaking, bouncing or flashing.
3. Loops are for work in progress only, and stop when the work stops. A `Spinner` or `Skeleton` is removed as soon as the content arrives.
4. Durations stay short. Nothing in tenet-ui takes longer than 0.3s to finish, except the progress loops.

## Do / Don't

- ✅ `<Skeleton />` while a list loads (the component reduces its own motion)
- ✅ `@media (prefers-reduced-motion: no-preference) { .chart-bar { transition: height 0.16s ease; } }` (app motion behind the media query, on the Movement step)
- ❌ `.card:hover { transform: scale(1.03); transition: transform 0.4s; }` (decorative, too slow, and ignores reduced motion)
- ❌ `@keyframes shake { ... }` on an invalid field (use `FormControl.Validation` text instead)
