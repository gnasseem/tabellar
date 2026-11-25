---
name: Tabellar
description: A personal email agent's window, set as a quiet docket where colour marks only what needs the user.
colors:
  canvas: "oklch(1 0 0)"
  side: "oklch(0.968 0.004 75)"
  raised: "oklch(1 0 0)"
  line: "oklch(0.912 0.004 75)"
  line-soft: "oklch(0.948 0.003 75)"
  hover: "oklch(0.968 0.003 75)"
  sel: "oklch(0.932 0.005 75)"
  field: "oklch(0.955 0.004 75)"
  ink: "oklch(0.2 0.006 60)"
  ink2: "oklch(0.4 0.006 60)"
  ink3: "oklch(0.535 0.005 60)"
  ink4: "oklch(0.7 0.004 60)"
  wax: "oklch(0.55 0.185 31)"
  wax-ink: "oklch(0.5 0.18 31)"
  wax-soft: "oklch(0.55 0.185 31 / 0.09)"
  on-wax: "oklch(1 0 0)"
  warn: "oklch(0.52 0.12 65)"
  warn-soft: "oklch(0.7 0.14 75 / 0.13)"
  warn-line: "oklch(0.7 0.14 75 / 0.4)"
  danger: "oklch(0.5 0.19 20)"
  danger-soft: "oklch(0.55 0.2 20 / 0.08)"
  danger-line: "oklch(0.55 0.2 20 / 0.32)"
  ok: "oklch(0.48 0.11 155)"
  ok-soft: "oklch(0.6 0.13 155 / 0.1)"
  ok-line: "oklch(0.6 0.13 155 / 0.35)"
  run: "oklch(0.62 0.13 150)"
typography:
  wordmark:
    fontFamily: "Ysabeau Office, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1
    letterSpacing: "0.004em"
  title:
    fontFamily: "system-ui, -apple-system, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "15px"
    fontWeight: 650
    lineHeight: 1.25
    letterSpacing: "-0.01em"
  body:
    fontFamily: "system-ui, -apple-system, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
    letterSpacing: "-0.003em"
    fontFeature: "tnum"
  status:
    fontFamily: "system-ui, -apple-system, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.375
  label:
    fontFamily: "system-ui, -apple-system, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.33
  key:
    fontFamily: "system-ui, -apple-system, SF Pro Text, Helvetica Neue, sans-serif"
    fontSize: "10.5px"
    fontWeight: 500
    lineHeight: 1
rounded:
  kbd: "4px"
  tick: "4.5px"
  row: "6px"
  control: "7px"
  inset: "9px"
  pop: "10px"
  dialog: "12px"
  dot: "999px"
spacing:
  hair: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  row-height: "32px"
  control-height: "28px"
  group-header: "34px"
  bar-height: "52px"
  sidebar-width: "224px"
  details-width: "404px"
components:
  button:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "28px"
  button-hover:
    backgroundColor: "{colors.hover}"
  button-primary:
    backgroundColor: "{colors.wax}"
    textColor: "{colors.on-wax}"
    rounded: "{rounded.control}"
    padding: "0 11px"
    height: "28px"
  button-primary-hover:
    backgroundColor: "{colors.wax-ink}"
  button-plain:
    textColor: "{colors.ink2}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "28px"
  button-plain-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.ink}"
  button-small:
    rounded: "{rounded.row}"
    padding: "0 8px"
    height: "24px"
  icon-button:
    textColor: "{colors.ink2}"
    rounded: "{rounded.row}"
    size: "28px"
  icon-button-hover:
    backgroundColor: "{colors.sel}"
    textColor: "{colors.ink}"
  input:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 10px"
    height: "28px"
  searchbox:
    backgroundColor: "{colors.field}"
    textColor: "{colors.ink3}"
    rounded: "{rounded.control}"
    padding: "0 6px 0 8px"
    height: "28px"
    width: "380px"
  segment:
    textColor: "{colors.ink2}"
    rounded: "{rounded.row}"
    padding: "0 9px"
    height: "26px"
  segment-on:
    backgroundColor: "{colors.sel}"
    textColor: "{colors.ink}"
  row:
    textColor: "{colors.ink2}"
    typography: "{typography.body}"
    rounded: "{rounded.row}"
    padding: "0 12px 0 6px"
    height: "32px"
  row-hover:
    backgroundColor: "{colors.hover}"
  row-selected:
    backgroundColor: "{colors.sel}"
  row-two-line:
    rounded: "{rounded.control}"
    padding: "9px 12px 9px 6px"
  nav-item:
    textColor: "{colors.ink2}"
    rounded: "{rounded.row}"
    padding: "0 8px"
    height: "28px"
  nav-item-on:
    backgroundColor: "{colors.sel}"
    textColor: "{colors.ink}"
  popover:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.pop}"
    padding: "4px"
  popover-item:
    textColor: "{colors.ink}"
    rounded: "{rounded.row}"
    padding: "0 8px"
    height: "28px"
  inset:
    backgroundColor: "{colors.side}"
    rounded: "{rounded.inset}"
    padding: "12px 14px"
  kbd:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink3}"
    typography: "{typography.key}"
    rounded: "{rounded.kbd}"
    padding: "2px 4px"
  tick:
    rounded: "{rounded.tick}"
    size: "15px"
  tick-on:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.canvas}"
  dialog:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.dialog}"
    padding: "20px"
