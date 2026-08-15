# RuneMail

**AI-powered email client built on top of Gmail.** RuneMail connects to your Gmail account and uses AI to triage your inbox, surface action items, draft replies in your writing style, and deliver a daily briefing.

---

## Features

- **Smart Inbox** - AI categorizes every email and extracts todos, meetings, and suggested replies automatically
- **Three AI Modes** - Choose between fully local (on-device, private), cloud, or hybrid processing
- **Daily Briefing** - Morning summary of your most important emails, strictly bucketed into Reply Needed, Deadlines, Crucial, and Non-essential
- **Solve Everything** - Conversational AI agent that clears your whole briefing: proposes replies, todos, meetings, and bulk archives, asks you for any ambiguous decisions via interactive cards, and executes the approved plan in one click. Runs in the background so you can keep working
- **AI Assistant** - Conversational assistant with full access to your inbox context
- **Smart Drafts** - AI-generated replies that learn and match your personal writing style
- **Read Receipts** - Invisible tracking pixel embedded in outgoing emails so you know when they are opened
- **Scheduled Send** - Queue emails to deliver at a specific time
- **Calendar and Zoom Integration** - Create Google Calendar events and Zoom meetings directly from emails
- **Web Push Notifications** - Real-time browser notifications for new emails via Gmail webhooks
- **Multi-Account Gmail** - Connect and switch between multiple Gmail accounts
- **Interactive Tutorial** - Guided demo using a fake inbox so new users can explore every feature before connecting their real account

## AI Modes

| Mode | Description | Privacy |
|------|-------------|---------|
| **Local** | Runs Qwen2.5-3B entirely in your browser via WebLLM. No data leaves your device. | Maximum |
| **Cloud** | Uses OpenRouter (or Cerebras) via Supabase Edge Functions. Fast and always available. | Standard |
| **Hybrid** | Tries local inference first; falls back to cloud on failure. | High |

The local model (~4 GB) is downloaded once and cached in the browser.

## Tech Stack

