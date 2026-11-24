// The window's first run, after the first mailbox is connected: the model,
// About you, examples from the user's own mail, people and labels, the level.
// profiles.onboarding holds the step the window is on and is "done" after
// the last one; until then the engine reads mail but plans nothing
// (engine.ts), so what the user says here is in place before the first todo
// or draft. Every step can be skipped and none waits on the model.

import { db } from "./db.ts";
import { modelConfigured } from "./llm.ts";
import { firstReadState } from "./firstRead.ts";
import { localJobState } from "./setup.ts";
import { allPrefs, applyPref, displayName, learn, pick, ROLE, setPref, stops, WORK } from "./profile.ts";
import { todoOf, type Action } from "./rules.ts";
import { followupList, SERVICE, SERVICE_NAME } from "./followups.ts";
import { listNewsletters } from "./newsletters.ts";
import { bulkHeaders, jobSystem, ownAddresses } from "./senders.ts";
import { planNew } from "./engine.ts";
import { labelsBySender, userLabels } from "./labels.ts";

export const STEPS = ["mailboxes", "model", "about", "examples", "people", "level"] as const;
const LEVELS = ["observe", "suggest", "assist", "autopilot"];
const NO_REPLY = /no.?reply|do.?not.?reply|notifications?@|mailer|bounce/i;
const lc = (s: unknown) => String(s ?? "").trim().toLowerCase();