---

# Design System: Tabellar

## Overview

**Creative North Star: "The Sealed Docket"**

The window is a docket, not a reading room. Every email is one quiet line that ends in what Tabellar did with it, and the only colour on a normal screen is the sealing-wax red that marks a decision waiting for the user, the primary action, and a reply counting down to send. Everything else is warm grey paper and near-black ink in graded steps, set in the system face at 13px with tabular numerals, so the window sits among native Mac productivity apps without copying one.

Density is high and calm. Rows are 32px and the top bar 52px, with no footer; hierarchy comes from ink weight and ink step, never from boxes, cards or coloured pills. The identity lives in two places only: the mark (three tablets, one sealed in wax, the channel between them forming a T) with its Ysabeau Office wordmark, and the state glyphs drawn as the seal itself. Light and dark are both first-class and share every token name.

The rejected direction is on record: a dashboard home of counts and cards, stat tiles, metaphor costumes, coloured pills on every row, and any trace of the Gmail-styled RuneMail look.

Colours, sizes and measures in this file are the defaults: sealing wax red, Comfortable, the default text size. The user can change the accent, density, text size and theme in Settings, Appearance, and every view follows through the tokens; nothing is designed for one combination.

**Key Characteristics:**
- Warm neutral surfaces (hue 60 to 75, chroma under 0.007) with a tinted sidebar and white content.
- Four ink steps carry all hierarchy; weight 650 marks a line that needs the user.
- One accent, wax red, reserved for "needs you", the primary action and the outgoing countdown.
- Amber only for held mail and cautions; red-pink danger only for failure.
- Selection is a neutral grey fill on a 6px rounded row, never an accent tint.
- Full keyboard triage; the keys are listed only in the "?" sheet, never on screen.
- No sentence explains the product or speaks for Tabellar: titles, names and one-line empty states only.

## Colors

A warm, almost colourless paper-and-ink palette with one sealing-wax red, defined in OKLCH as custom properties on `:root` and `.dark` and exposed to Tailwind through `color-mix`, so one class name serves both schemes.

### Primary
- **Sealing Wax** (wax): the dot of a line that needs the user, the ring of a reply going out, the primary button, the focus outline, the text caret, checkbox accent and the sealed tablet of the mark.
- **Wax Ink** (wax-ink): the readable text form of the accent: status text such as "Reply ready", need counts in segments and the sidebar, countdown digits, and the primary button's hover.
- **Wax Wash** (wax-soft): a faint wax tint for the rare surface that must read as "yours to decide"; selection highlight uses wax at 22%.
- **On Wax** (on-wax): text on a wax fill; white in light, a deep wax-brown in dark.

### Secondary
- **Held Amber** (warn, warn-soft, warn-line): held mail ("Held: written to an AI"), "New sender" and "No recipient" cautions, the paused engine dot.
- **Failure Red** (danger, danger-soft, danger-line): failed actions, sync error strips, destructive text buttons. Its hue (20) sits cooler than wax (31) so a failure never reads as a decision.

### Tertiary
- **Done Green** (ok, ok-soft, ok-line): confirmation states that need a positive colour.
- **Running Green** (run): only the 7px engine-running dot at the foot of the sidebar.

### Neutral
- **Paper** (canvas): the content area, and the fill of sticky group headers.
- **Tray** (side): the sidebar and quiet inset blocks such as quoted context.
- **Raised** (raised): controls, popovers and dialogs; equals paper in light, one step lighter in dark.
- **Hairline** (line) and **Soft Hairline** (line-soft): region borders, and dividers between two-line rows and inside panels.
- **Hover** (hover), **Selected** (sel), **Field** (field): row hover, the cursor row or active nav item, and input wells.
- **Ink** (ink): titles, senders, subjects. **Ink 2** (ink2): body copy in panels, default nav and row text. **Ink 3** (ink3): summaries, times, labels, placeholders, icons at rest. **Ink 4** (ink4): tick borders, link underlines, scrollbars.

