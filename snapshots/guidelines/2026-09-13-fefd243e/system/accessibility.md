---
title: Accessibility
component: system
page: accessibility
related: [color, iconography, forms, feedback, dialog, table, toast, icon-button, form-control]
updated: 2026-09-12
---

# Accessibility

The components own roles, keyboard paths, focus rings, and announcements, so a screen built only from tenet-ui components and semantic tokens starts accessible. App code keeps it that way by naming every control, keeping the DOM order equal to the visual order, and not adding motion or colour outside the system. These are the checks an audit applies.

## Rules

1. Every interactive element has an accessible name: visible text children on `Button` and `Link`; `aria-label` on `IconButton`; `FormControl.Label` (or `aria-label`) on every field; `label` on `Checkbox`, `Switch`, `Radio`, `RadioGroup`, `Spinner`; `aria-label` on `Tabs.List`, `SegmentedControl`, `Menu`, `Popover`, `Calendar`, `ProgressBar`, and any second `Breadcrumbs` or `Pagination` on a page. A placeholder is not a name.
2. Focus order equals visual order. Layout is done with `Stack` and `Grid` in reading order; `order`, `flex-direction: row-reverse`, or positive `tabIndex` are never used to rearrange what is on screen.
3. Focus is visible. Every component ships a `:focus-visible` ring: a `--borderWidth-thick` outline in `--borderColor-accent-emphasis` on buttons, links, tabs, and choice controls, and `--borderColor-accent-emphasis` plus `--shadow-focus` on fields. App code never sets `outline: none` or overrides the ring.
4. Text colour pairs come from the AA table in color.md. Text on the ochre solid is `--fgColor-onAttention`; `--fgColor-onEmphasis` is never placed on `--bgColor-emphasis` or `--bgColor-attention-emphasis`.
5. Colour is never the only carrier of meaning. Status is a word (`Tag`), a message (`FormControl.Validation`, `Banner`), or an icon with `label` alongside text.
6. Icons are decorative (`aria-hidden`) unless they are the only carrier of meaning, in which case they take `label` (`role="img"`). An `IconButton`'s icon is always decorative because the button has `aria-label`. See iconography.md.
7. Motion honours `prefers-reduced-motion`: `Spinner`, `Skeleton`, `ProgressBar`, `Toast`, `Tooltip`, and `Accordion` reduce or drop their animation under it. App code adds no `animation` or `transition` of its own, and any motion it must add is wrapped in `@media (prefers-reduced-motion: no-preference)`.
8. `Dialog` is the only modal. It traps Tab and Shift+Tab, moves focus in on open, returns focus to the trigger on close, locks body scroll, closes on Escape and backdrop, and sets `aria-hidden` on the rest of the page (except the `Toast` layer). Its `title` is required because it is the dialog's name; `description` is wired as `aria-describedby`. App code never builds a fixed-position overlay.
9. `Popover`, `Menu`, `Select`, `DatePicker`, and `Tooltip` are non-modal and portal to `document.body`. Their `trigger` must be a focusable element (a `Button` or `IconButton`), never a `<div>` or `<span>`.
10. Tables are real tables. `Table.Header` renders `<th scope="col">`; a sortable header sets `sortDirection` so the sort control is a real `<button>` and `aria-sort` reflects `ascending` or `descending` (omitted when `none`). Rows are never rebuilt from `<div>`s.
11. Forms are wired through `FormControl`: it links the label with `htmlFor`, the caption and validation with `aria-describedby`, and sets `aria-invalid` and `required`. App code never assigns these attributes by hand, and never clobbers a component's `aria-describedby` (components merge a caller's value).
12. Announcements: `Toast` renders into a labelled `role="region"` live area; a danger toast or `Banner variant="danger"` is `role="alert"`, the other variants are `role="status"`. `Spinner` is `role="status"` with a hidden `label`. `Skeleton` is `aria-hidden`, so the surrounding container carries `aria-busy="true"` and a hidden status text. Roles are never overridden to make a message louder.
13. Headings form an outline: one `Heading level={1}` per page, ranks in order, `as` used to keep rank honest when size differs. Landmarks are not duplicated without distinct labels.
14. `Link` navigates and `Button` acts; a `Link` never has an `onClick` that performs an action, and a `Button` never navigates. `Link external` adds `rel`, `target`, and a hidden "(opens in new tab)".
15. Touch and pointer targets come from `size`: `medium` (32px) is the default control height, `small` (28px) is for dense rows only, and `large` (40px) is for primary actions on touch-first layouts. Controls are never shrunk below `small`.