// What the window shows along the bottom while the mail is read.
export async function onboardingState(userId: string) {
  const [{ data: me }, read, { count: emails }, { count: sorted }] = await Promise.all([
    db.from("profiles").select("onboarding").eq("id", userId).maybeSingle(),
    firstReadState(userId),
    db.from("emails").select("id", { count: "exact", head: true }).eq("user_id", userId).not("label_ids", "cs", '{"SENT"}'),
    db.from("email_processed").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);
  return { step: String(me?.onboarding ?? "done"), read, emails: emails ?? 0, sorted: sorted ?? 0, model: modelConfigured(), local: localJobState() };
}

export async function setStep(userId: string, step: string): Promise<void> {
  if (!(STEPS as readonly string[]).includes(step)) throw Object.assign(new Error(`Unknown step "${step}"`), { status: 400 });
  await db.from("profiles").update({ onboarding: step }).eq("id", userId).neq("onboarding", "done");
}

// ── About you ───────────────────────────────────────────────────────────────

// The role and the work as fields, the other facts as lines, and the topics
// the user never wants to hear about.
export async function aboutYou(userId: string) {
  const rows = await allPrefs(userId);
  const facts = rows.filter((r) => r.kind === "fact");
  const field = (prefix: string) => {
    const f = facts.find((r) => r.value.startsWith(prefix));
    return f ? { value: f.value.slice(prefix.length), source: f.source } : null;
  };
  const read = await firstReadState(userId);
  return {
    role: field(ROLE),
    work: field(WORK),
    facts: facts.filter((r) => !r.value.startsWith(ROLE) && !r.value.startsWith(WORK)).map((r) => ({ id: r.id, value: r.value, source: r.source })),
    never: rows.filter((r) => r.kind === "topic" && r.value === "ignore").map((r) => r.subject),
    // Whether the sent mail has been read for facts yet, and how much of it.
    learned: read.learned || read.step === "deep" || read.step === "done",
    sent: read.sent,
  };
}

export async function saveAboutYou(userId: string, b: { role?: unknown; work?: unknown; never?: unknown; removed?: unknown }): Promise<void> {
  const rows = await allPrefs(userId);
  const facts = rows.filter((r) => r.kind === "fact");
  for (const [prefix, value] of [
    [ROLE, b.role],
    [WORK, b.work],
  ] as const) {
    if (typeof value !== "string") continue;
    const text = value.replace(/\s+/g, " ").trim().slice(0, 200);
    const old = facts.filter((r) => r.value.startsWith(prefix));
    if (old.length === 1 && old[0].value === prefix + text) continue;
    if (old.length) await db.from("preferences").delete().in("id", old.map((r) => r.id));
    if (text) await setPref(userId, "fact", "", prefix + text, "user");
  }
  if (Array.isArray(b.removed)) {
    const ids = b.removed.map(String).filter((id) => facts.some((r) => r.id === id));
    if (ids.length) await db.from("preferences").delete().in("id", ids);
  }
  if (Array.isArray(b.never)) {
    const want = new Set(b.never.map((t) => String(t ?? "").replace(/\s+/g, " ").trim().toLowerCase()).filter((t) => t.length > 1 && t.length < 60));
    const have = rows.filter((r) => r.kind === "topic" && r.value === "ignore");
    const drop = have.filter((r) => !want.has(r.subject)).map((r) => r.id);
    if (drop.length) await db.from("preferences").delete().in("id", drop);
    for (const t of want) {
      if (have.some((r) => r.subject === t)) continue;
      await setPref(userId, "topic", t, "ignore", "user", "Said in About you");
      await applyPref(userId, "topic", t, "ignore");
    }
  }
}

// ── Examples from the user's own mail ───────────────────────────────────────

export type Example = {
  key: string;
  kind: "todo" | "meeting" | "followup" | "newsletter";
  what: string; // the todo, the meeting, what was asked, the sender's name
  quote: string | null; // the sentence it came from; for a newsletter, why it is one
  who: string; // the sender or, for a follow-up, the person written to
  address: string;
  subject: string;
  at: string | null; // when it was received or sent; a meeting's start
  emailId: string | null;
};

const MAX = { todo: 4, meeting: 2, followup: 2, newsletter: 2 };
const TOTAL = 10;

// What Tabellar would make from the mail read so far, about ten of them:
// todos and meetings by the same rules the engine follows (rules.ts),
// follow-ups and newsletters from their own lists. Anything a preference
// already settles is left out, and there is one of each kind per person.
export async function examples(userId: string): Promise<Example[]> {
  const prefs = await allPrefs(userId);
  const settled = (address: string, text: string, thing: Example["kind"]) =>
    !!stops(pick(prefs, address, text), thing) || prefs.some((r) => r.kind === "sender" && r.subject === address && r.source === "user");
  const out: Example[] = [];
  const seen = new Set<string>();
  const add = (e: Example) => {
    if (seen.has(`${e.kind} ${e.address}`) || out.filter((x) => x.kind === e.kind).length >= MAX[e.kind]) return;
    seen.add(`${e.kind} ${e.address}`);
    out.push(e);
  };

  // Opened again from Settings: what is already made or waiting is not asked about.
  const { data: log } = await db.from("action_log").select("kind, email_id").eq("user_id", userId).in("kind", ["todo", "meeting"]).in("status", ["done", "proposed", "running"]);
  const made = new Set((log ?? []).map((r) => `${r.kind} ${r.email_id}`));
  const { data: rows } = await db
    .from("email_processed")
    .select("category, quick_actions, emails!inner(id, subject, sender, sender_email, body_text, snippet, is_calendar, received_at, label_ids)")
    .eq("user_id", userId)
    .order("processed_at", { ascending: false })
    .limit(400);
  const read = ((rows ?? []) as Record<string, any>[]).sort((a, b) => String(b.emails.received_at).localeCompare(String(a.emails.received_at)));
  for (const r of read) {
    const e = r.emails;
    const address = lc(e.sender_email);
    if (!address || ((e.label_ids as string[] | null) ?? []).includes("SENT")) continue;
    const actions = (Array.isArray(r.quick_actions) ? r.quick_actions : []) as Action[];
    const base = { who: displayName(e.sender, address), address, subject: String(e.subject ?? ""), at: e.received_at ?? null, emailId: String(e.id) };
    const todo = todoOf(actions, e, String(r.category));
    if (todo && !made.has(`todo ${e.id}`) && !settled(address, base.subject, "todo")) {
      add({ ...base, key: `todo:${e.id}`, kind: "todo", what: String(todo.label).trim(), quote: todo.quote ? String(todo.quote) : null });
    }
    const meeting = actions.find((a) => a.action === "schedule_meeting");
    const details = (meeting?.meetingDetails ?? {}) as { title?: string; dateTime?: string | null };
    if (meeting && details.dateTime && !e.is_calendar && !made.has(`meeting ${e.id}`) && !settled(address, base.subject, "meeting")) {
      add({ ...base, key: `meeting:${e.id}`, kind: "meeting", what: String(details.title || meeting.label || base.subject).trim(), quote: meeting.quote ? String(meeting.quote) : null, at: details.dateTime });
    }
  }

  for (const f of await followupList(userId).catch(() => [])) {
    if (f.reminder_id || settled(lc(f.recipient_email), f.subject, "followup")) continue;
    add({ key: `followup:${f.email_id}`, kind: "followup", what: f.asked || f.subject, quote: null, who: f.recipient_name, address: lc(f.recipient_email), subject: f.subject, at: f.sent_at, emailId: f.email_id });
  }
  for (const n of (await listNewsletters(userId).catch(() => [])).slice(0, 20)) {
    if (n.status || settled(n.sender_email, "", "newsletter")) continue;
    add({ key: `newsletter:${n.sender_email}`, kind: "newsletter", what: n.name, quote: n.reason, who: n.name, address: n.sender_email, subject: "", at: n.last_at ?? null, emailId: null });
  }

  // Todos and meetings first, as they are what Tabellar makes most.
  const order = { todo: 0, meeting: 1, followup: 2, newsletter: 3 };
  return out.sort((a, b) => order[a.kind] - order[b.kind]).slice(0, TOTAL);
}

// Yes: Tabellar may make this from their mail (a todo or meeting sender
// becomes someone the user deals with; a follow-up is kept as a reminder).
// No: not this one (taken out of what the email's analysis suggests, so it is
// never planned; a follow-up is dismissed; a newsletter sender is not one).
// Never: a preference for the sender, as the "Not this" menu writes it.
export async function answerExample(userId: string, b: { kind?: unknown; address?: unknown; emailId?: unknown; answer?: unknown }): Promise<void> {
  const kind = String(b.kind ?? "");
  const answer = String(b.answer ?? "");
  const address = lc(b.address);
  const emailId = typeof b.emailId === "string" ? b.emailId : null;
  if (!["todo", "meeting", "followup", "newsletter"].includes(kind) || !["yes", "no", "never"].includes(answer) || !address) {
    throw Object.assign(new Error("kind, address and answer are required"), { status: 400 });
  }
  if (kind === "newsletter") {
    if (answer !== "yes") await setPref(userId, "sender", address, "not_newsletter", "user", "Said not a newsletter, in the first run");
    return;
  }
  if (answer === "never") {
    await learn(userId, { thing: kind as "todo" | "meeting" | "followup", outcome: "never_sender", sender: address });
    return;
  }
  if (kind === "followup") {
    const f = (await followupList(userId)).find((x) => x.email_id === emailId);
    if (!f) return;
    await db.from("follow_up_reminders").upsert({
      user_id: userId, email_id: f.email_id, thread_id: f.thread_id, recipient_email: f.recipient_email, recipient_name: f.recipient_name,
      subject: f.subject, remind_at: new Date().toISOString(), status: answer === "yes" ? "waiting" : "dismissed", created_at: new Date().toISOString(),
    }, { onConflict: "user_id,thread_id" });
    return;
  }
  if (answer === "yes") {
    const own = pick(await allPrefs(userId), address, "");
    if (!own.some((r) => ["vip", "normal", "quiet", "ignore"].includes(r.value))) {
      await setPref(userId, "sender", address, "normal", "user", `Said yes to a ${kind} from their mail, in the first run`);
    }
    return;
  }
  if (!emailId) return;
  const { data: proc } = await db.from("email_processed").select("id, quick_actions").eq("email_id", emailId).eq("user_id", userId).maybeSingle();
  if (!proc) return;
  const drop = kind === "todo" ? "add_todo" : "schedule_meeting";
  const kept = ((proc.quick_actions as Action[] | null) ?? []).filter((a) => a.action !== drop);
  await db.from("email_processed").update({ quick_actions: kept }).eq("id", proc.id);
}

// ── People ──────────────────────────────────────────────────────────────────

// The people the user deals with most, by the sender statistics: written to
// and answered count most, then opened. Mailing lists, services and the
// user's own addresses are left out.
export async function people(userId: string) {
  const [{ data }, own, prefs] = await Promise.all([
    db.from("senders").select("address, name, received, opened, replied, sent_to, list_unsubscribe, list_id, precedence, category").eq("user_id", userId).or("sent_to.gt.0,replied.gt.0,opened.gt.1").limit(5000),
    ownAddresses(userId),
    allPrefs(userId),
  ]);
  const score = (s: Record<string, any>) => Number(s.sent_to) * 3 + Number(s.replied) * 2 + Number(s.opened);
  const known = ((data ?? []) as Record<string, any>[]).filter(
    (s) => !own.has(s.address) && !NO_REPLY.test(s.address) && !SERVICE.test(s.address.split("@")[0]) && !SERVICE_NAME.test(s.name ?? "") && !jobSystem(s.address, s.name) && s.category !== "promotions" && !bulkHeaders(s.list_unsubscribe, s.list_id, s.precedence),
  );
  // Opened mail alone counts only while there are few they wrote to.
  const wrote = known.filter((s) => s.sent_to > 0 || s.replied > 0);
  return (wrote.length >= 5 ? wrote : known)
    .sort((a, b) => score(b) - score(a))
    .slice(0, 12)
    .map((s) => ({
      address: String(s.address),
      name: displayName(s.name, s.address),
      sent: Number(s.sent_to),
      received: Number(s.received),
      vip: prefs.some((r) => r.kind === "sender" && r.subject === s.address && r.value === "vip"),
    }));
}

export async function setVip(userId: string, address: string, on: boolean): Promise<void> {
  const a = lc(address);
  if (!/^[^\s@]+@[^\s@]+$/.test(a)) throw Object.assign(new Error("address is required"), { status: 400 });
  if (on) return setPref(userId, "sender", a, "vip", "user", "Marked as someone who matters, in the first run");
  await db.from("preferences").delete().eq("user_id", userId).eq("kind", "sender").eq("subject", a).eq("value", "vip");
}

// ── Done ────────────────────────────────────────────────────────────────────

// The level is set, the first run is over, and everything read meanwhile is
// planned now, under what the user said.
export async function finish(userId: string, b: { level?: unknown }): Promise<void> {
  const level = String(b.level ?? "suggest");
  if (!LEVELS.includes(level)) throw Object.assign(new Error(`Unknown level "${level}"`), { status: 400 });
  const patch: Record<string, unknown> = { autonomy_level: level, onboarding: "done", updated_at: new Date().toISOString() };
  await db.from("profiles").update(patch).eq("id", userId);
  void (async () => {
    // Labels kept in the first run, on the mail sorted before they existed.
    const labels = await userLabels(userId);
    const { data: waiting } = labels.length
      ? await db.from("email_processed").select("id, extra_labels, emails!inner(sender_email)").eq("user_id", userId).is("engine_at", null).limit(5000)
      : { data: [] };
    for (const r of (waiting ?? []) as Record<string, any>[]) {
      const own = labelsBySender(labels, String(r.emails.sender_email ?? ""));
      const had = (r.extra_labels as string[] | null) ?? [];
      if (own.some((s) => !had.includes(s))) await db.from("email_processed").update({ extra_labels: [...new Set([...had, ...own])] }).eq("id", r.id);
    }
    // A pause leaves everything unplanned, so it stops at once then.
    for (let i = 0, last = -1; i < 50; i++) {
      const { count } = await db.from("email_processed").select("id", { count: "exact", head: true }).eq("user_id", userId).is("engine_at", null);
      if (!count || count === last) break;
      last = count;
      await planNew(userId);
    }
  })().catch((e) => console.error("[onboarding] planning:", e));
}