### Accents
Wax is the accent, whatever its hue. The choices are Red (the default), Blue, Teal, Violet and Graphite, each with its own wax, wax ink, wax wash and on-wax for light and dark, checked at 4.5:1 or better for text on the fill and for wax ink on paper and on the selected tone. They hang on `data-accent` on the root (and on the swatches in Settings). Amber, pink and green are not offered: they mean held, failed and done. The sealed tablet of the mark follows the accent. "Wax" and "red" elsewhere in this file mean the accent.

### Named Rules
**The One Seal Rule.** Wax appears only where the user's decision is needed, on the one primary action in a region, or on a reply about to go out. A screen of handled mail has no red on it at all.

**The Amber Is Held Rule.** Amber means held back or caution, nothing else. It is never used for emphasis, warnings of style, or a second accent.

**The Same Name Both Ways Rule.** Every colour is a token with a light and a dark value under one name. No component carries a literal colour.

## Typography

**Body Font:** system-ui (with -apple-system, SF Pro Text, Helvetica Neue, sans-serif)
**Wordmark Font:** Ysabeau Office, bundled as a variable woff2 (weights 100 to 900) under the SIL Open Font Licence

**Character:** The native system face keeps the window feeling like a Mac app and lets dense lines stay crisp; Ysabeau Office, a humanist face with a lapidary edge, appears only in the wordmark beside the tablets.

### Hierarchy
- **Wordmark** (650, 0.78 of the mark size, so 17px beside the 22px sidebar mark, tracking 0.004em): the word "Tabellar" in the logo lockup and nowhere else.
- **Title** (650, 15px, tracking -0.01em): the view title in the top bar, the subject in the details panel, empty-state headings.
- **Body** (400, 13px, line-height 1.4, tracking -0.003em, tabular numerals): every row, control, menu item and panel paragraph. Panel prose loosens to line-height 1.625.
- **Status** (12.5px, 400 to 600): the status column at the end of a row and panel notes; weight rises with urgency (600 for needs you, 500 for going out, held, failed).
- **Label** (600, 12px, ink 3, sentence case): section labels such as "Going out", "Level", "The email". Plain 12px ink 3 carries meta lines.
- **First run** (650, 26px, tracking -0.018em; 14px for its two lines of text, choices and examples): the first-run steps only, where one question fills the window.
- **Key** (500, 10.5px): keyboard hints in the kbd chip.

### Named Rules
**The Weight Is The Flag Rule.** A line that needs the user is set in weight 650 for the sender and 500 for the subject; handled lines stay at 400. Size never changes inside a list.

**The Wordmark Only Rule.** Ysabeau Office is for the wordmark. Every other piece of text is the system face.

**The Sentence Case Rule.** Labels and headings are plain sentence case at normal tracking. No uppercase, no letter-spaced small caps.

**The Text Size Rule.** Small, Default, Large and Larger set the root font size (15, 16, 18, 20px). Lengths are written in px as they are at Default and turned into rem at build, so type, icons, controls and columns grow together; hairlines, outlines and shadows stay in px. A size set in code uses rem or `useSizes()`.

## Layout

A three-column window: a 224px sidebar, a flexible list, and a details panel on the right (404px by default, dragged between 320 and 760px and remembered, never leaving the list under 600px), each separated by a single hairline. Every view stacks two bands: one 52px bar (title, two or three filter segments, a flexible gap, one wide search field, at most two icons or menus) and the scrolling content. There is no footer and no second bar; a selection replaces the bar with its own actions.

Content is inset 20px from the left edge of the main column (bar, group headers, panel); list rows sit 8px in from each side so their rounded selection floats inside the column. The inbox row is a grid in rem, so it follows the text size: 26px glyph, 164px sender, flexible subject and summary, 172px status, 46px time (68px with several accounts, the account mark before the time). In a list narrower than 44rem (the details panel in a small window, large text) the summary goes and the status takes only what it needs, against the time; under 34rem a filed row shows no status, as its group says it. Sticky group headers are 34px and bottom-aligned, and show the name only (Today, Needs you, Going out): no notes, no counts. Lists are windowed, so row heights are fixed and exact (32px one-line, about 58px two-line).

Density is Comfortable (the sizes above) or Compact, through tokens: row 32 or 28px, two-line row padding 9 or 5px, group header 34 or 30px, bar 52 or 44px, menu and sidebar item 28 or 25px, a setting 52 or 42px. Controls keep their height. A footer of actions wraps rather than clips.

Rhythm is 2, 4, 8, 12 and 20px; controls are 24, 26 or 28px tall. Below 768px the filter segments collapse into a menu, the search becomes an icon button, the details panel hides, and the inbox grid drops to glyph, sender, status and time. Below 1024px the sidebar becomes a drawer over a 30% black scrim, sliding in over 200ms.

## Elevation & Depth

