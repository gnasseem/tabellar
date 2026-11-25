// Taking back a choice that is spread over several tables ("Never for this
// sender" writes a preference, removes todos and dismisses proposals): the
// rows it can touch are read before and after it, and undo puts back the ones
// that went or changed and removes the preferences and automations it made.
// Shared by the server (answers.ts) and the interface (lib/undo.ts), each with
// its own way to the database.

type Row = Record<string, any>;
type Rows = Map<string, Row>;
type Read = { from(table: string): any };

async function read(db: Read, userId: string) {
  const of = async (q: PromiseLike<{ data: Row[] | null }>): Promise<Rows> => new Map(((await q).data || []).map((r) => [r.id, r]));
  const [preferences, todos, meetings, draft_emails, questions, action_log, automations] = await Promise.all([
    of(db.from("preferences").select("*").eq("user_id", userId)),
    of(db.from("todos").select("*").eq("user_id", userId).eq("is_completed", false)),
    of(db.from("meetings").select("*").eq("user_id", userId).eq("status", "proposed")),
    of(db.from("draft_emails").select("*").eq("user_id", userId)),
    of(db.from("questions").select("*").eq("user_id", userId)),
    of(db.from("action_log").select("id, status, reason, decided_at, undone_at").eq("user_id", userId).order("created_at", { ascending: false }).limit(2000)),
    of(db.from("automations").select("*").eq("user_id", userId)),
  ]);
  return { preferences, todos, meetings, draft_emails, questions, action_log, automations };
}

// Runs a change; returns what takes it back.
export async function reversible(db: Read, userId: string, change: () => Promise<unknown>): Promise<() => Promise<void>> {
  const before = await read(db, userId);
  await change();
  const after = await read(db, userId);
  const gone = (name: "preferences" | "todos" | "meetings" | "draft_emails" | "automations") => [...before[name].values()].filter((r) => !after[name].has(r.id));
  const back = { automations: gone("automations"), preferences: gone("preferences"), todos: gone("todos"), meetings: gone("meetings"), draft_emails: gone("draft_emails").map((r) => ({ ...r, gmail_draft_id: null, mailbox_version: null })) };
  const added = [...after.preferences.keys()].filter((id) => !before.preferences.has(id));
  const made = [...after.automations.keys()].filter((id) => !before.automations.has(id));
  const turned = [...before.automations.values()].filter((r) => after.automations.has(r.id) && after.automations.get(r.id)!.enabled !== r.enabled);
  const changed = (name: "questions" | "action_log") => [...before[name].values()].filter((r) => after[name].has(r.id) && after[name].get(r.id)!.status !== r.status && r.status !== "running");
  const logs = changed("action_log");
  const asked = changed("questions");
  return async () => {
    if (added.length) await db.from("preferences").delete().in("id", added);
    for (const [table, rows] of Object.entries(back)) if (rows.length) await db.from(table).insert(rows);
    if (made.length) await db.from("automations").delete().in("id", made);
    for (const a of turned) await db.from("automations").update({ enabled: a.enabled, undone: a.undone }).eq("id", a.id);
    for (const { id, ...r } of logs) await db.from("action_log").update(r).eq("id", id);
    for (const q of asked) await db.from("questions").update({ status: q.status, answer: q.answer, answered_at: q.answered_at }).eq("id", q.id);
  };
}
