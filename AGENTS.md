# AGENTS.md

This file provides guidance to Codex (claude.ai/code) when working with code in this repository.

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
npm start          # build the interface, run the server, open the window (first run: in-window setup)
npm run setup      # the same setup in the terminal: Google client and AI model (writes ~/.tabellar/config.json and the Keychain)
npm run dev        # Vite dev server for the interface, proxying to a running server on :4848
npm run build      # build the interface to frontend/dist
npm run typecheck  # tsc for server/ and frontend/

tabellar open      # open the window of a running server (after `npm link`; same as node server/tabellar.ts open)
tabellar status    # running? which accounts, model, engine level?
tabellar autostart on|off   # start at login via launchd (~/Library/LaunchAgents/com.tabellar.server.plist)
tabellar check     # policy asserts and planted-instruction emails through the engine, in a throwaway TABELLAR_HOME
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
- `sync.ts`: `syncMail(userId, initial)` fetches new mail (Gmail history, paginated) and `analyzeInbox(userId)` runs the analysis; each is serialised so the window and the engine never overlap.
- `engine.ts`: the background engine, started by `startServer`. Every 2 minutes (and on the first tick after wake) it runs sync, analysis, then `planNew`, which turns each newly analysed email (`email_processed.engine_at` null, received within 7 days) into planned actions: a `Tabellar/<Category>` Gmail label, a reply draft (action-required, real sender), a todo, a meeting proposal. Sends macOS notifications per `profiles.notification_level`.
- `policy.ts`: `decide()` is the only place an action is authorised. Levels `observe`/`suggest`/`assist` (`profiles.autonomy_level`; anything else counts as observe), `profiles.engine_paused`, caps per cycle and per day, and `looksLikeInstructions()` which limits planted-instruction email to a label. The engine never sends or archives. `proposalHash()` binds an approval to the exact proposal.
- `actions.ts`: `act()` decides then does, proposes (status `proposed` with a hash) or logs a refusal in `action_log`; `approve`, `dismiss`, `undo`. The agent's archive and the assistant's archive go through `act()` and archive in Gmail; agent and assistant sends are recorded. Everything checks pause.
- `notify.ts` (channels list, macOS via osascript argv), `launchd.ts` (login item), `check.ts` (run by `tabellar check`).
- `api.ts`: `handleApi(req, path)` with all routes under `/api` (fetch-emails, send-email, drafts, briefing, calendar, chat, follow-ups, signatures, agent, ...). Written against Web `Request`/`Response`.
- `db.ts`: the SQLite schema (one `SCHEMA` object; columns typed uuid/text/int/real/bool/json/time, defaults filled in on insert, new columns added automatically on start) and `execute(spec)`, which runs supabase-js style queries. Every write is published on `changes` for the event stream. `db.rpc` provides `alloc_agent_turn_idx`, `merge_bucket_draft_actions`, `increment_knowledge_use_count`.
- `query.ts`: the query builder (`from().select().eq().order()...`, `.or()` PostgREST strings, embedded selects like `email_processed(summary)` and `emails!inner(...)`). Shared by the server and the interface.
- `google.ts`: installed-app OAuth with PKCE on the loopback address. Refresh tokens live in the Keychain; `gmail_accounts.token_ref` holds only the Keychain item name. Access tokens are kept in memory (`freshAccessToken`).
- `llm.ts`: `chatCompletion` takes OpenAI chat-completions requests with a `slot`, `fast` (reading each email: `processFullEmail`, entities, todos, meetings) or `careful` (default: drafts, briefing, assistant, agent). `config.model` is the careful model and `config.fastModel` the fast one, which falls back to `model` when unset. It sends them in that model's `format`: `ollama` (Ollama's native `/api/chat`, so `num_ctx` can be set; no API key), `openai` (forwarded to any OpenAI-compatible endpoint, retrying once without `temperature` or with `max_completion_tokens` when a model rejects them), or `anthropic` (translated to the Messages API and back). Local models get longer timeouts and lower analysis concurrency (`isLocalModel`, `modelTimeoutMs`). Anthropic content blocks come back on the message as `_anthropic` and are replayed verbatim on later turns so thinking blocks stay intact; the agent persists them in `agent_turns.content.raw`.
- `ai.ts` (prompts and AI helpers), `gmail.ts` (Gmail, Calendar, People API client), `agentLoop.ts` / `agentTools.ts` / `agentExecute.ts` (the agent), `analyzeEmails.ts`, `buildBriefing.ts`.
- `setup.ts`: first-run setup shared by the window (`/api/setup/*`, routed in `server.ts` before `handleApi`) and `tabellar setup`: finding and saving the Google client file, installing and starting Ollama (its bundled `ollama serve`, not the menu bar app, whose first launch asks for an admin password), pulling models (with a direct registry download when Ollama can't reach it), and cloud provider key checks. Progress streams as NDJSON.
- `config.ts`: paths, `config.json` (port, Google client id, model provider/format/base URL/model), Keychain helpers (`keychainGet/Set/Delete`), and `getEnv` for the few settings the backend reads.

### Interface (`frontend/`)

- `src/main.tsx` loads `/session`, then renders `AppShell` + `EmailDashboard` when a Google account is connected, otherwise `Welcome` (the three-step onboarding). `ModelSetup.tsx` is the model picker shared by onboarding and Settings > AI.
- `src/lib/db.ts`: `createClient()` returns an object shaped like the supabase-js client the views were written against: `from()` posts the query to `/db`, `auth.getSession()` returns the local user and access token, `channel().on("postgres_changes", ...)` listens on `/events`. Views keep calling `supabase.from(...)`.
- Global state lives in `AppShell.tsx` via React context (`useApp()`): `user`, `profile`, `view`, `addToast`, compose, agent state.
- API calls are `fetch("/api/...")` with `Authorization: Bearer ${session.access_token}`.

### Data

One user per install. All tables keep a `user_id` column; the profile row is created at first Google sign-in. Key tables: `profiles`, `gmail_accounts`, `emails`, `action_log` (what the engine, agent and assistant did or propose, with undo info in `detail`), `email_processed` (category, summary, quick_actions; upsert on `email_id`), `todos`, `meetings`, `follow_up_reminders`, `scheduled_emails`, `draft_emails`, `knowledge_base`, `email_memory`, `contacts`, `agent_sessions`, `agent_turns`.

### Secrets

Never in files. Keychain items (service `tabellar`): `access-token`, `google-client-secret`, `model-api-key:<provider>` (one per cloud provider in use), and one `google:<hash>` item per connected Google account. Downloaded `client_secret*.json` files are gitignored; setup imports them and offers to trash them.
