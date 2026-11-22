# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow Rules

- Node version: **24 or newer** (see `.nvmrc`). The server's `.ts` files run directly under Node's type stripping, so they may only use erasable TypeScript: no enums, namespaces or parameter properties, and type-only imports must be marked `type`.
- **Never use m-dashes (—) in UI text or code comments.** Use commas, semicolons, periods, or "to" instead.
- There is no hosting, deploy step, or hosted database. Nothing runs on Vercel or Supabase.

### After every task, do all of these automatically

1. **Typecheck**: `npm run typecheck` must pass. If anything under `frontend/` changed, also run `npm run build`.
2. **README.md**: update only if a change affects how users install or use the app, or adds or removes a major user-visible feature.
3. **Git commit**: commit all changes at the end of every task with a concise message.

## Commands

All commands run from the repo root. This is an npm workspace; `npm install` at the root installs everything.

```bash
npm run setup      # Google sign-in client and cloud model (writes ~/.tabellar/config.json and the Keychain)
npm start          # build the interface, run the server, open the window
npm run dev        # Vite dev server for the interface, proxying to a running server on :4848
npm run build      # build the interface to frontend/dist
npm run typecheck  # tsc for server/ and frontend/

tabellar open      # open the window of a running server (after `npm link`; same as node server/tabellar.ts open)
tabellar status    # running? which accounts and model?
```

Set `TABELLAR_HOME` to run against a different data folder (default `~/.tabellar`). The Keychain service is always `tabellar`.

## Architecture

### Layout

```
server/      one Node process, no runtime dependencies
frontend/    React + Tailwind, built with Vite to frontend/dist, served by the server
```

### Server (`server/`)

- `server.ts`: `node:http` on 127.0.0.1 (port 4848 by default). Checks the Host header, refuses foreign Origins, and requires the access token as `Authorization: Bearer` on `/api/*`, `/db`, `/db/rpc` and `/session`. `index.html` is served with the token injected only to browsers holding the session cookie, which is exchanged for a one-time code minted by `tabellar open`. Also runs Google sign-in (`/oauth/start`, `/oauth/callback`), the live event stream (`/events`, server-sent events), and a 10-second timer that sends due `scheduled_emails` (undo send and send later).
- `api.ts`: `handleApi(req, path)` with all routes under `/api` (fetch-emails, send-email, drafts, briefing, calendar, chat, follow-ups, signatures, agent, ...). Written against Web `Request`/`Response`.
- `db.ts`: the SQLite schema (one `SCHEMA` object; columns typed uuid/text/int/real/bool/json/time, defaults filled in on insert, new columns added automatically on start) and `execute(spec)`, which runs supabase-js style queries. Every write is published on `changes` for the event stream. `db.rpc` provides `alloc_agent_turn_idx`, `merge_bucket_draft_actions`, `increment_knowledge_use_count`.
- `query.ts`: the query builder (`from().select().eq().order()...`, `.or()` PostgREST strings, embedded selects like `email_processed(summary)` and `emails!inner(...)`). Shared by the server and the interface.
- `google.ts`: installed-app OAuth with PKCE on the loopback address. Refresh tokens live in the Keychain; `gmail_accounts.token_ref` holds only the Keychain item name. Access tokens are kept in memory (`freshAccessToken`).
- `llm.ts`: `chatCompletion` takes OpenAI chat-completions requests and either forwards them to an OpenAI-compatible endpoint or translates them to the Anthropic Messages API and back. Anthropic content blocks come back on the message as `_anthropic` and are replayed verbatim on later turns so thinking blocks stay intact; the agent persists them in `agent_turns.content.raw`.
- `ai.ts` (prompts and AI helpers), `gmail.ts` (Gmail, Calendar, People API client), `agentLoop.ts` / `agentTools.ts` / `agentExecute.ts` (the agent), `analyzeEmails.ts`, `buildBriefing.ts`.
- `config.ts`: paths, `config.json` (port, Google client id, model format/base URL/model), Keychain helpers (`keychainGet/Set/Delete`), and `getEnv` for the few settings the backend reads.

### Interface (`frontend/`)

- `src/main.tsx` loads `/session`, then renders `AppShell` + `EmailDashboard` when a Google account is connected, otherwise `Welcome`.
- `src/lib/db.ts`: `createClient()` returns an object shaped like the supabase-js client the views were written against: `from()` posts the query to `/db`, `auth.getSession()` returns the local user and access token, `channel().on("postgres_changes", ...)` listens on `/events`. Views keep calling `supabase.from(...)`.
- Global state lives in `AppShell.tsx` via React context (`useApp()`): `user`, `profile`, `view`, `addToast`, compose, agent state.
- API calls are `fetch("/api/...")` with `Authorization: Bearer ${session.access_token}`.

### Data

One user per install. All tables keep a `user_id` column; the profile row is created at first Google sign-in. Key tables: `profiles`, `gmail_accounts`, `emails`, `email_processed` (category, summary, quick_actions; upsert on `email_id`), `todos`, `meetings`, `follow_up_reminders`, `scheduled_emails`, `draft_emails`, `knowledge_base`, `email_memory`, `contacts`, `agent_sessions`, `agent_turns`.

### Secrets

Never in files. Keychain items (service `tabellar`): `access-token`, `google-client-secret`, `model-api-key`, and one `google:<hash>` item per connected Google account.
