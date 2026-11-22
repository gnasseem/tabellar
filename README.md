# Tabellar

A personal email agent that runs on your Mac. Tabellar keeps a local copy of your Gmail, sorts it, writes a daily briefing, drafts replies in your style, pulls out todos and meetings, tracks mail that got no answer, answers questions about your inbox, and can plan and carry out a whole inbox cleanup that you approve.

There is no hosted service and no sign-up. Your mail is stored in one SQLite file on your Mac. The AI runs either on your Mac through Ollama, free and private, or with a cloud provider of your choice on your own API key. The only outside calls are to Google for your mail and calendar, and to the cloud provider if you pick one.

## What it does

- **Inbox**: every new email gets a category, a summary and suggested actions (reply, todo, meeting).
- **Briefing**: a daily summary sorted into Reply needed, Deadlines, Crucial and Non-essential.
- **Drafts**: replies and new emails written in your style, plus tone rephrasing in the compose window.
- **Todos and meetings**: pulled from mail, with Google Calendar free slots and event creation.
- **Follow-ups**: mail you sent that got no reply, with reminders and suggested nudges.
- **Assistant**: ask about your inbox ("what did the registrar say about fees?") or tell it to act.
- **Agent**: give it your briefing and it proposes replies, todos, meetings and a bulk archive, asks when unsure, and runs only what you approve.
- **Also**: search operators, keyboard shortcuts, phishing warnings, signatures, templates, scheduled send and undo send, several Gmail accounts.

## Requirements

- macOS
- Node.js 24 or newer
- A Google account (Gmail)
- For cloud AI, an API key from OpenRouter, Anthropic, OpenAI, Google Gemini, Groq, Mistral, DeepSeek, xAI, Together, Cerebras, or any OpenAI-compatible endpoint. Local AI needs nothing extra: Tabellar installs [Ollama](https://ollama.com) for you.

## Install

```bash
git clone https://github.com/gnasseem/tabellar.git
cd tabellar
npm install
npm link        # puts the `tabellar` command on your PATH
npm start
```

`npm start` builds the interface, starts Tabellar and opens its window, which walks you through three steps:

1. **Google client.** Tabellar signs in to Google with an OAuth client you create in your own Google Cloud project, so your mail never passes through anyone else's app. The window links to each page you need: create a project, enable the Gmail, Calendar and People APIs, set up the consent screen (External with yourself as a test user, or Internal on a Workspace account), and create a **Desktop app** client. When you download its JSON file, the window finds it in Downloads, Desktop or Documents (or drop it in), saves the secret to the Keychain and can move the file to the Trash.
2. **AI model.** On this Mac: Tabellar downloads Ollama from ollama.com, checks its signature, installs it and downloads a model sized for your Mac's memory. In the cloud: pick a provider, paste your API key and choose from its models. You can skip this and choose later in Settings, under AI.
3. **Gmail.** Click **Continue with Google**. Google warns that it hasn't verified the app, which is expected for your own client: choose Advanced, then Go to Tabellar. The first sign-in fetches and analyzes your recent mail.

After that, `tabellar start` runs Tabellar (Ctrl-C stops it), `tabellar open` opens the window again, and `tabellar status` shows what it is connected to. `tabellar setup` does the first two steps in the terminal instead.

Settings go to `~/.tabellar/config.json`; the client secret, API key and Google tokens go to the macOS Keychain.

## How it works

One Node process (`server/`) does everything: it serves the interface, runs the API the interface calls, talks to Gmail, Calendar and the model, and stores data in `~/.tabellar/tabellar.db` using Node's built-in SQLite. It has no runtime dependencies.

The server listens on `127.0.0.1` only. Every request must carry a per-install access token, and requests from other web origins are refused. The browser receives the token through a one-time link opened by the `tabellar` command.

The interface (`frontend/`) is React and Tailwind, built to static files with Vite.

## Project layout

```
server/
  tabellar.ts   the `tabellar` command: setup, start, open, status
  setup.ts      first-run setup: Google client, Ollama install and models, cloud providers
  server.ts     HTTP server: interface, access checks, /db bridge, live events, Google sign-in
  api.ts        the API routes under /api
  db.ts         SQLite schema and the query executor
  query.ts      query builder shared by server and interface
  google.ts     Google sign-in and Keychain token storage
  gmail.ts      Gmail, Calendar and contacts client
  llm.ts        model calls: Ollama, Anthropic, or OpenAI-compatible
  ai.ts         prompts and AI helpers
  agentLoop.ts, agentTools.ts, agentExecute.ts   the agent
  analyzeEmails.ts, buildBriefing.ts
  config.ts     paths, config.json and the Keychain
frontend/
  src/components/   views and UI components
  src/lib/          the database client, live updates, helpers
```

## Development

```bash
npm start          # rebuild the interface and run the server
npm run dev        # interface with hot reload, against a running server
npm run typecheck  # server and interface
```
