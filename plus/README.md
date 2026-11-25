# Tabellar+

The service behind a Tabellar+ subscription (`server.ts`, `pages.ts`), one Node process with one SQLite file. It makes model keys with a monthly limit through OpenRouter, and for Always on one Fly app per person running the `hosted` image. Mail never passes through it.

| In the environment | |
|---|---|
| `PUBLIC_URL` | where it is reached, such as `https://tabellar-plus.fly.dev` |
| `MASTER` | 32 characters or more; every server's secrets are made from it. Lost, the servers' sign-ins cannot be opened again |
| `OPENROUTER_MANAGEMENT_KEY` | makes the keys |
| `FLY_API_TOKEN`, `FLY_ORG`, `FLY_REGION`, `IMAGE` | makes the servers; `IMAGE` is the pushed `hosted` image |
| `PADDLE_WEBHOOK_SECRET`, `PADDLE_CLIENT_TOKEN`, `PADDLE_PRICE_PLUS`, `PADDLE_PRICE_ALWAYS` | payments, with the webhook at `/paddle` and the `subscription.*` events |
| `OPEN=1` | anyone can pay; without it, invitations only |
| `PLUS_DB` | the file, `/data/plus.db` by default |

```bash
PLUS_DB=:memory: MASTER=0123456789012345678901234567890123 PUBLIC_URL=https://plus.example node plus/server.ts check
```

```bash
docker build --target hosted -t tabellar-hosted . && docker build --target plus -t tabellar-plus .
```

In the running service: `node plus/server.ts invite plus` (or `always`) prints a link without a payment; `list`, `end <id>` and `update <image>` do what they say. Microsoft's app needs `PUBLIC_URL/oauth/microsoft` as a redirect URI. Tabellar offers Tabellar+ when `PLUS_URL` in `server/config.ts` is set.
