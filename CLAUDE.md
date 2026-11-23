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
npm start          # build the interface, run the server, open the window (first run: in-window setup)
npm run setup      # the same setup in the terminal: the AI model, and with `-- google` your own Google client (writes ~/.tabellar/config.json and the Keychain)
npm run dev        # Vite dev server for the interface, proxying to a running server on :4848
npm run build      # build the interface to frontend/dist
npm run typecheck  # tsc for server/ and frontend/
npm pack           # the npm package: builds the interface and the server (to JavaScript in dist/) first

tabellar open      # open the window of a running server (after `npm link`; same as node server/tabellar.ts open)
tabellar status    # running? which accounts, model, engine level?
tabellar autostart on|off   # start at login via launchd (~/Library/LaunchAgents/com.tabellar.server.plist)
tabellar check     # policy asserts, planted-instruction emails and Autopilot through the engine, in a throwaway TABELLAR_HOME
```

Set `TABELLAR_HOME` to run against a different data folder (default `~/.tabellar`). The Keychain service is always `tabellar`.

## Architecture

### Layout

```
bin/         tabellar.js, the command: runs server/tabellar.ts in a checkout, dist/tabellar.js in the npm package
server/      one Node process, no runtime dependencies
frontend/    React + Tailwind, built with Vite to frontend/dist, served by the server
docs/        the public home page and privacy policy, served by GitHub Pages (Google's consent screen links to them)
```

The npm package (`files` in package.json) holds `bin/`, `frontend/dist/` and `dist/`, which is `server/` built to JavaScript by `npm run build:server`, because Node does not strip types under `node_modules`. A path to a neighbouring server file goes through `sibling()` in `config.ts`, which picks `.ts` or `.js`; relative imports are rewritten by tsc.

### Server (`server/`)

- `server.ts`: `node:http` on 127.0.0.1 (port 4848 by default). Checks the Host header, refuses foreign Origins, and requires the access token as `Authorization: Bearer` on `/api/*`, `/db`, `/db/rpc` and `/session`. `index.html` is served with the token injected only to browsers holding the session cookie, which is exchanged for a one-time code minted by `tabellar open`. Also runs Google sign-in (`/oauth/start`, `/oauth/callback`), the live event stream (`/events`, server-sent events), and a 10-second timer that calls `outbox.ts`.
- `outbox.ts`: `sendDueEmails()` sends due `scheduled_emails` (undo send, send later, Autopilot replies). A row with `source` "autopilot" is checked again when due (pause, level, `checkAutoSend` against the stored email it answers) and kept as a draft if refused. `transport` is swapped for a recorder by `tabellar check`.
- `sync.ts`: `syncMail(userId, initial)` fetches new mail (Gmail history, paginated) and `analyzeInbox(userId)` runs the analysis; each is serialised so the window and the engine never overlap.
- `engine.ts`: the background engine, started by `startServer`. Every 2 minutes (and on the first tick after wake) it runs sync, analysis, then `planNew`, which turns each newly analysed email (`email_processed.engine_at` null, received within 7 days) into planned actions: a `Tabellar/<Category>` Gmail label, a reply draft (action-required, real sender), a todo, a meeting proposal. At Autopilot the reply is instead scheduled as a send after `profiles.autopilot_delay_min` (only to someone the user wrote to, when `autopilot_known_only`; the model can answer HOLD to get a draft instead). Sends macOS notifications per `profiles.notification_level`, and always for Autopilot replies.
- `policy.ts`: `decide()` is the only place an action is authorised. Levels `observe`/`suggest`/`assist`/`autopilot` (`profiles.autonomy_level`; anything else counts as observe), `profiles.engine_paused`, caps per cycle and per day (Autopilot sends also capped by `profiles.autopilot_daily_cap`), and `looksLikeInstructions()` which limits planted-instruction email to a label. The engine never archives or unsubscribes, and sends only at Autopilot, only in the shape `checkAutoSend()` allows: one recipient who is the email's writer (Reply-To, else From), same thread, no cc/bcc, no attachments. `proposalHash()` binds an approval to the exact proposal.
- `actions.ts`: `act()` decides then does, proposes (status `proposed` with a hash) or logs a refusal in `action_log`; `approve`, `dismiss`, `undo`. The agent's archive and the assistant's archive go through `act()` and archive in Gmail; agent and assistant sends are recorded. An archive with `detail.emailIds` archives (and undoes) a batch through Gmail's batchModify. An Autopilot send becomes a `scheduled_emails` row; undo cancels it while still pending. Everything checks pause.
- `newsletters.ts`: the Newsletters view's server side. `listNewsletters` groups bulk senders (List-Unsubscribe, promotions, Precedence bulk/list; people the user wrote to are left out); `unsubscribe` reads List-Unsubscribe fresh from Gmail and does RFC 8058 one-click (public https hosts only), a mailto (only after the window echoes back the exact address it showed), or returns a web page to open; `archiveSender`; `keepSender`. State in `newsletter_senders`.
- `notify.ts` (channels list, macOS via osascript argv), `launchd.ts` (login item), `check.ts` (run by `tabellar check`).
- `api.ts`: `handleApi(req, path)` with all routes under `/api` (fetch-emails, send-email, drafts, briefing, calendar, chat, follow-ups, signatures, agent, ...). Written against Web `Request`/`Response`.
- `db.ts`: the SQLite schema (one `SCHEMA` object; columns typed uuid/text/int/real/bool/json/time, defaults filled in on insert, new columns added automatically on start) and `execute(spec)`, which runs supabase-js style queries. Every write is published on `changes` for the event stream. `db.rpc` provides `alloc_agent_turn_idx`, `merge_bucket_draft_actions`, `increment_knowledge_use_count`.
- `query.ts`: the query builder (`from().select().eq().order()...`, `.or()` PostgREST strings, embedded selects like `email_processed(summary)` and `emails!inner(...)`). Shared by the server and the interface.
- `google.ts`: installed-app OAuth with PKCE on the loopback address, through `googleClient()` in `config.ts`: the user's own client when `config.googleClientId` is set, otherwise `BUILT_IN_GOOGLE`, the client that ships with Tabellar. Tokens only work with the client that issued them. Refresh tokens live in the Keychain; `gmail_accounts.token_ref` holds only the Keychain item name. Access tokens are kept in memory (`freshAccessToken`).
- `llm.ts`: `chatCompletion` takes OpenAI chat-completions requests with a `slot`, `fast` (reading each email: `processFullEmail`, entities, todos, meetings) or `careful` (default: drafts, briefing, assistant, agent). `config.model` is the careful model and `config.fastModel` the fast one, which falls back to `model` when unset. It sends them in that model's `format`: `ollama` (Ollama's native `/api/chat`, so `num_ctx` can be set; no API key), `openai` (forwarded to any OpenAI-compatible endpoint, retrying once without `temperature` or with `max_completion_tokens` when a model rejects them), or `anthropic` (translated to the Messages API and back). Local models get longer timeouts and lower analysis concurrency (`isLocalModel`, `modelTimeoutMs`). Anthropic content blocks come back on the message as `_anthropic` and are replayed verbatim on later turns so thinking blocks stay intact; the agent persists them in `agent_turns.content.raw`.
- `ai.ts` (prompts and AI helpers), `gmail.ts` (Gmail, Calendar, People API client), `agentLoop.ts` / `agentTools.ts` / `agentExecute.ts` (the agent), `analyzeEmails.ts`, `buildBriefing.ts`.
- `setup.ts`: first-run setup shared by the window (`/api/setup/*`, routed in `server.ts` before `handleApi`) and `tabellar setup`: finding and saving the user's own Google client file or going back to the built-in client, installing and starting Ollama (its bundled `ollama serve`, not the menu bar app, whose first launch asks for an admin password), pulling models (with a direct registry download when Ollama can't reach it), and cloud provider key checks. Progress streams as NDJSON.
- `config.ts`: paths, `config.json` (port, the user's own Google client id if any, model provider/format/base URL/model), `BUILT_IN_GOOGLE`, Keychain helpers (`keychainGet/Set/Delete`), and `getEnv` for the few settings the backend reads.

### Interface (`frontend/`)

- `src/main.tsx` loads `/session`, then renders `AppShell` + `EmailDashboard` when a Google account is connected, otherwise `Welcome` (onboarding: model, then Gmail; the Google client step appears only for bringing your own, or first when no client is built in). `ModelSetup.tsx` is the model picker shared by onboarding and Settings > AI.
- `src/lib/db.ts`: `createClient()` returns an object shaped like the supabase-js client the views were written against: `from()` posts the query to `/db`, `auth.getSession()` returns the local user and access token, `channel().on("postgres_changes", ...)` listens on `/events`. Views keep calling `supabase.from(...)`.
- Global state lives in `AppShell.tsx` via React context (`useApp()`): `user`, `profile`, `view`, `addToast`, compose, agent state, and `mail` (below). The shell is a sidebar plus the current view; there is no global top bar, each view renders its own `ViewBar`.
- `src/lib/outcomes.ts`: `useOverview()` loads the action log, drafts, todos, meetings and pending sends once and derives what Tabellar made of each email (`mail.byEmail`), the sidebar counts, the outgoing replies and the engine state, plus `approve`, `dismiss`, `undo`. Inbox rows, the details panel and the sidebar all read from it.
- `src/lib/useInboxSync.ts`: the window's own fetch (first-run overlay, catch-up on open).
- API calls are `fetch("/api/...")` with `Authorization: Bearer ${session.access_token}`.

### Design system

`frontend/DESIGN.md` describes it. The rules that matter when editing a view:

- Colours are tokens defined in `src/index.css` and exposed as Tailwind classes in `tailwind.config.cjs` (`ink`, `ink2`, `ink3`, `canvas`, `side`, `raised`, `hover`, `sel`, `field`, `line`, `wax`, `warn`, `danger`, `ok`, ...). No Tailwind palette classes, hex values or `dark:` variants in components; the tokens follow the theme. Wax red is kept for what needs the user, the one primary action in a region, and outgoing countdowns.
- Shared parts: the component classes in `src/index.css` (`.btn`, `.row`, `.row2`, `.day`, `.bar`, `.pop`, ...) and `src/components/ui.tsx` (`ViewBar`, `Seg`, `Menu`, `Tick`, `Glyph`, `Empty`, `SkeletonRows`, `KeyHints`, `VirtualList`). Long lists go through `VirtualList`.
- Icons come from `src/components/Icon.tsx` (Lucide, bundled); the logo from `Logo.tsx`. Fonts are bundled in `src/assets/fonts`; nothing is loaded from the network.

### Data

One user per install. All tables keep a `user_id` column; the profile row is created at first Google sign-in. Key tables: `profiles`, `gmail_accounts`, `emails`, `action_log` (what the engine, agent and assistant did or propose, with undo info in `detail`), `newsletter_senders`, `email_processed` (category, summary, quick_actions; upsert on `email_id`), `todos`, `meetings`, `follow_up_reminders`, `scheduled_emails`, `draft_emails`, `knowledge_base`, `email_memory`, `contacts`, `agent_sessions`, `agent_turns`.

### Secrets

Never in files, with one exception: the built-in Google client's id and secret are constants in `config.ts`, since Google does not treat a desktop app's client secret as confidential. Keychain items (service `tabellar`): `access-token`, `google-client-secret` (only with the user's own client), `model-api-key:<provider>` (one per cloud provider in use), and one `google:<hash>` item per connected Google account. Downloaded `client_secret*.json` files are gitignored; setup imports them and offers to trash them.
