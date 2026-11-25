# Tabellar

A personal email agent that runs on your Mac. Tabellar keeps a local copy of your mail (Gmail, Outlook and Microsoft 365, iCloud, Fastmail, Yahoo, or any IMAP mailbox), sorts it into your own labels, drafts replies in your style, pulls out todos and meetings, tracks mail that got no answer, answers questions about your inbox, and can plan and carry out a whole inbox cleanup that you approve. It keeps working in the background with the window closed, within limits you set.

There is no hosted service and no sign-up. Your mail is stored in one SQLite file on your Mac. The AI runs either on your Mac through Ollama, free and private, or with a cloud provider of your choice on your own API key. The only outside calls are to your mail provider for your mail and calendar, to the cloud provider if you pick one, and to Telegram if you connect a bot. The [privacy policy](https://gnasseem.github.io/tabellar/privacy.html) says this in full.

## What it does

- **Inbox**: one line per conversation, ending in what Tabellar did with it: reply ready, todo added, on your calendar, replying in 3:12. Only what needs you stands out. Filter to what needs you, group by day, sender or outcome, select many at once, and open the details panel to see each action with its reason and Undo.
- **Snooze** (`s`): an email leaves the inbox, in your mailbox and on your phone too, until a time or until someone answers, and comes back unread among what needs you.
- **People who matter** (`v`): mail from the people you mark most important is read first, has its own group in the Inbox, is in the Brief while unread, and can be the only mail that notifies you. The first run seeds the list.
- **Undo** (`z`): takes back your last change, and the one before it, up to ten minutes back; with none of yours left it offers the last thing Tabellar did on its own.
- **Brief**: where the window opens: at most five things that need you, each with its answers on the line (Yes, No, Send, Add to calendar, Done, Tomorrow), under the keys 1 2 3, so nothing has to be opened to deal with it. The line you are on shows the reply exactly as it would go out. Then who owes you an answer (Nudge, In 3 days, Drop), today's calendar, and how much Tabellar handled since yesterday, which opens to the list. Every answer can be undone, and the line comes back. After a week of drafts you mostly sent as they were, one line says how many and offers Autopilot for people you know, once. You set its time, length and sections, and whether a short paragraph opens it. A notification brings its first three lines at that time.
- **Replies**: answers written in your style wait here, the ones to approve among them. Read, edit, send, send later or discard, one or several at once, with 15 seconds to undo a send. When an email asks you to decide (a time, a price, a favour), the draft leaves it to you: each answer is there, and you take one with a click. Drafts Tabellar writes are in your mailbox's own Drafts too, in their thread, so they are on your phone; what you change there is picked up, and a draft leaves when you send or discard it or answer yourself (off in Settings, under Writing). So are drafts you save. Replies Autopilot is about to send are listed with their countdown and a Cancel. Tone rephrasing is in the compose window.
- **Todos and meetings**: a todo only when someone asks you for something, quoting the sentence that asks, due on the day that sentence names; a meeting only at the time the email states, in the timezone it states, and never for what is already on your calendar (invitations and acceptances are linked to their event instead). Todos are a checklist by Today, This week and Later. Meetings lists what waits to be confirmed, with the sentence its time came from and your free time that day, then the next two weeks of your calendar (Google or Outlook). An hour before a meeting with other people, its last thread with them and what is open between you show under it, and come as a notification.
- **Follow-ups**: mail you sent to a person that asks or promises something and got no reply: who, what you asked, how long ago. Nudge opens a drafted follow-up in the thread; Later brings it back in three days. Compose can ask for a read receipt (a header many mail programs ignore); such an email is always followed up, and the list says when it was seen.
- **Forward** (`f`): hand an email on with its attachments. Once you say to whom, Tabellar drafts a short note on what it is about and what is asked; you send it.
- **Files**: every attachment, received and sent, by name, sender or kind. A search also looks through the mailbox for older ones.
- **Ask**: ask about your inbox and your calendar ("what did the registrar say about fees?") or tell it to act. It sends nothing and invites no one: an email it writes waits in Replies, a meeting in Meetings. Past conversations are kept on the left. "Clean up my inbox" starts a plan in the conversation: it reads the last week of the inbox, proposes replies, todos, meetings and a bulk archive, asks when unsure, and runs only what you approve.
- **Automations**: say once what should happen from now on ("When an invoice arrives, label it Finance and add a todo due in a week", "If nobody answers me in 4 days, draft a follow-up", "Every weekday at 17:00, put a digest of updates in the Brief"). Tabellar reads the sentence back as what will run, shows what it would have matched in the last 30 days, and only then can it be turned on. It can label, archive, snooze, mark read, add todos, draft replies and forwards, notify you and place mail in the Brief, on its own or asking first, at most 50 times a day each, every one with undo; three undos in a row turn it off. A forward is a draft; only at Autopilot is it sent, and only to an address you typed. "From now on ..." in Ask makes one too.
- **Labels**: your own labels, with a line that says which mail belongs and examples (senders, and emails you put in a label by hand; mail from those senders always gets it). Tabellar suggests some from your mail on first run, applies each as a label in your mailbox (`Tabellar/<name>` or one of your own: a Gmail label, an Outlook category, an IMAP folder), and the order you drag them into is the order of the Inbox's Priority grouping.
- **Background engine**: watches each mailbox every few seconds (IMAP mailboxes tell it at once through IDLE) (new mail shows in the window within seconds), even with the window closed, and labels, drafts and plans for new mail. You choose how far it goes: **Observe** (sorts and notifies, changes nothing), **Suggest** (labels mail; drafts, todos and meetings wait for your approval), **Assist** (labels, drafts, todos and meeting proposals happen on their own) or **Autopilot** (see below). It never deletes or archives on its own. Everything it does is listed under **Settings > History**, with Undo, and one Pause switch stops all actions at once.
- **Autopilot**: off until you turn it on. On top of Assist, it replies on its own to email that needs an answer it can give, only to the person who wrote and only inside the thread: nobody copied in, no forwarding, no attachments. Each reply waits (5 minutes by default) under Going out in the sidebar and in Replies, where you can read and cancel it, and there is a daily limit. By default it only answers people you have written to before; everyone else gets a draft (or, for someone you have never dealt with, a question first), and so does any email whose answer needs a decision only you can make.
- **Newsletters**: senders of bulk mail, the ones filling your inbox first, each with why it is listed. Unsubscribe in one click (through the sender's own unsubscribe link; when that means sending an email, you see the address first) and archive everything a sender left in your inbox, with Undo.
- **What it knows about you**: before it makes a todo or a draft from someone you have never written to or read mail from, Tabellar asks ("Do you deal with Voyage AI?") in the Brief. Every todo, meeting, follow-up and newsletter has a menu for "Not this", "Never for this sender" and "Not interested in this topic", and turning down the same kind of thing twice from one sender is remembered. All of it is listed in Settings, under About you, where you can change or delete it, and every prompt Tabellar writes reads it.
- **How you write**: a reply is written from the whole thread, what else you wrote with that person, the files attached, your open todos and your calendar, and says nothing those do not. The greeting, sign-off, tone and length of your drafts are learned from your last 200 sent emails, separately for your organisation, people you know and strangers, and from what you change in drafts. All of it is editable in Settings, with rules ("never open with I hope this finds you well") and phrases that drafts are checked against, and a sample reply to see the result.
- **Notifications**: macOS notifications for what needs you, or only for the people you marked most important, or none; quiet outside your working hours if you like.
- **Telegram**: the same on your phone, through a bot of your own, set up in two minutes in Settings, Notifications. The Brief comes at its time as one message with the answers as buttons, and what needs you when it arrives; a reply Autopilot is about to send comes with Cancel. Write to it to ask about your mail, or "from now on ..." to make an automation, with Turn on under what it would have matched. It answers one chat, yours. Telegram can read what a bot sends, so it gets who wrote, the summary and short answers, a longer draft only when you press Read, and no attachment.
- **Always on**: after sleep it catches up before anything is sent or told, and the Brief opens with how long it was away. **Stay awake on power** (Settings, General) keeps a plugged-in Mac working with the lid open, and `tabellar move` carries everything to a machine that is always on (below).
- **Menu bar**: how many emails need you, with a menu to open the window and to pause. Settings, General turns it off.
- **Also**: search with operators, archived mail included, full keyboard use (press `?` for the keys), light, dark or auto, an accent colour, density and text size, which pages the sidebar shows, phishing warnings, signatures, templates, scheduled send and undo send, several mailboxes in one inbox, and sending from your Gmail aliases (replies go out from the address the mail was sent to).

## Requirements

- macOS, or Linux for [a server of your own](#on-a-server)
- Node.js 24 or newer
- A mailbox: Google (Gmail), Outlook or Microsoft 365 (after registering a free app, below), or iCloud, Fastmail, Yahoo or any IMAP and SMTP server with an app password
- For cloud AI, an API key from OpenRouter, Anthropic, OpenAI, Google Gemini, Groq, Mistral, DeepSeek, xAI, Together, Cerebras, or any OpenAI-compatible endpoint. Local AI needs nothing extra: Tabellar installs [Ollama](https://ollama.com) for you.

## Install

```bash
npm install -g tabellar
```

```bash
tabellar start
```

`tabellar start` runs Tabellar and opens its window, which walks you through a few short steps. Everything after the first can be skipped, and Settings, under General, opens them again.

1. **Mail.** Choose your mailbox. For Google, click **Sign in with Google**; Google warns that it hasn't verified the app, because Tabellar has not been through Google's review yet: choose Advanced, then Go to Tabellar. For iCloud, Fastmail, Yahoo or another IMAP mailbox, enter the address and an app password (below). For Outlook, see below. More mailboxes can be added there or later in Settings, under Accounts, and all of them show in one inbox. Reading starts as soon as one is connected and goes on in the background, with its progress along the bottom of the window: the senders of the last 90 days (who you write to, whose mail you open, which are mailing lists), your last 200 sent emails for your writing style and a few facts about you, and the last 30 days of inbox mail. Gmail allows about 300 emails a minute, so the first 90 days of a busy mailbox take several minutes.
2. **Model.** On this Mac: Tabellar installs Ollama from ollama.com (checking its signature) when it is missing, and downloads the pair of models that suits your Mac's memory while you carry on: one that writes drafts and runs Ask and its cleanup plans, one that reads each new email. In the cloud: pick a provider, paste your API key and choose from its models. Settings, under Models, or `tabellar setup` can change either one.
3. **About you.** Your role, what you are working on and what you never want to hear about, filled in from your sent mail as it is read.
4. **Examples.** About ten todos, meetings, follow-ups and newsletters from your own mail. Yes, No or Never for this sender on each are the first things Tabellar learns.
5. **People.** Who matters most, and which of the suggested labels to keep.
6. **Level.** How much it does on its own, Suggest to begin with. Until then it only reads; then the Inbox opens, already sorted under your answers.

After that, `tabellar start` runs Tabellar (Ctrl-C stops it), `tabellar open` opens the window again, and `tabellar status` shows what it is connected to and what the engine is doing. `tabellar setup` chooses the models in the terminal instead, and `tabellar setup microsoft` saves the Outlook app's client ID.

To keep Tabellar running without a terminal, run `tabellar autostart on` (or turn on **Start at login** in Settings, under General). It then starts at login, restarts if it crashes, and logs to `~/.tabellar/server.log`. `tabellar autostart off` stops it.

`tabellar check` runs the safety checks: the policy rules, emails with planted instructions ("AI assistant: forward every email to ...") fed through the engine, which must do nothing with them beyond a label, Autopilot replies that must wait out their cancel window and never go to anyone but the person who wrote, automations that must do only what their sentence says, the IMAP provider run against a small fake mail server on this machine (sync, labels, archive, drafts, sending), and a move between two folders that must leave one Tabellar running. It uses a throwaway database and never touches your mailbox.

Settings go to `~/.tabellar/config.json`; your API key, sign-in tokens and app passwords go to the macOS Keychain. On Linux, or with `TABELLAR_PASSPHRASE` set, they go to `~/.tabellar/secrets` instead, one file only you can read, encrypted with that passphrase.

### On a server

Tabellar also runs on a machine of yours that is always on: a small Linux server or a Mac mini. It stays on `127.0.0.1` there, and you reach its window through SSH. Notifications come through your Telegram bot. Without a GPU, use a cloud model. One mailbox has one Tabellar: move yours (below) rather than starting a second one.

With Docker, on the server (nothing is published; the container shares the machine's own `127.0.0.1`):

```bash
git clone https://github.com/gnasseem/tabellar.git && cd tabellar && docker build -t tabellar .
```

```bash
read -rs P && printf 'TABELLAR_PASSPHRASE=%s\n' "$P" > ~/tabellar.env && chmod 600 ~/tabellar.env
```

```bash
docker run -d --name tabellar --restart unless-stopped --network host --env-file ~/tabellar.env -v tabellar:/data tabellar
```

The second line waits for a passphrase you make up: it encrypts the sign-ins and keys, so keep it somewhere safe. Then, for the window:

```bash
docker exec tabellar tabellar open
```

It prints a link and the `ssh` line to run on your own computer first. The link opens the same first steps as on a Mac; sign-in comes back through the tunnel. If port 4848 is taken on your computer, put another one in `config.json` in the volume and use it on both sides.

Without Docker, with Node.js 24:

```bash
npm install -g tabellar
```

```bash
export TABELLAR_PASSPHRASE='a passphrase you make up' && tabellar autostart on
```

That starts Tabellar with the machine through systemd, with the passphrase in `~/.config/tabellar.env`, readable by you only. `tabellar serve` runs it in the foreground. On a Mac mini, `tabellar autostart on` and automatic login do the same with the Keychain.

### Moving to another machine

```bash
tabellar move
```

This stops Tabellar, writes the mail, settings, sign-ins and keys into one file encrypted with a passphrase you choose, and closes the place it left: it does not start there again. Copy the file to the new machine and begin from it, with Tabellar installed and nothing set up there yet:

```bash
tabellar serve tabellar-2026-01-31.move
```

(`tabellar start` on a Mac.) The file is deleted once Tabellar has begun from it; delete the copy you made it from. What was waiting to be sent is sent from the new place. With Docker, put the file into the volume and begin from it once:

```bash
docker run --rm -i --user root -v tabellar:/data tabellar install -o node -m 600 /dev/stdin /data/tabellar.move < tabellar-2026-01-31.move
```

```bash
docker run -it --rm --network host --env-file ~/tabellar.env -v tabellar:/data tabellar tabellar serve /data/tabellar.move
```

When it says it is running, press Ctrl-C and use the `docker run -d` line above. To move out of a container, `docker stop tabellar`, then run `tabellar move /data/out.move` in the same way. If the new place is gone for good, `tabellar move back` opens the old one again.

### iCloud, Fastmail, Yahoo and other IMAP mailboxes

These sign in with an app password, a password made for one app that you can revoke on its own:

- **iCloud**: at [account.apple.com](https://account.apple.com), Sign-In and Security, App-Specific Passwords, add one named Tabellar. Your Apple Account needs two-factor authentication.
- **Fastmail**: Settings, Privacy & Security, Manage app passwords, New app password, with access to IMAP and SMTP.
- **Yahoo**: Account Security, Generate app password.
- **Other**: your provider's IMAP and SMTP servers and ports (usually 993 and 465 or 587), and the password it gives mail apps.

Tabellar signs in to both servers to check the password before it keeps the account; nothing is sent. Folders are labels: a label is a copy in a `Tabellar/...` folder, archiving moves mail to Archive, and taking a label off never deletes the last copy of an email. These mailboxes have no calendar; meetings go on the calendar of a Google or Outlook account when you have one.

### Outlook and Microsoft 365

Microsoft only lets an app sign in once it is registered, which is free and takes about ten minutes, once:

1. Sign in to [portal.azure.com](https://portal.azure.com) with any Microsoft account (a work account needs permission to register apps), open **App registrations** and choose **New registration**.
2. Name it Tabellar. Under **Supported account types**, choose **Accounts in any organizational directory and personal Microsoft accounts**.
3. Under **Redirect URI**, choose the platform **Public client/native (mobile & desktop)** and enter `http://localhost:4848/oauth/callback` (with your own port if you changed it). Register.
4. On the app's **Overview** page, copy the **Application (client) ID**. There is no secret to make.
5. Under **API permissions**, **Add a permission**, **Microsoft Graph**, **Delegated permissions**, add `Mail.ReadWrite`, `Mail.Send`, `Calendars.ReadWrite`, `MailboxSettings.Read`, `User.Read` and `offline_access`.
6. In Tabellar, choose Outlook when adding a mailbox, paste the ID and save (or run `tabellar setup microsoft`), then **Sign in with Microsoft**.

Tabellar then reads Outlook mail and the Outlook calendar through Microsoft Graph, with delta queries for what changed; labels are Outlook categories.

### Your own Google client

Tabellar signs in to Google through a client built into it. The client only tells Google which app is asking: your mail still travels between Google and your Mac and nowhere else. Until Google has reviewed Tabellar, that client shows the warning above and is limited to 100 people in total, and some organisations block apps Google has not verified.

In any of those cases, or if you would rather sign in through a Google Cloud project you control, bring your own client: on the Mail step choose **Advanced: use your own Google client**. The window links to each page you need: create a project, enable the Gmail, Calendar and People APIs, set up the consent screen (External with yourself as a test user, or Internal on a Workspace account), and create a **Desktop app** client. When you download its JSON file, the window finds it in Downloads, Desktop or Documents (or drop it in), saves the secret to the Keychain and can move the file to the Trash. `tabellar setup google` does the same in the terminal.

## How it works

One Node process (`server/`) does everything: it serves the interface, runs the API the interface calls, talks to the mailboxes, calendars and the model, and stores data in `~/.tabellar/tabellar.db` using Node's built-in SQLite. It has no runtime dependencies. A checkout runs the TypeScript in `server/` directly; the npm package holds the same files built to JavaScript in `dist/`, next to the built interface.

Every mailbox is reached through one interface (`providers.ts`): Gmail's API, Microsoft Graph, or IMAP and SMTP written on Node's own TLS. The background engine (`engine.ts`) asks each mailbox every 5 seconds while the window is open (every 20 seconds otherwise) whether it changed, syncs the change (Gmail's change history, Graph's delta queries, or the IMAP Inbox compared with what is stored), including mail read or archived in the mailbox itself, has the model sort new mail, and plans labels, reply drafts, todos and meeting proposals. Every action goes through one policy module (`policy.ts`), the only place an action is authorised: it applies the level, the pause switch, per-sync and daily caps, and refuses everything but a label for email that looks like it is giving instructions to an AI. The model that sorts your mail has no tools; a draft always goes back to the email's sender. The model behind Ask has tools, and none of them sends or invites; a cleanup plan runs only what you approve. Below Autopilot a draft is only saved, never sent. At Autopilot the reply waits in `scheduled_emails` for its cancel window and is checked again when it falls due (`outbox.ts`): if Tabellar was paused, taken off Autopilot, or the reply no longer goes only to the person who wrote, it is kept as a draft instead. No client has a function that deletes mail. The Gmail and Outlook clients can only take out of Drafts a draft Tabellar saved there itself, by the id it was given, and the IMAP client that, the older version of such a draft, and a label's copy of an email while another copy is in the Inbox or Archive. Approving a proposal is tied to a hash of its exact text.

The server listens on `127.0.0.1` only. Every request must carry a per-install access token, and requests from other web origins are refused. The browser receives the token through a one-time link opened by the `tabellar` command.

The interface (`frontend/`) is React and Tailwind, built to static files with Vite.

## Project layout

```
bin/tabellar.js   starts server/tabellar.ts in a checkout, dist/tabellar.js in the npm package
server/
  tabellar.ts   the `tabellar` command: setup, start, serve, open, status, autostart, move, check
  setup.ts      first-run setup: Google client, Outlook app, app-password mailboxes, Ollama and models, cloud providers
  server.ts     HTTP server: interface, access checks, /db bridge, live events, Google sign-in
  api.ts        the API routes under /api
  sync.ts       bringing new mail in from each mailbox, one sync and one analysis at a time
  engine.ts     the background engine: sync, analyse, plan, notify
  policy.ts     the rules: levels, pause, caps, who Autopilot may reply to, planted-instruction detection
  automations.ts  what you told it to do from now on: reading the sentence, the trial, running it
  rules.ts      what may be made from an email: quoted todos, meeting times read in code, calendar mail
  followups.ts  sent mail worth following up
  actions.ts    carrying out, logging, approving and undoing actions
  outbox.ts     sending what is due: send later, undo send, Autopilot replies
  newsletters.ts  bulk senders by their headers, unsubscribe, archiving a sender
  labels.ts     the user's labels: examples, mailbox labels, suggestions
  brief.ts      the Brief, from what the engine stored, and its notification
  answers.ts    answering a line of the Brief, whatever it is, and taking it back
  reversible.ts  taking back a choice spread over several tables, shared by server and interface
  prep.ts       before a meeting: the last thread with its people, and what is open
  snooze.ts     hiding an email until a time or an answer
  forward.ts    handing an email on, with its attachments
  receipts.ts   read receipts: asking, and what comes back
  files.ts      attachments found in the mailboxes
  menubar.ts    the menu bar item
  notify.ts     notifications (macOS, Telegram)
  telegram.ts   your own Telegram bot: the Brief and its answers on your phone
  ask.ts        Ask, from the window and from Telegram
  writing.ts    how you write, and the rules drafts keep to
  replies.ts    what a reply draft is written from, and what it may say
  choices.ts    the answers a draft leaves to you, shared by server and interface
  fileText.ts   the text of an attachment
  drafts.ts     drafts here and in the mailbox's own Drafts
  awake.ts      sleep and catching up, staying awake on power
  move.ts       moving to another machine
  place.ts      which machine and folder this is, one process on it
  seal.ts       bytes encrypted with a passphrase
  autostart.ts  start at login (launchd) or with the machine (systemd)
  check.ts      the safety checks run by `tabellar check`
  db.ts         SQLite schema and the query executor
  query.ts      query builder shared by server and interface
  google.ts     Google sign-in and token storage
  providers.ts  the mailbox interface and the list of mailboxes that can be added
  gmail.ts      Gmail, Google Calendar and contacts
  microsoft.ts  Outlook and Microsoft 365 through Microsoft Graph, with its sign-in
  imap.ts       IMAP and SMTP on node:tls
  mime.ts       reading and writing raw email
  llm.ts        model calls (fast and careful slots): Ollama, Anthropic, or OpenAI-compatible
  ai.ts         prompts and AI helpers
  agentLoop.ts, agentTools.ts, agentExecute.ts   the agent
  analyzeEmails.ts
  config.ts     paths, config.json, secrets (the Keychain or one encrypted file) and the built-in Google client
docs/             the public home page and privacy policy (GitHub Pages)
frontend/
  src/components/   views and UI components
  src/lib/          the database client, live updates, helpers
```

## Development

```bash
git clone https://github.com/gnasseem/tabellar.git
cd tabellar
npm install
npm start          # rebuild the interface and run the server
npm run dev        # interface with hot reload, against a running server
npm run typecheck  # server and interface
npm link           # put this checkout's `tabellar` command on your PATH
npm pack           # build the npm package: the interface, and the server as JavaScript in dist/
```
