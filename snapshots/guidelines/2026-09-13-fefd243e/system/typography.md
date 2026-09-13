---
title: Typography
component: system
page: typography
related: [heading, text, content, layout, color]
updated: 2026-09-12
---

# Typography

Two families do the work: a serif display face for headings and a humanist sans for everything else, with a monospace reserved for counts and code. The type scale is six sizes (`--fontSize-0` to `--fontSize-5`) and two line heights. App code reaches the scale only through `Heading` and `Text`; it never sets `font-family`, `font-size`, or `line-height` itself.

## Rules

1. `--fontFamily-display` (serif) is for headings only, and it reaches the page only through `Heading`. Components that own a title slot (`Dialog` `title`, `Table.Title`, `EmptyState` `title`) apply it internally. App code never sets a serif on any other element.
2. `--fontFamily-body` (humanist sans) is the default for body copy, controls, labels, and table cells. `Text` and every control apply it; app code does not restate it.
3. `--fontFamily-mono` is for counts, identifiers, hashes, and code. `Badge` applies it to counts. In app code it appears only on `<code>` or `<pre>` content, never on prose or labels.
4. The size scale is the only set of font sizes on screen. Each step has a job (see the table); nothing is set to a size between steps.
5. `Heading` `level` maps 1 to 4 onto `--fontSize-5` (36), `--fontSize-4` (28), `--fontSize-3` (20), `--fontSize-2` (16). `Text` `size` maps `small`, `medium`, `large` onto `--fontSize-0` (12), `--fontSize-1` (14), `--fontSize-2` (16). Nothing in app code is larger than `--fontSize-5`.
6. `Heading` uses `--lineHeight-tight` (1.2); `Text` and body copy use `--lineHeight-default` (1.5). Single-line controls are tight. App code does not set `line-height`.
7. Body paragraphs run 60 to 75 characters per line. Line length is controlled with layout (`Grid` `columns`, `Grid.Item` `span`, a capped container), never by shrinking the font.
8. `Heading` is for text that structures the page (page title, section, card, dialog). `Text` is for everything else (copy, captions, descriptions, cell content, inline emphasis). If a piece of text is not a section title it is `Text`, even when it is prominent (use `weight="semibold"`).
9. One `level={1}` per page. Heading ranks follow reading order without skipping. When the visual size and the document rank differ, keep the rank honest with `as` (`<Heading level={3} as="h2">`).
10. Raw `<h1>` to `<h6>` never appear in app code; they are `Heading`. A raw `<p>` or `<span>` is acceptable only when it carries no styling at all; anything styled is `Text`.
11. Weight comes through the `weight` prop of `Text`: `normal` (`--fontWeight-normal`, 400), `medium` (`--fontWeight-medium`, 500), `semibold` (`--fontWeight-semibold`, 600). `Heading` is semibold by itself (`level={4}` is medium). `--fontWeight-bold` (700) is reserved for component internals (`Banner` and `Toast` titles) and is never set by app code. Bold is not used for emphasis inside running copy; `Text as="strong"` or `weight="medium"` marks a label or a value.
12. `truncate` (on `Heading` and `Text`) is for single-line overflow in constrained cells and cards where the full text is reachable elsewhere. It is never applied to error messages, validation text, or a page title.
13. Uppercase and tracked type (`--letterSpacing-tag`) belong to component internals: `Table.Header` and a `Divider` with a text child. `Tag` text is sentence case, not caps. App code never sets `text-transform` or `letter-spacing`.
14. All headings, labels, and buttons are sentence case (see content.md).

## The scale

| Token | Size | Used for |
|---|---|---|
| `--fontSize-0` | 12px | `Text size="small"`: captions, timestamps, `FormControl.Caption`, `FormControl.Validation`, `Tag size="small"`, `Badge`, `Table.Header` |
| `--fontSize-1` | 14px | `Text size="medium"` (default): body copy, control text, `Table.Cell`, `Tag size="medium"`, menu items |
| `--fontSize-2` | 16px | `Text size="large"`: lead paragraphs; `Heading level={4}`: card and group titles |
| `--fontSize-3` | 20px | `Heading level={3}`: section titles, `Table.Title`, `Dialog` title |
| `--fontSize-4` | 28px | `Heading level={2}`: major page sections |
| `--fontSize-5` | 36px | `Heading level={1}`: the page title, one per page |

## Do / Don't

- ✅ `<Heading level={1}>Newsroom</Heading>` then `<Heading level={2}>Recent stories</Heading>` (ranks in order, sizes from the scale)
- ✅ `<Heading level={3} as="h2">Filters</Heading>` (a smaller look without lying about the outline)
- ✅ `<Text as="p" size="large">Every story in one place, from pitch to publish.</Text>` (a lead paragraph on the body scale)
- ✅ `<Text tone="muted" size="small">Edited by Ada Lovelace</Text>` (caption on the smallest step)
- ❌ `<h1 className="page-title" style={{ fontFamily: 'Georgia', fontSize: 34 }}>Newsroom</h1>` (raw heading, off-scale size, hardcoded family)
- ❌ `<p style={{ fontSize: 13, lineHeight: 1.4 }}>` (a size between steps and a line height that is not a token)
- ❌ `<Text size="large" weight="semibold">Recent stories</Text>` as a section title (a section title is a `Heading`)
- ❌ `<Heading level={1}>Total</Heading>` inside every summary card (multiple level-1 headings; card titles are `level={4}`)
