// Taking back a choice the server spreads over several tables ("Never for
// this sender" writes a preference, removes todos and dismisses proposals):
// the rows it can touch are read before and after it, and undo puts back the
// ones that went or changed and removes the preferences it wrote.
import { createClient } from "@/lib/db";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Rows = Map<string, any>;
const supabase = createClient();

async function read(userId: string) {
  const of = async (q: PromiseLike<{ data: any[] | null }>): Promise<Rows> => new Map(((await q).data || []).map((r) => [r.id, r]));
  const [preferences, todos, meetings, draft_emails, questions, action_log] = await Promise.all([
    of(supabase.from("preferences").select("*").eq("user_id", userId)),
    of(supabase.from("todos").select("*").eq("user_id", userId).eq("is_completed", false)),
    of(supabase.from("meetings").select("*").eq("user_id", userId).eq("status", "proposed")),
    of(supabase.from("draft_emails").select("*").eq("user_id", userId)),
    of(supabase.from("questions").select("*").eq("user_id", userId)),
    of(supabase.from("action_log").select("id, status, reason, decided_at, undone_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(2000)),
  ]);
  return { preferences, todos, meetings, draft_emails, questions, action_log };
}

// Runs a change; returns what takes it back.
export async function reversible(userId: string, change: () => Promise<unknown>): Promise<() => Promise<void>> {
  const before = await read(userId);
  await change();
  const after = await read(userId);
  const gone = (name: "preferences" | "todos" | "meetings" | "draft_emails") => [...before[name].values()].filter((r) => !after[name].has(r.id));
  const back = { preferences: gone("preferences"), todos: gone("todos"), meetings: gone("meetings"), draft_emails: gone("draft_emails").map((r) => ({ ...r, gmail_draft_id: null, mailbox_version: null })) };
  const added = [...after.preferences.keys()].filter((id) => !before.preferences.has(id));
  const changed = (name: "questions" | "action_log") => [...before[name].values()].filter((r) => after[name].has(r.id) && after[name].get(r.id).status !== r.status);
  const logs = changed("action_log");
  const asked = changed("questions");
  return async () => {
    if (added.length) await supabase.from("preferences").delete().in("id", added);
    for (const [table, rows] of Object.entries(back)) if (rows.length) await supabase.from(table).insert(rows);
    for (const { id, ...r } of logs) await supabase.from("action_log").update(r).eq("id", id);
    for (const q of asked) await supabase.from("questions").update({ status: q.status, answer: q.answer, answered_at: q.answered_at }).eq("id", q.id);
  };
}