## Keyboard contracts

| Family | Components | Keyboard the component provides |
|---|---|---|
| Action | `Button`, `IconButton`, `Link` | Tab; Enter (and Space for buttons) activates |
| Field | `TextInput`, `Textarea`, `NumberInput`, `DatePicker` | Native editing; `NumberInput` arrows step within `min`/`max`; `DatePicker` opens on Enter/Space, Escape closes and refocuses |
| Choice | `Checkbox`, `Switch`, `RadioGroup`, `SegmentedControl` | Space toggles; arrows move within a radio group or segmented control (selection follows focus), Home/End jump |
| Listbox | `Select` | Up/Down (skip disabled, wrap), Home/End, typeahead, Enter/Space select, Escape and Tab close |
| Menu | `Menu` | Up/Down, Home/End, Enter/Space invoke, Escape closes and returns focus to the trigger, Tab closes |
| Tabs | `Tabs` | Left/Right move and select, Home/End jump, Tab enters the panel |
| Disclosure | `Accordion` | Enter/Space toggle, Up/Down/Home/End move between headers |
| Overlay | `Dialog`, `Popover`, `Tooltip` | Escape closes; `Dialog` traps Tab; `Popover` closes when focus leaves; `Tooltip` shows on focus |
| Grid | `Calendar` | Arrows move by day, Home/End by week edge, PageUp/PageDown by month, Enter/Space select |
| Navigation | `Breadcrumbs`, `Pagination`, `Table.Header` (sortable) | Real links and buttons; Tab and Enter |

## Do / Don't

- ✅ `<IconButton icon={<TrashIcon />} aria-label="Delete story" />`
- ✅ `<FormControl required><FormControl.Label>Email</FormControl.Label><TextInput type="email" /><FormControl.Validation variant="error">Enter a valid email address.</FormControl.Validation></FormControl>` (name, required, and error all wired by the control)
- ✅ `<Tabs.List aria-label="Story sections">` and `<Menu aria-label="Story actions" trigger={<IconButton icon={<MoreHorizontalIcon />} aria-label="Story actions" />} items={items} />`
- ✅ `<Table.Header align="end" sortDirection={sort.dir} onClick={toggleSort}>Views</Table.Header>` (a real sort button with `aria-sort`)
- ✅ `<div aria-busy="true"><span className="sr-only">Loading stories</span><Skeleton variant="text" /></div>` (the container announces; `sr-only` is the app's visually hidden utility)
- ❌ `<div onClick={open} className="button">Open</div>` (no role, no keyboard, no name)
- ❌ `<Button style={{ outline: 'none' }}>` (focus ring removed)
- ❌ `<Stack direction="horizontal" style={{ flexDirection: 'row-reverse' }}>` (visual order no longer matches focus order)
- ❌ `<Tooltip content="Delete"><span>🗑</span></Tooltip>` (a non-focusable trigger; keyboard users never see the tooltip)
- ❌ `<div style={{ position: 'fixed', inset: 0 }}>…</div>` as a modal (no trap, no scroll lock, no Escape, no restore; use `Dialog`)
- ❌ `<div className="card" style={{ transition: 'transform .3s' }} />` with no reduced-motion guard (motion that ignores the user's setting)