Flat by default. Depth comes from tone (tray sidebar beside paper content, raised controls) and hairlines. Shadows exist in exactly two roles: a whisper under controls that doubles as their edge, and a soft lift for anything floating above the window.

### Shadow Vocabulary
- **Control** (`box-shadow: 0 1px 2px oklch(0.2 0.01 60 / 0.08), 0 0 0 0.5px oklch(0.2 0.01 60 / 0.14)`; dark `0 1px 2px oklch(0 0 0 / 0.4), 0 0 0 0.5px oklch(1 0 0 / 0.12)`): standard buttons. The half-pixel ring is the button's border.
- **Primary** (`box-shadow: 0 1px 2px` wax ink at 35%): the wax button only.
- **Scrim** (30% black): under a dialog, and beside the drawer on a narrow window.
- **Pop** (`box-shadow: 0 10px 32px oklch(0.2 0.01 60 / 0.16), 0 2px 6px oklch(0.2 0.01 60 / 0.08), 0 0 0 0.5px oklch(0.2 0.01 60 / 0.14)`; dark `0 12px 36px oklch(0 0 0 / 0.5), 0 0 0 0.5px oklch(1 0 0 / 0.14)`): menus, popovers, compose, dialogs.
- **Focus ring** (`outline: 2px solid` wax, offset 1px; fields use `box-shadow: 0 0 0 2px` wax at 55%): keyboard focus and focused fields.

### Named Rules
**The Two Shadows Rule.** Controls get the control shadow, floating layers get the pop shadow. Rows, panels, group headers and inset blocks never cast a shadow.

## Shapes

Soft, small, consistent corners on a square-edged window. Rows, icon buttons, segments and menu items round at 6px; buttons, fields and two-line rows at 7px; inset blocks at 9px; popovers at 10px; dialogs and the compose window at 12px. Ticks are 15px squares at 4.5px with a 1.2px ink 4 border. Dots are full circles. Icons are Lucide outlines held at about 1.4px of stroke on screen at every size. The mark is a squircle clip holding three tablets: a full-width top bar and two lower blocks, the right one wax.

## Components

### Buttons
Quiet, native and compact.
- **Shape:** gently rounded (7px), 28px tall, 13px medium text, 6px gap to an icon.
- **Standard:** raised fill with the control shadow; hover moves to the hover tone over 150ms.
- **Primary:** wax fill, on-wax text, its own wax shadow; hover deepens to wax ink. One per region.
- **Plain:** transparent, ink 2, no shadow, 8px padding; hover fills and darkens to ink.
- **Small:** 24px tall, 6px corners, 12px text. **Danger:** standard with danger text.
- **Icon button:** 28px square, 6px corners, ink 2; hover fills with the selected tone.
- **Disabled:** 45% opacity, no pointer events.

### Segments
- **Style:** a row of 26px text buttons, 2px apart, 6px corners, ink 2. Two or three per bar. Only a segment whose items wait on the user carries a count, in wax ink and semibold.
- **State:** pressed fills with the selected tone and goes to medium ink.

### Rows
- **One-line row (32px):** 6px corners, inset 8px; the seal glyph in the first column swaps to a tick on hover or selection. Hover tone on hover, selected tone for the keyboard cursor. An inbox row is sender, subject, one-line summary, status and time, with no other mark; on hover three 24px icon buttons, Archive, Done and Snooze, cover the time. Done keeps the email in the inbox as handled ("Done", ink 3 check) until done again.
- **Two-line row:** 7px corners, 9px vertical padding, a soft hairline under it starting at 32px from the left, hidden next to a selected row.
- **Group header:** 34px, sticky, paper fill, the bold name in ink and nothing else. A foldable group (Inbox Priority: Most important, the labels, People, Updates, Promotions, Snoozed) adds a 13px ink 3 chevron after the name; Promotions and Snoozed start folded. Most important (mail from those people that waits on nothing) and Snoozed are there only when they hold something; within Needs you, those people come first. A snoozed row says "Back tomorrow 09:00" or "Until an answer" in ink 3, with Bring back on hover; once back it needs the user, "Back" or, when someone wrote, "Answered".

### Account mark
One letter in a 16px hairline square (10px semibold ink 3, 4px corners, an inset 1px line), the account's address as its tooltip: the domain's first letter, else the address's, else a number. Shown only when more than one account is connected: before the time on inbox rows, in the account switch and in Settings, Accounts. Never a colour.

### Seal glyphs
The state of a piece of mail, drawn as the seal in a 16px box: a filled wax dot (r 4) when it needs the user, a wax ring (r 3.4, 1.5 stroke) while a reply is going out, an ink 3 check when handled, an amber triangle when held, a danger triangle when failed, an ink 3 info ring for notes. Filed mail has no glyph.

