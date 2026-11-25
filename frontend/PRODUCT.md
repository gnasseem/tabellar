# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: someone on a Mac who installed Tabellar from npm and lets it handle their mail (Gmail first, also Outlook and IMAP mailboxes). They open the window a few times a day on one short list, answer it in place, and step in when something needs them. The design is judged first against this release user, a newcomer who must understand the window without a guide. The author uses it daily on his own NYU mailbox and comes second.

## Product Purpose

Tabellar is a personal email agent that runs entirely on the user's Mac. A background engine reads new Gmail within seconds of its arrival, sorts it, drafts replies, pulls out todos and meetings, tracks unanswered mail, and, at the level the user chooses, acts on its own. Success is the user trusting it enough to stop living in their inbox: they check Tabellar, not Gmail.

## Positioning

Local and personal: mail stays in one SQLite file on the Mac, the model can run locally through Ollama, there is no hosted service and no sign-up. It is an agent with standing, bounded permission (Observe, Suggest, Assist, Autopilot), not an inbox client with AI features bolted on. Every action is logged, undoable where possible, and authorised in one policy module.

## Operating Context

- The window is a local web page served by the Tabellar process on 127.0.0.1, opened with `tabellar open`. The terminal is only for install and control.
- The engine works with the window closed and reaches the user through macOS notifications.
- The user still has Gmail itself for reading and writing mail by hand.

## Capabilities and Constraints

- Engine levels: Observe (sorts and notifies), Suggest (labels mail; drafts, todos and meetings wait for approval), Assist (labels, drafts, todos, meeting proposals happen on their own), Autopilot (also replies to the writer in-thread after a cancel window, daily cap). One Pause switch stops everything. It never deletes, and never archives on its own except as an automation the user wrote says (a snoozed email is archived at the user's word and returned).
- History (in Settings): the action log, with undo. Proposals wait on the page they belong to (Replies, Todos, Meetings, the Inbox), and approval is bound to a hash of the exact proposal.
- A profile of the user (facts, people, domains, topics, rules) that every prompt reads and every "Not this" feeds. Before a todo or draft from a sender the user does not know, Tabellar asks one question, in the Brief, instead of guessing; at most three questions are open at once. Settings > About you lists and edits all of it, with the answered questions.
- Reply drafts written from the thread, other mail with the person, attachments, todos and the calendar, and checked in code for anything those do not say. A decision the email asks for is left to the user as answers to choose from, only then. They are in the mailbox's own Drafts too, kept in step both ways.
- How the user writes, learned from 200 sent emails and from what they change in drafts: greeting, sign-off, tone and length for everyone and for their organisation, people they know and strangers; phrases to avoid and rules, checked in code after every draft; a sample reply to try it. All editable in Settings > Writing. In compose, a described change can be kept as a rule.
- Personal to the user: light, dark or auto, accent, density, text size and what the sidebar shows; the Brief's time, length, sections, and an optional opening paragraph with its tone; notifications for what needs them, only for the people marked most important, or none, quiet outside working hours if they choose.
- The Brief, where the window opens: what needs the user today, who owes them an answer, today's calendar, what was handled; each line answered in place, with at most three answers on it, and every answer undone by bringing the line back. Drafts, todos, meetings with calendar free slots, follow-ups for unanswered sent mail, newsletter cleanup (unsubscribe, archive a sender), the user's own labels (with examples, mapped to Gmail labels, ordering the Inbox), and Ask: questions about the inbox, kept as conversations, and a cleanup plan started there that runs only what is approved.
- Several mailboxes in one merged inbox (Gmail; Outlook and Microsoft 365 through Graph once the user registers an Azure app; iCloud, Fastmail, Yahoo and any IMAP mailbox with an app password, which have no calendar), with a switch to one account, a default account and a pause per account; every alias in Gmail's "Send mail as" list can be the From, and a reply goes out from the address the mail was sent to. Local or cloud models in two slots.
- Direction from the author (2026-11-23): the inbox stays a list of emails one after another, but each row shows its status, what Tabellar did with it and where the result went. Most of the user's time is spent on the pages that show what their mail turned into (replies to send, todos, meetings, follow-ups and more) rather than on reading messages. It must hold up for a busy mailbox: hundreds of emails a day, long todo and draft lists. A separate dashboard of counts and cards was tried and rejected.
- First run in the window: mailbox, model (downloaded in the background), About you filled in from sent mail, about ten examples from the user's own mail to answer, people and labels, level. One decision per screen, every step after the mailbox can be skipped, none waits on the model, and nothing is planned until the level is chosen. Settings opens the steps again.
- Automations: one sentence each, read once into something checkable, read back in plain words, shown on the last 30 days before it can be turned on, run on its own or asking first, capped, logged and undoable. The one way the user changes what Tabellar does for good, whether the sentence turns out to be an automation or a rule.
- Snooze until a time or an answer; people marked most important, who drive sorting, notifications and the Brief; undo on one key for ten minutes of changes; a read receipt on request; forwarding with a drafted note; every attachment by name, sender or kind. On its own: the Brief's first three lines as a notification at its time, what is open with the people of a meeting an hour before it, and a menu bar item with the count and Pause.
- macOS only for the first release.

## Brand Commitments

- Name: Tabellar, from the Latin tabellarius, the Roman letter carrier who ran sealed tablets between people. The identity draws on the courier: a trusted runner who carries and handles your mail. Confirmed by the author.
- No RuneMail naming or look may remain. The current green "T" icon and Gmail-inspired palette are leftovers, not commitments.
- MIT licence, distributed through npm and GitHub only; no website.

## Evidence on Hand

- The author's real inbox for verification. No testimonials, users or benchmarks exist; none may be invented.

## Product Principles

1. Show what Tabellar did and what it is waiting on before anything else.
2. Trust is earned by legibility: every action says what, why, and how to undo it.
3. The user's attention is the scarce resource; Tabellar spends it only on what needs a decision.
4. Nothing leaves the mailbox without the user having set the limits for it.
