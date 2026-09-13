---
title: Forms
component: system
page: forms
related: [form-control, text-input, textarea, number-input, select, date-picker, checkbox, radio-group, switch, button, feedback]
updated: 2026-09-12
---

# Forms

A form is a `Stack` of `FormControl`s, each wrapping one field, followed by one row of actions with a single primary button. `FormControl` wires the id, `htmlFor`, `aria-describedby`, `aria-invalid`, `required`, and `disabled` between its label, field, caption, and validation, so app code never sets those by hand.

## Rules

1. Every text-like field (`TextInput`, `Textarea`, `NumberInput`, `Select`, `DatePicker`) is wrapped in a `FormControl` containing, in this order: `FormControl.Label`, the field, an optional `FormControl.Caption`, an optional `FormControl.Validation`.
2. One field per `FormControl`. Two inputs that belong together (a min and a max) are two `FormControl`s side by side in a `Grid`, not one control with two fields.
3. `Checkbox`, `Switch`, and `RadioGroup` carry their own `label` (and `caption`) and are not wrapped in a `FormControl`. `RadioGroup` renders the `<fieldset>`/`<legend>`; `Radio` children each have a `label` and a unique `value`.
4. The label is always visible. `FormControl.Label visuallyHidden` is allowed only for a single search-style field whose purpose is obvious from a `leadingVisual` icon and `placeholder`, such as a toolbar search. A form with two or more fields shows every label.
5. A placeholder is never the label and never the help text. `placeholder` shows an example of the expected format only (`"name@example.com"`). Instructions go in `FormControl.Caption`.
6. Required fields are marked with `required` on the `FormControl`. It propagates `required` to the field and renders the marker on the label. Required is never signalled by text alone ("(required)") or by colour alone, and optional fields are not marked.
7. A field-level error is `FormControl.Validation variant="error"` inside that field's `FormControl`. It sets the field to invalid (`aria-invalid`, danger border) and is announced through `aria-describedby`. Field errors never appear in a `Banner` or a `Toast`.
8. A form-level or server error (the request failed, the combination of fields is invalid) is a `Banner variant="danger"` placed above the fields inside the form. Known field errors from the server are still mirrored into each field's `FormControl.Validation`.
9. Validation text says what happened and how to fix it in one sentence, sentence case, no exclamation mark: "Enter a valid email address." (see content.md). `variant="success"` confirms a field only when confirmation carries information (a username is available), not after every valid keystroke.
10. Errors are shown on submit or on blur after the user has left the field, not on the first keystroke. The submit button stays enabled; validation runs and the first invalid field receives focus.
11. Field widths come from layout, not from the field. A field fills its column with `fullWidth` inside a `Stack.Item` or `Grid.Item`. Short values (`NumberInput`, `DatePicker`, a postcode) sit in a narrower `Grid.Item span` rather than stretching full width. Pixel widths are never set on a field. (`block` is the deprecated 0.3.0 name for `fullWidth`; it still works with a warning.)
12. Fields are stacked in a `<Stack gap="normal">`. Related groups get a `Heading level={3}` (or `level={4}`) above their own `Stack`; a form is never split into one `Card` per field.
13. Actions sit in one `<Stack direction="horizontal" gap="condensed">` after the fields. Exactly one `Button variant="primary"` per form; the cancel or back action is `variant="invisible"` or `variant="default"`. In a `Dialog`, actions go in `footer` with the primary action last.
14. Button labels are verbs that name the outcome: "Save changes", "Create story", "Send invite". "Submit", "OK", and "Yes" are not labels. A destructive submit is `variant="danger"` and names the object: "Delete article".
15. The form is a native `<form onSubmit>`; every field has a `name` so posting and autofill work. `Select` and `DatePicker` emit hidden inputs for `name`.
16. While submitting, the primary button is `disabled` and shows a `Spinner size="small"` with a present-tense label ("Saving…"); fields are not hidden or replaced.

## Do / Don't

- ✅
  ```tsx
  <form onSubmit={submit}>
    <Stack gap="normal">
      {serverError && <Banner variant="danger" title="Could not save the story">{serverError}</Banner>}
      <FormControl required>
        <FormControl.Label>Headline</FormControl.Label>
        <TextInput name="headline" fullWidth />
        <FormControl.Caption>Shown in search results and social previews.</FormControl.Caption>
        {errors.headline && <FormControl.Validation variant="error">{errors.headline}</FormControl.Validation>}
      </FormControl>
      <Grid columns={{ base: 1, sm: 2 }} gap="normal">
        <FormControl>
          <FormControl.Label>Section</FormControl.Label>
          <Select name="section" options={sections} placeholder="Choose a section" fullWidth />
        </FormControl>
        <FormControl>
          <FormControl.Label>Publish date</FormControl.Label>
          <DatePicker name="publishAt" fullWidth />
        </FormControl>
      </Grid>
      <Checkbox name="notify" label="Notify subscribers" caption="Sends the daily digest early." />
      <Stack direction="horizontal" gap="condensed">
        <Button variant="invisible" type="button" onClick={cancel}>Cancel</Button>
        <Button variant="primary" type="submit">Save changes</Button>
      </Stack>
    </Stack>
  </form>
  ```
- ✅ `<FormControl><FormControl.Label visuallyHidden>Search stories</FormControl.Label><TextInput leadingVisual={<SearchIcon />} placeholder="Search stories" /></FormControl>` (the one case for a hidden label)
- ❌ `<TextInput placeholder="Headline" />` with no `FormControl.Label` (placeholder as label; disappears on input, no accessible name)
- ❌ `<FormControl.Caption>Required</FormControl.Caption>` (required by text; use `required` on the `FormControl`)
- ❌ `toast({ variant: 'danger', message: 'Headline is required' })` for a field error (the error must sit on the field as `FormControl.Validation`)
- ❌ `<label>Email</label><input style={{ border: '1px solid #ddd2bf' }} />` (raw elements, label not associated, hardcoded chrome)
- ❌ `<Button variant="primary">Submit</Button><Button variant="primary">Save draft</Button>` (two primaries; "Submit" is not a label)
- ❌ `<TextInput style={{ width: 280 }} />` (pixel width; size the `Grid.Item`, use `fullWidth`)