**Frontend**
- [Next.js](https://nextjs.org/) (App Router) + TypeScript
- [Tailwind CSS](https://tailwindcss.com/) for styling
- [@mlc-ai/web-llm](https://github.com/mlc-ai/web-llm) for in-browser LLM inference (local mode)
- [Supabase JS](https://supabase.com/docs/reference/javascript) for auth and database access

**Backend**
- [Supabase](https://supabase.com/) for PostgreSQL database, Row Level Security, auth, and Edge Functions (Deno)
- [OpenRouter](https://openrouter.ai/) or [Cerebras](https://cerebras.ai/) for cloud AI processing
- Gmail API and Google Calendar API for email and calendar access
- Web Push API for real-time browser notifications

**Infrastructure**
- [Vercel](https://vercel.com/) for frontend deployment
- Supabase for backend and database hosting

## Repository Structure

```
RuneMail/
├── frontend/                   # Next.js application
│   └── src/
│       ├── app/                # App Router: landing, /app, /auth, /privacy, /terms
│       ├── components/         # UI components
│       │   ├── views/          # InboxView, BriefingView, TodosView, MeetingsView, etc.
│       │   └── tutorial/       # Interactive tutorial with fake demo inbox
│       └── lib/
│           ├── emailGraph.ts   # LangGraph-style AI state machine
│           ├── webllm.ts       # Browser-side LLM inference wrapper
│           └── supabase/       # Supabase client helpers and middleware
├── supabase/
│   ├── functions/
│   │   ├── api/index.ts        # Main Edge Function (all backend routes)
│   │   ├── scheduled-emails/   # Cron function for scheduled email delivery
│   │   ├── process-emails/     # Cron function that renews Gmail Pub/Sub watches
│   │   └── _shared/            # ai.ts, gmail.ts, cors.ts, fernet.ts,
│   │                           # agentLoop.ts, agentTools.ts, agentExecute.ts,
│   │                           # buildBriefing.ts
│   ├── migrations/             # SQL migrations
│   └── schema.sql              # Full database schema with RLS policies
└── vercel.json                 # Points Vercel build at frontend/
```

## Getting Started

### Prerequisites

- Node.js 20.18.0 (see `.nvmrc`)
- A [Supabase](https://supabase.com/) project
- A Google Cloud project with the Gmail API and Google Calendar API enabled
- An [OpenRouter API key](https://openrouter.ai/) for cloud/hybrid AI mode (or a Cerebras key)

### 1. Clone and install

```bash
git clone https://github.com/smartlab-nyu/runemail.git
cd runemail

# npm workspace: this installs both the root tooling and the frontend
npm install
```

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

Copy `frontend/.env.example` to `frontend/.env.local`:

```bash
cp frontend/.env.example frontend/.env.local
```

**Edge function secrets** (set via `supabase secrets set`):

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | [OpenRouter](https://openrouter.ai/) key for cloud AI (or use `CEREBRAS_API_KEY` with `AI_PROVIDER=cerebras`) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Cloud Console OAuth 2.0 credentials |
| `TOKEN_ENCRYPTION_KEY` | Fernet key for encrypting Gmail tokens. Generate: `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | VAPID keys for Web Push. Generate: `npx web-push generate-vapid-keys` |
| `PUBSUB_TOPIC` | Google Cloud Pub/Sub topic for Gmail webhook notifications |

**Frontend variables** (Vercel project settings or `frontend/.env.local`):

| Variable | Description |
|----------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | Same VAPID public key as above |

### 3. Set up the database

Apply `supabase/schema.sql` first, then apply the migrations in `supabase/migrations/` in order using the Supabase SQL editor or CLI.

### 4. Configure Google OAuth

In Google Cloud Console:
1. Create an OAuth 2.0 Web Application client
2. Add your Supabase auth callback as an authorized redirect URI: `https://your-project-id.supabase.co/auth/v1/callback`
3. Enable the **Gmail API** and **Google Calendar API**
4. Add these OAuth scopes: `https://www.googleapis.com/auth/gmail.modify` and `https://www.googleapis.com/auth/calendar`

In Supabase, enable Google as an OAuth provider under Authentication > Providers.

### 5. Deploy Edge Functions

```bash
# Set secrets on your Supabase project
npx supabase secrets set \
  OPENROUTER_API_KEY=... \
  GOOGLE_CLIENT_ID=... \
  GOOGLE_CLIENT_SECRET=... \
  TOKEN_ENCRYPTION_KEY=... \
  NEXT_PUBLIC_VAPID_PUBLIC_KEY=... \
  VAPID_PRIVATE_KEY=... \
  PUBSUB_TOPIC=... \
  --project-ref your-project-id

# Deploy functions
npx supabase functions deploy api --project-ref your-project-id --no-verify-jwt
npx supabase functions deploy scheduled-emails --project-ref your-project-id
npx supabase functions deploy process-emails --project-ref your-project-id --no-verify-jwt
```

### 6. Run locally

```bash
# From the repo root
npm run dev
# Open http://localhost:3000
```

### 7. Deploy to Vercel

```bash
# From the repo root
npx vercel --prod
```

Set these environment variables in your Vercel project settings:
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`

## Architecture Notes

### State Management

Global app state lives in `AppShell.tsx` via React Context. Access it with `useApp()` inside any component. Key fields: `user`, `profile`, `view`, `syncing`, `addToast`.

### Email Processing Pipeline

When emails are fetched, each one goes through a multi-step AI pipeline:

1. **Categorize** - assigns a category label
2. **Summarize** - generates a one-sentence summary
3. **Extract actions** - identifies todos, meetings, and suggested replies

This pipeline runs via `emailGraph.ts`, a custom LangGraph-style state machine that dispatches to the correct AI backend (local WebLLM or cloud) based on the user's selected AI mode.

### Security

- All database tables use Row Level Security (RLS); users only access their own rows
- Gmail OAuth tokens are encrypted at rest using [Fernet symmetric encryption](https://cryptography.io/en/latest/fernet/)
- Three routes are reachable without a Supabase JWT, each gated a different way: `GET /health` (returns only a status string), `GET /track/pixel/:id.gif` (read-receipt pixel, looked up by unguessable UUID), and `POST /gmail/webhook` (Pub/Sub push, requires a matching `PUBSUB_VERIFICATION_TOKEN`). Every other route calls `getUserId()` and scopes its queries by that user id

## License

MIT