### Inputs / Fields
- **Style:** field tone well, no border, 7px corners, 28px tall, 10px padding; placeholder in ink 3, caret in wax.
- **Focus:** a 2px wax ring at 55% drawn as a shadow.
- **Search:** the same well at 380px with a search icon, shrinking with the bar and to an icon button on narrow screens. In the Inbox, `is:going`, `is:handled`, `is:filed` and `is:need` filter by what Tabellar made of the mail; a search finds archived mail too, its status "Archived".

### Navigation
- **Sidebar:** tray fill, hairline right edge, logo and compose button in a 52px head. Items are 28px, 6px corners, 16px icon in ink 3 then label in ink 2, count flushed right in 12px ink 3 (wax ink and semibold for the Inbox), shown only where something waits. Active item fills with the selected tone and goes to medium ink.
- **Account switch:** only with several accounts, a 28px row above the groups: "All accounts" (mail icon) or the chosen account's mark and address, with a chevron; its popover lists All accounts and each account (check column, mark, address, "Paused" in ink 3). The choice filters the Inbox and Sent and is the From of new mail.
- **Groups:** three, separated by 12px of space with no labels: Inbox, Replies, Todos, Meetings, Follow-ups; Brief, Ask, Automations; Sent, Scheduled, Files, Labels, Newsletters. Any but the Inbox can be hidden in Settings; a hidden one shows while it is open.
- **Foot:** "Going out" with each reply's recipient, countdown in wax ink and an underlined Cancel; then, under a hairline, the level row (7px state dot: run green, amber paused, danger failed; the level name opening the level control; pause at the right), a 12px danger line only when something is wrong ("Can't reach your mail", "Sign in again" and "The model is not answering", the last two opening the setting, "Tabellar is not running"), and Settings as a nav item. History is inside Settings.
- **Level control:** four 28px rows, a check column, the level name in a 68px column and one short line in ink 3: Observe, Sorts only; Suggest, Asks first; Assist, Drafts, todos, meetings on its own; Autopilot, Also sends replies. The same control sits in the sidebar's popover and in Settings; choosing Autopilot asks to confirm.

### Popovers and dialogs
- **Popover:** raised fill, 10px corners, 4px padding, pop shadow; items are 28px, 6px corners, a check column for the chosen option, selected tone on hover.
- **Snooze menu:** a 248px popover under its button, or under the selected row for the S key: Later today, Tomorrow and Next week with their times in ink 3 at the right, Until someone answers, Pick a time (a day-and-time field with Snooze in wax, in place). Arrows and Enter work it; the first item starts chosen.
- **Dialog:** raised fill, 12px corners, 20px padding, pop shadow.

### Keyboard shortcuts
- **Sheet:** "?" opens a dialog listing every key, grouped by view, each in the kbd chip (10.5px medium ink 3 on paper, 1px hairline border, 4px corners, at least 17px wide). Keys are not shown anywhere else: no footer, no chips in buttons or the search field. A tooltip may name a key.

