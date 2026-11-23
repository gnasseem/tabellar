# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: someone on a Mac who installed Tabellar from npm and lets it handle their Gmail. They open the window a few times a day to see what Tabellar did, approve what it is waiting on, and step in when something needs them. The design is judged first against this release user, a newcomer who must understand the window without a guide. The author uses it daily on his own NYU mailbox and comes second.

## Product Purpose

Tabellar is a personal email agent that runs entirely on the user's Mac. A background engine reads new Gmail within seconds of its arrival, sorts it, drafts replies, pulls out todos and meetings, tracks unanswered mail, and, at the level the user chooses, acts on its own. Success is the user trusting it enough to stop living in their inbox: they check Tabellar, not Gmail.

## Positioning

Local and personal: mail stays in one SQLite file on the Mac, the model can run locally through Ollama, there is no hosted service and no sign-up. It is an agent with standing, bounded permission (Observe, Suggest, Assist, Autopilot), not an inbox client with AI features bolted on. Every action is logged, undoable where possible, and authorised in one policy module.

## Operating Context

- The window is a local web page served by the Tabellar process on 127.0.0.1, opened with `tabellar open`. The terminal is only for install and control.
- The engine works with the window closed and reaches the user through macOS notifications.
- The user still has Gmail itself for reading and writing mail by hand.

## Capabilities and Constraints

- Engine levels: Observe (sorts and notifies), Suggest (labels mail; drafts, todos and meetings wait for approval), Assist (labels, drafts, todos, meeting proposals happen on their own), Autopilot (also replies to the writer in-thread after a cancel window, daily cap). One Pause switch stops everything. It never deletes, and never archives on its own.
- History (in Settings): the action log, with undo. Proposals wait on the page they belong to (Replies, Todos, Meetings, the Inbox), and approval is bound to a hash of the exact proposal.
- A profile of the user (facts, people, domains, topics, rules) that every prompt reads and every "Not this" feeds. Before a todo or draft from a sender the user does not know, Tabellar asks one question instead of guessing; at most three questions are open at once. Settings > About you lists and edits all of it.
- The Brief (what needs the user today, who owes them an answer, today's calendar, what was handled), drafts, todos, meetings with calendar free slots, follow-ups for unanswered sent mail, newsletter cleanup (unsubscribe, archive a sender), the user's own labels (with examples, mapped to Gmail labels, ordering the Inbox), and Ask: questions about the inbox, kept as conversations, and a cleanup plan started there that runs only what is approved.
- Several Gmail accounts. Local or cloud models in two slots.
- Direction from the author (2026-11-23): the inbox stays a list of emails one after another, but each row shows its status, what Tabellar did with it and where the result went. Most of the user's time is spent on the pages that show what their mail turned into (replies to send, todos, meetings, follow-ups and more) rather than on reading messages. It must hold up for a busy mailbox: hundreds of emails a day, long todo and draft lists. A separate dashboard of counts and cards was tried and rejected.
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
