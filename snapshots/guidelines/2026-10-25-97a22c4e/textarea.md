---
component: textarea
related: []
updated: 2026-09-12
---

# Textarea — usage guidelines

**When to use:** multi-line free text (descriptions, comments). Use `Textarea` inside a `FormControl`, not a raw `<textarea>`.

## Rules

- Give it an accessible name via `FormControl.Label` (or `aria-label`). A placeholder is not a label.
- Use `fullWidth` to fill width (`block` is the deprecated 0.3.0 name and warns); use `rows` for initial height; let users resize vertically (`resize="vertical"`, the default).
- Use `invalid` for validation state — don't recolor the border by hand.
- **Never** hardcode border, padding, or colors — they come from tokens.

## Do / Don't

- ✅ `<FormControl><FormControl.Label>Notes</FormControl.Label><Textarea fullWidth /></FormControl>`
- ❌ `<textarea style={{ border: '1px solid #d0d7de', padding: 8 }} />` — raw element, hardcoded chrome.

**See also:** `TextInput` for single-line entry; system guideline `forms`.
