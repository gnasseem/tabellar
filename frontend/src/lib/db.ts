// The interface's connection to the Tabellar server, shaped like the
// supabase-js client the views were written against:
//
//   supabase.from("emails").select(...)      runs on the local SQLite database
//   supabase.auth.getSession()              the local user and access token
//   supabase.channel(...).on("postgres_changes", ...)   live row changes
//
// Queries are recorded by the same builder the server uses and posted to /db.
// Changes arrive over one EventSource on /events.

import { Query, type QuerySpec, type Result } from "../../../server/query.ts";

declare global {
  interface Window {
    __TABELLAR_TOKEN__?: string;
  }
}

const TOKEN = window.__TABELLAR_TOKEN__ ?? "";

export type User = { id: string; email: string };

export type Session = {
  user: User | null;
  // untyped row, as the views expect
  profile: Record<string, any> | null;
  accounts: number;
  googleConfigured: boolean;
  modelConfigured: boolean;
};

let currentUser: User | null = null;

export async function loadSession(): Promise<Session> {
  const r = await fetch("/session", { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!r.ok) throw new Error(`Tabellar answered ${r.status}`);
  const s = (await r.json()) as Session;
  currentUser = s.user;
  return s;
}

async function post(path: string, body: unknown): Promise<Result> {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { data: null, error: { message: `Tabellar answered ${r.status}` }, count: null, status: r.status };
    return (await r.json()) as Result;
  } catch (e) {
    return { data: null, error: { message: (e as Error).message }, count: null, status: 0 };
  }
}

// ── Live changes ────────────────────────────────────────────────────────────

type ChangePayload = {
  schema: string;
  table: string;
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: Record<string, any>;
  old: Record<string, any>;
  commit_timestamp: string;
};

type Listener = {
  event: string;
  table: string;
  filter?: { col: string; op: string; value: string };
  callback: (payload: any) => void;
};

const channels = new Set<Channel>();
let source: EventSource | null = null;

function matches(row: Record<string, any>, f: NonNullable<Listener["filter"]>): boolean {
  const v = row?.[f.col];
  const s = v === null || v === undefined ? "null" : String(v);
  switch (f.op) {
    case "eq": return s === f.value;
    case "neq": return s !== f.value;
    case "in": return f.value.replace(/^\(|\)$/g, "").split(",").includes(s);
    case "gt": return s > f.value;
    case "gte": return s >= f.value;
    case "lt": return s < f.value;
    case "lte": return s <= f.value;
    default: return true;
  }
}

function connect() {
  if (source) return;
  source = new EventSource(`/events?token=${encodeURIComponent(TOKEN)}`);
  source.onmessage = (e) => {
    const change = JSON.parse(e.data) as { table: string; eventType: ChangePayload["eventType"]; new: Record<string, any>; old: Record<string, any> };
    const payload: ChangePayload = { schema: "public", ...change, commit_timestamp: new Date().toISOString() };
    for (const ch of channels) {
      for (const l of ch.listeners) {
        if (l.table !== change.table) continue;
        if (l.event !== "*" && l.event !== change.eventType) continue;
        if (l.filter && !matches(change.eventType === "DELETE" ? change.old : change.new, l.filter)) continue;
        try {
          l.callback(payload);
        } catch (err) {
          console.error("[live] listener failed:", err);
        }
      }
    }
  };
}

class Channel {
  listeners: Listener[] = [];

  on(_type: "postgres_changes", opts: { event: string; schema?: string; table: string; filter?: string }, callback: (payload: any) => void): this {
    const m = opts.filter?.match(/^(\w+)=(\w+)\.(.*)$/);
    this.listeners.push({
      event: opts.event,
      table: opts.table,
      filter: m ? { col: m[1], op: m[2], value: m[3] } : undefined,
      callback,
    });
    return this;
  }

  subscribe(callback?: (status: string, err?: Error) => void): this {
    channels.add(this);
    connect();
    callback?.("SUBSCRIBED");
    return this;
  }

  unsubscribe(): Promise<"ok"> {
    channels.delete(this);
    return Promise.resolve("ok");
  }
}

// ── The client ──────────────────────────────────────────────────────────────

const sessionResult = () => ({
  data: { session: currentUser ? { access_token: TOKEN, user: currentUser } : null },
  error: null,
});

const client = {
  from: (table: string) => new Query((spec: QuerySpec) => post("/db", spec), table),
  rpc: (fn: string, args?: Record<string, unknown>) => post("/db/rpc", { fn, args }),
  channel: (_name: string) => new Channel(),
  removeChannel: (ch: Channel) => ch.unsubscribe(),
  auth: {
    getSession: async () => sessionResult(),
    refreshSession: async () => sessionResult(),
    getUser: async () => ({ data: { user: currentUser }, error: null }),
    // Google sign-in runs on the server; it redirects back to the app.
    signInWithOAuth: async (_opts?: unknown) => {
      window.location.assign("/oauth/start");
      return { data: {}, error: null };
    },
    signOut: async () => {
      window.location.assign("/");
      return { error: null };
    },
    onAuthStateChange: (_cb: unknown) => ({ data: { subscription: { unsubscribe() {} } } }),
  },
};

export type DbClient = typeof client;

export function createClient(): DbClient {
  return client;
}
