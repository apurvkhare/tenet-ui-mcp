---
title: Feedback
component: system
page: feedback
related: [banner, toast, dialog, form-control, spinner, skeleton, progress-bar, empty-state, forms]
updated: 2026-09-12
---

# Feedback

Four mechanisms report outcomes to the user: inline `FormControl.Validation`, `Banner`, `Toast`, and `Dialog`. Each answers a different combination of four questions: how long the message persists, whether it blocks, what it is about, and who caused it. Pick by those answers, never by how prominent the message should feel.

## The decision table

| Mechanism | Persists | Blocks | Scope | Initiated by | Use for |
|---|---|---|---|---|---|
| `FormControl.Validation variant="error"` | until the field is fixed | no | one field | the user's input | a field that fails validation |
| `Banner` | until the condition clears or the user dismisses | no | a page, section, or form | system state or a server response | form-level and server errors, quota and maintenance notices, a page-level warning |
| `Toast` via `useToast` | transient, auto-dismisses (default 5s) | no | the whole app, about an action that just finished | the user's own action | "Saved", "Copied", "Story published", a background failure with a retry elsewhere |
| `Dialog` | until the user decides | yes, modal | one decision | the user's action, needing confirmation or input | destructive confirmations, unsaved-changes prompts, a short focused form |

## Rules

1. Decide with three questions in order. Is it about one field? Then `FormControl.Validation`. Does the user have to decide something before continuing? Then `Dialog`. Otherwise: does it stay relevant while the user looks at this page? Then `Banner`; if it is about an action that just completed and needs no follow-up, `Toast`.
2. A field error is always inline `FormControl.Validation` on that field. It is never a `Banner`, never a `Toast`, never a `Dialog`.
3. A form-level or server error is a `Banner variant="danger"` above the fields inside the form. It is not dismissible (`onDismiss` is omitted) while the error still needs fixing.
4. A `Toast` confirms success of a completed action. It never carries information the user must act on: an error that blocks the user's task is a `Banner` or a `FormControl.Validation`, and a decision is a `Dialog`. A danger toast is acceptable only for a background failure that the user can recover from elsewhere.
5. A `Dialog` is used only when the user must decide or supply something before the flow continues. A status message ("Saved") is never a dialog. A destructive confirmation names the object in its `title` ("Delete article?") and its confirming button (`<Button variant="danger">Delete article</Button>`).
6. One channel per event. A saved form gets a toast, or a success banner, not both. A failed request gets one banner, not a banner and a toast.
7. `variant` is chosen by meaning: `success` for done, `danger` for failed or destructive, `warning` (`Banner`) for something needing attention, `info` for neutral notices. `Banner variant="danger"` and a danger toast are announced assertively (`role="alert"`); the others politely (`role="status"`). Roles are never overridden.
8. A `Banner` gets `onDismiss` only when the message is non-critical (an announcement, a tip). A dismissed critical banner cannot be recovered by the user.
9. Empty results are not feedback. Zero records is an `EmptyState`; a filter that hides every row keeps the table and speaks through `DataTable` `emptyText`. Neither is a `Banner`. See data-display.md.
10. Loading is not feedback about an outcome. A known layout loads behind `Skeleton`; an indeterminate short wait shows `Spinner` with a `label`; a measurable job shows `ProgressBar` with `aria-label`. See data-display.md.
11. `Tooltip` is a hint about a control, not a feedback channel. It never reports an outcome or an error.
12. Feedback copy states what happened and, for errors, what to do next, in sentence case without exclamation marks: `title="Could not publish"`, body "The image is larger than 10 MB. Choose a smaller file." See content.md.

## Do / Don't

- ✅ `<FormControl.Validation variant="error">Enter a valid email address.</FormControl.Validation>` (one field, inline)
- ✅ `<Banner variant="danger" title="Could not save the story">The server rejected the request. Try again in a few minutes.</Banner>` (form-level, persistent, not dismissible)
- ✅ `toast({ variant: 'success', title: 'Story published', message: 'Readers can see it now.' })` (transient confirmation of the user's own action)
- ✅ `<Dialog open={open} onClose={close} title="Delete article?" description="Readers will lose access immediately." footer={<><Button variant="invisible" onClick={close}>Cancel</Button><Button variant="danger" onClick={confirm}>Delete article</Button></>} />` (a decision that blocks)
- ✅ `<Banner variant="info" title="Scheduled maintenance" onDismiss={hide}>Publishing pauses on Sunday from 02:00 to 03:00 UTC.</Banner>` (non-critical notice, so dismissible)
- ❌ `toast({ variant: 'danger', message: 'Headline is required' })` (a field error in a toast; it disappears and is not tied to the field)
- ❌ `<Dialog title="Saved" …>` (a status message as a modal)
- ❌ `<Banner variant="danger" title="Could not save" onDismiss={hide}>` while the form still cannot be saved (a dismissible blocking error)
- ❌ Calling `toast({ variant: 'success', … })` and rendering `<Banner variant="success">` for the same save (two channels for one event)
- ❌ `<Banner variant="info" title="No stories yet">` (an empty collection is an `EmptyState`)