### Details panel
Hairline left edge with a 6px drag handle on it (hairline tone on hover; arrow keys when focused; double-click restores 404px). Sender, address and time (and "to" the user's address it came to, once they have more than one), the subject in semibold ink, the summary clamped to two lines in ink 2, then the outcomes, one 28px line each: seal glyph, a self-contained title ("Reply drafted", "Todo: Send the form", "Replying in 2:41"), and one right-aligned link (Approve or Review in wax ink; Undo, Cancel or Show). Nothing about how approval works; the reason, where there is one, is the line's tooltip. Under a soft hairline comes the email itself, rendered as in the reader. A hairline-topped strip at the bottom: the one wax button only when something waits (Approve, Review reply, Cancel reply), then Reply and Archive.

### Reader
One column at 680px. The bar is back, the subject as its title, then the one action row: Reply (standard button), Archive, Snooze and a more menu (Reply all, Forward, Mark unread, Done, Remind me if no answer, Sender is most important, Category and labels, Read again). Under the bar: the outcome lines, then the thread oldest first, each earlier message one two-line-row line (sender, snippet, time) that opens in place, the latest open in full; past eight messages the middle folds into one line, "26 more messages". Tabellar's reply sits under the thread in an inset block: "Reply drafted" with its text (its answers as rows when it leaves a decision open), Edit and send (wax) and Discard; or "Replying in" with the countdown and Cancel.

### Email body
The email's HTML is sanitised and shown in a sandboxed frame with no script, its height following its content and a layout wider than the frame scaled down to fit. Remote images and fonts are blocked until "Show images" (a link above the body, only when there are any); a blocked image gives way to its alt text. Quoted earlier messages (Gmail, Outlook, Apple Mail, plain "On ... wrote:" and ">" lines) are cut, with "Show quoted text" under the body; a forward is never cut. Mail with no HTML is set as text at 13 or 14px with links underlined. In the dark theme, dark text the email sets is lightened and near-white grounds are dropped.

### An open answer
Where an email asks the user to decide, the draft holds the answers in place of the sentence: one row each, the label in an 84px column in medium wax ink, its words in ink 2, 6px corners, hover tone on hover. Taking one gives it the selected tone and ink; taking it again opens it. Two decisions are two groups with the letter between them. Rows in Replies say "To decide" in wax ink until every answer is taken, and Send says "Choose an answer first." Keys 1, 2 and 3 take the first answer still open. In compose the text shows the labels as they are and the labels are small buttons under it. Never a dialog, never a default.

### Todos, Meetings, Follow-ups
What mail turned into, each on one screen with no side panel and no filter segments; a suggestion is an ordinary row, never its own section.
- **Todos:** an "Add a todo" field, then one-line rows grouped Today, This week, Later and Done (folded). A tick, the text, and the due day at the right in ink 3 ("Overdue" in ink 2). A todo still waiting for approval has a dashed tick, ink 2 text and "Add" in wax ink. On hover: a mail icon naming the email it came from (and opening it) and the "Not this" menu.
- **Meetings:** "To confirm" first, two-line rows growing to four: the wax dot and the title, then the day and time (with the time as the email wrote it when its zone differs), the sentence it came from in quotes with the sender, and one line of free time that day ("Free then" in ink 2, "Not free then" in amber). "Add to calendar" in wax ink; Change, the mail icon and "Not this" on hover. Then the next two weeks of Google Calendar by day, one line per event: time, title, the other people or "from" the email it is linked to. Under the one starting within the hour, and under any other on Enter or a click, 12.5px lines aligned with the title: the last thread with those people (who, subject, summary in ink 3, time), then what is open between them and the user in medium ink, each opening its email. The form for a new meeting or a changed time is a 400px column beside the list, opened only by New meeting or Change: title, length, people, place, a day-and-time field and the day's free times as small buttons.
- **Follow-ups:** one-line rows, longest wait first: the wax dot, who (650 weight), what they were asked (the sentence of the sent mail that asks or promises), and how long ago, with "Seen Sun" in ink 3 before it when a read receipt came. On hover: Nudge in wax ink (a drafted follow-up in the thread), Later (three days) and the "Not this" menu.

### Automations
One page at most 880px wide: one field on top ("When something happens, do this from now on"), then a 32px row per automation, newest first, and nothing else. A row is the sentence (ink when on, ink 2 when off), its state in 12.5px ink 3 ("On its own, ran 14 times", "Off", "Looking", or "2 to approve" in semibold wax ink with the wax dot) and a switch. It opens in place to an inset block: When and Then as a 44px ink 3 column, what will run in ink, in the server's own words; under a soft hairline what it would have matched ("7 of 72 emails in the last 30 days", then who, subject, the quoted words in ink 3, time), and, once it has run, what it did, a 28px line each with Undo, or Approve and Dismiss; then Turn on (small, wax, only while off), two segments On its own and Asks first, and Edit and Delete in plain. Turning it on for the first time opens it first. With none, "Ready to try" lists six sentences with Try. A sentence being read shows as a row with "Reading"; what is wrong with one is a danger line under the field.

### Brief, Ask, History, Files, Labels, Newsletters
- **Brief:** one page, left-aligned at most 880px, under a bar with the title and the date in ink 3. Four group headers: "Needs you today" (at most five one-line rows: wax dot, who in 650 weight, what in 500 ink, when in ink 3, one action in wax ink: Review, Approve, Add to calendar, Done, Answer, or Open for mail back from snooze and Read for unread mail from the most important people; then "N more in the inbox" as a link), "Waiting on others" (who, what they were asked, how long, Nudge), "Today's calendar" (time span, title, the other people; past events in ink 3; the next hour's meeting with its lines, as in Meetings) and "Handled for you" (one row with an ink 3 check, "18 emails since yesterday" and Show, opening to one row per email with what was done). What an automation gathered is a "Digest" group after the needs: one row with the count and its sentence in ink 3, opening to a row per email. An empty section is one ink 3 line. Settings, Brief chooses the sections and whether they have 3, 5 or 10 lines; a settings icon in the bar opens it. Off by default, a paragraph of at most 60 words opens the page, 13px ink at line-height 1.625 and 68ch, a skeleton bar while it is written.
- **Ask:** past conversations in a 232px column on the left (New conversation, then titles under day labels, delete on hover); the open one at 720px, user messages on a field-tone bubble at the right, answers as plain 14px text at line-height 1.6, what was done as one 12px ink 3 line with a link to its page. A cleanup plan sits in the answer that started it: "Cleanup plan" in medium ink with its state ("Has a question" in wax ink when it asks), its steps, its questions and, when ready, its proposals grouped by kind with ticks and Run in wax. Below 768px the conversation list becomes a button in the bar.
- **History:** reached from Settings (a back chevron before the title). Newest first under day headers, one 32px row per action: glyph, what, the email, why when it was not done by Tabellar itself, then Undo (or "Working" while it runs, Cancel and the countdown for a reply going out). A Kind menu filters; there are no proposals here.
- **Files:** one 32px row per attachment, newest first: a 15px ink 3 kind icon, the file name in ink, who it came from ("To ..." for one sent; a click lists only theirs), the email's subject in ink 3, size and time. A Kind menu filters. On hover: the email and Download. Enter looks at the file in a dialog. A search also asks the mailboxes; what it finds beyond the kept mail is under "Elsewhere in your mailboxes".
- **Labels:** the user's labels as 32px rows: colour dot (a grip on hover, the row drags to reorder; Alt Up and Down move the cursor row), name, the line that says which mail belongs, the Gmail label it maps to, and how many emails carry it. "Suggested" rows below, with Add and, on hover, Not now. A label opens in a 400px column beside the list: name, eight colour swatches, which mail belongs, Gmail label (with the user's own labels offered), examples (senders and, for emails put in by hand, their subjects) and Save in wax, Delete in danger text.
- **Newsletters:** one row per sender: name, address, how many in the inbox, then why it is listed in ink 3 ("Gmail Promotions, 14 emails, none opened"), which gives way on hover to Unsubscribe, Archive all and Keep.

### Questions and "Not this"
- **Question row:** one 32px row at the top of the Inbox list, an ink 3 info ring, "A question" (or "2 questions") in medium ink and a chevron. It opens in place: each question in ink, what Tabellar would do in 12.5px ink 3, then its answers as small buttons, the last ("Not now") plain. No wax: a question is asked, not demanded. Hidden when nothing is open.
- **Not this menu:** a 28px "more" icon button at the end of a todo, proposed meeting, follow-up or newsletter row, shown on hover, on the cursor row and while open. Its popover holds "Not this" (for a newsletter, "Not a newsletter"), "Never for <sender>" and "Not interested in this topic", which turns into a field and Save in place.

### Settings
- **Frame:** a 200px column of sections (28px items, the window's nav style), then one column of at most 680px: the section name as a 15px title, groups of rows under 12px labels between soft hairlines, at most one 12px ink 3 note under a group. Sections: General, Accounts, About you, Writing, Signatures and templates, Appearance, Brief, Notifications, Hours and calendar, Models, then History. Nothing has a save button except the signature and template editors: each control keeps what it shows at once and "Saved" shows in the bar for a moment.
- **Row:** 52px, the name in ink and at most one line about it in ink 2 at 12px, the control at the right: a switch, segments, a select, a 120px time field, or a 260px text field that saves when left. Settings that only matter after another choice (Autopilot's limits, the Brief's tone) appear with it.
- **Lines:** facts and rules as plain rows edited in place on click, the source in 12px ink 3 at the right, delete on hover; Add on the group's label line.
- **Writing:** segments for Everyone, Your organisation, People you know and Strangers over the four lines (Greeting, Sign-off, Tone, Length); an empty line shows what everyone gets as its placeholder and says "As for everyone", a line set by hand says "You set this". Then one switch, Keep reply drafts in the mailbox's Drafts too, Rules, Phrases to avoid (24px field-tone tags with a remove mark, the add field in the same run) and Sample reply: the email it answers in ink 2, the reply in an inset block.
- **About you:** Role and Working on as fields, other facts, rules (when there are any; a new one is a sentence in Automations), open questions with their answers and the answered ones folded ("Ask again" takes one back), people (the most important first, by name and address, with what they are in a select), domains, topics.
- **Appearance:** Theme, Accent (14px dots in 28px squares, the chosen one on the selected tone), Density, Text size, and ticks for what the sidebar shows.

### Compose
- **Keeps what is written:** the X and the minimised bar's X save a draft when something was written, another message takes the window only after that, and the bin discards with Undo. Undo on a send opens the message again. The signature shows under the text as it will look, with a mark to leave it out.
- **Footer:** Send in wax, Send later, Rewrite, then two icons: attach, and a more menu for what few emails need (Templates, Set up a meeting, Ask for a read receipt); Save draft and discard at the right. A receipt asked for is one 12px ink 3 line with Remove.
- **Forward:** the email handed on as an inset block under the text: subject and sender, two lines of it, its files with a mark to leave each out. The note is drafted once there is someone to send it to, and never over what the user has typed.

### Undo
Z takes back the last change of the last ten minutes, then the one before. Every toast with Undo is one of them, and a change too small for a toast (Done, a label) is kept all the same. The toast it offered goes; "Undone: ..." says what. With none of the user's own left, the last thing Tabellar did is offered in a toast, and Z again takes it.

### Menu bar
The mark as a template image (one tablet across the top, two below) with the Needs you count beside it, nothing when it is zero, dimmed while paused. Its menu: "4 emails need you", Open Tabellar, Pause or Resume.

### Accounts
- **Compose From:** a row above To, only when there is more than one address to send from: every address of every account (grouped by account when there are several), "Name <address>" where Gmail gives a name. A reply starts on the address the email was sent to; new mail on the account the switch shows, else the default account's From.
- **Settings, Accounts:** one row per account: mark, address and "Default" in ink 3; the line under it names the provider and says "Paused" or which other addresses it sends as. At the right a From menu (only with aliases), a switch for reading its mail, and a more menu: Make default, Sign in again (Change the app password for an IMAP account), Remove (danger text, confirmed). "Add an account" sits on the group's label line and opens the add panel in place, above the rows.
- **Adding a mailbox** (`AddMailbox.tsx`, in the first run's Mail step and in Settings): the choices from the server's list as tiles, three to a row (54px, 9px corners, raised with the control shadow; the chosen one fills with the selected tone and loses the shadow), each with its name and a short hint in ink 3. The chosen one's step sits under them: a sign-in button for Google and Outlook (Outlook first asks for the Azure app's client ID in one mono field), or Address and App password fields with a "Make one at ..." link on the label line, plus servers, ports and user name for Other. One primary button ("Add iCloud", "Checking" while the servers are tried); errors in danger text under it.

### First run
- **Frame** (`Step` in `SetupSteps.tsx`): the full window on paper. A 52px head with the logo and the step names at the right (done ones with the ink 3 check and clickable, the current in medium ink, the rest in ink 3); one column of 400px with the question (26px, weight 650), at most two lines in ink 2 at 14px, and the controls; what the question is about beside it; a 60px foot under a hairline with the live line at the left and Back, Skip and the one wax button at the right. Content is at most 1,320px wide; below 1,024px it is one column. The step content rises in once (420ms, ease-out), never again. The only screens in the window with a foot and with type above 15px.
- **Live line:** what the server is doing meanwhile ("Reading the last 90 days", a 96px bar, "207 of 1,902 emails", the model download beside it), in 12.5px ink 2. A failure is a danger glyph and danger text; done is an ink 3 check.
- **Welcome:** no foot and no step names; a title, two lines, one wax button and a picture of the Inbox drawn with the window's own rows.
- **Model:** two radio blocks (9px corners, selected tone when on), each a name, its trade-off in ink 3 and one line of what it means here; what is chosen beside them (the pair with sizes, or the provider and key). The full model lists sit behind "Advanced".
- **Examples and lists:** hairline-ruled rows, never cards: a question in 12px ink 3, the thing in 14px medium ink, where it came from in 12.5px ink 3, then Yes, No and "Never for <name>" as small buttons in fixed columns. An answered row keeps its place and shows the answer in words.
- **People and labels:** ticks, with a label's name editable in place; a dropped label is struck through in ink 3.

### Empty and loading
- **Empty:** centred column at most 380px wide, 22px ink 3 icon, 15px title, and at most one line under it: a link to the way out. No explaining paragraph.
- **Loading:** skeleton bars in the field tone at row height, pulsing to 45% over 1.4s. No spinners.

## Do's and Don'ts

### Do:
- **Do** let wax mark only needs you, the one primary action and the outgoing countdown.
- **Do** say state in words at the end of each row ("Reply ready, todo added", "Replying in 3:26") beside the seal glyph.
- **Do** carry hierarchy with ink steps and weight 650, at one body size of 13px with tabular numerals.
- **Do** use the neutral selected tone (sel) on 6px rounded rows for selection and the active nav item.
- **Do** build views from the shared parts: bar, segments, rows, group header, popover, inset, empty state.
- **Do** keep icons to the bundled Lucide set at about 1.4px stroke, 16px in navigation and bars.
- **Do** give every motion a reduced-motion fallback; colour transitions run 150ms.

### Don't:
- **Don't** build a dashboard of counts, stat tiles or cards.
- **Don't** put coloured pills, badges or category chips on rows.
- **Don't** use metaphor costumes (post office sorting cases, flight strips, ticket stubs).
- **Don't** tint selection with the accent or use wax as decoration.
- **Don't** use amber for anything but held mail and cautions.
- **Don't** set any text but the wordmark in Ysabeau Office, and don't use uppercase or letter-spaced labels.
- **Don't** add shadows to rows, panels or inset blocks, or put borders on inputs.
- **Don't** keep any Gmail or RuneMail colours, green T icon or Google-blue accents.
- **Don't** load fonts or icons from outside the app; both are bundled.
