---
title: Content
component: system
page: content
related: [typography, forms, feedback, empty-state, button, tag, heading]
updated: 2026-09-12
---

# Content

Editorial Ink reads like a newsroom, not a dashboard: plain sentences, sentence case, verbs on buttons, and no exclamation marks. These rules are the defaults an agent uses when it writes UI text into a plan, and the checks an audit applies to labels, headings, and messages.

## Rules

1. Sentence case everywhere: headings (`Heading`), button labels (`Button`, `IconButton` `aria-label`), field labels (`FormControl.Label`), tags (`Tag`), tab labels, menu items, table headers, and dialog titles. Only the first word and proper nouns are capitalised: "Recent stories", "Save changes", "Publish date". Title Case and ALL CAPS are never written in app code; the tracked-caps look of `Table.Header` is applied by the component, not by the text, and `Tag` text stays sentence case ("In review", not "IN REVIEW").
2. Button labels are verbs that name the outcome: "Save changes", "Create story", "Send invite", "Add author", "Export CSV". "Submit", "OK", "Yes", "No", "Click here", and "Continue" without an object are never labels. A label is one to three words.
3. Destructive actions name the object, in the dialog title and on the button: `title="Delete article?"` with `<Button variant="danger">Delete article</Button>`. "Are you sure?" and "Confirm" are not titles or labels. The cancelling action is "Cancel" or "Keep article".
4. Empty-state copy follows one pattern: `title` names what is empty in three to five words ("No stories yet", "No authors match"); `description` says why it is empty or what to do, in one sentence ("Stories you draft or import appear here."); the `action` label is the verb that fills it ("Create story"). No exclamation marks, no "Oops".
5. Error messages say what happened, then how to fix it, in one or two sentences: "Enter a valid email address." "The image is larger than 10 MB. Choose a smaller file." "Could not save the story. Try again in a few minutes." They never blame the user ("You entered an invalid email"), never use jargon or codes alone ("Error 422"), and never apologise ("Sorry!").
6. Success and status copy states the fact in past or present tense: "Story published", "Changes saved", "3 stories imported". No exclamation marks, no "Success!", no "Awesome".
7. No exclamation marks anywhere in UI text: not in toasts, banners, empty states, headings, or captions.
8. Help text (`FormControl.Caption`) is one sentence that adds information the label does not: what the value is used for, a constraint, or a format. It never repeats the label and never starts with "Please".
9. Placeholders are examples of format only ("name@example.com", "12 Sep 2026"), never instructions ("Enter your email") and never the label.
10. Tags and statuses are one or two words, sentence case: "Published", "In review", "Needs edit". Not "PUBLISHED", not "published", not "This story has been published".
11. Dates: formatted with `Intl.DateTimeFormat` in the user's locale (`Calendar` and `DatePicker` take `locale`), never hand-assembled. Recent events use relative time in a muted caption ("3 minutes ago", "Yesterday") and switch to an absolute date after about a week ("12 Sep 2026"). Absolute dates spell the month ("12 Sep 2026", "September 12, 2026"), never all-numeric ("09/12/2026"), so day and month cannot be confused. Times include a zone when readers may be elsewhere ("14:00 UTC").
12. Numbers: formatted with `Intl.NumberFormat` in the user's locale (thousands separators, "12,480"); large counts abbreviate only in `Badge` (`max`, "99+") and in summary tiles ("1.2M" with the exact value in a `Tooltip` or caption). Numeric columns are right-aligned with `align="end"`. Units follow the number with a space ("10 MB", "3 min").
13. Product and proper nouns keep their own capitalisation ("tenet-ui", "GitHub", "Storybook", "Newsroom" when it is the product name) and are otherwise the only capitals inside a sentence-case string. Generic features are lower case ("the dashboard", "a story", "your drafts").
14. People are addressed as "you"; the product does not refer to itself as "we" or "I". Copy uses contractions where natural ("can't", "you're") and avoids idioms that do not translate.
15. Links describe their destination ("View billing settings", "Open the changelog"), never "here" or a bare URL. `Link external` adds the new-tab warning; the text does not need to say "(opens in new tab)".

## Patterns

| Slot | Pattern | Example |
|---|---|---|
| Page title | noun or noun phrase | "Stories", "Author settings" |
| Primary button | verb + object | "Create story", "Save changes" |
| Destructive button | verb + object | "Delete article", "Remove author" |
| Cancel button | "Cancel" or "Keep <object>" | "Cancel", "Keep draft" |
| Empty-state title | "No <things> yet" or "No <things> match" | "No stories yet" |
| Empty-state description | why, or what to do | "Stories you draft or import appear here." |
| Field error | what happened, how to fix | "Enter a date after today." |
| Server error banner | `title` = what failed; body = why and next step | "Could not publish" / "The image is larger than 10 MB. Choose a smaller file." |
| Success toast | `title` = fact; `message` = consequence | "Story published" / "Readers can see it now." |
| Status tag | one or two words | "In review" |

## Do / Don't

- ✅ `<Button variant="primary">Create story</Button>`
- ✅ `<Dialog title="Delete article?" description="Readers will lose access immediately." footer={<><Button variant="invisible">Cancel</Button><Button variant="danger">Delete article</Button></>} />`
- ✅ `<EmptyState title="No stories yet" description="Stories you draft or import appear here." action={<Button variant="primary">Create story</Button>} />`
- ✅ `<FormControl.Validation variant="error">Enter a valid email address.</FormControl.Validation>`
- ✅ `toast({ variant: 'success', title: 'Changes saved', message: 'The story updates for readers within a minute.' })`
- ✅ `<Text tone="muted" size="small">{new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(story.publishedAt)}</Text>`
- ❌ `<Button variant="primary">Submit</Button>` (not a verb that names the outcome)
- ❌ `<Heading level={2}>Recent Stories</Heading>` (Title Case)
- ❌ `<Dialog title="Are you sure?" footer={<Button variant="danger">Confirm</Button>} />` (neither names the object)
- ❌ `<EmptyState title="Oops! Nothing here" description="Looks like you haven't added anything yet!" />` (exclamation marks, no named object, no next step)
- ❌ `<FormControl.Validation variant="error">Invalid input</FormControl.Validation>` (no cause, no fix)
- ❌ `<Tag variant="success">PUBLISHED</Tag>` (caps written into the text; the component owns the style)
- ❌ `<Text>{story.publishedAt.toLocaleDateString()}</Text>` rendering "9/12/2026" (all-numeric, ambiguous order)
