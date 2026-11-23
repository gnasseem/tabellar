// The user's own labels (the categories table): a name, a colour, a line
// that tells the model which mail belongs, examples, an order and the Gmail
// label each maps to. The engine applies them in Gmail (engine.ts); the
// Inbox's Priority grouping follows their order.
//
// An example is a sender ("someone@example.com", or "@example.com" for a
// whole domain) with the subject of an email the user put in the label. The
// model sees them as examples, and mail from an example's sender gets the
// label in code, so bulk mail the model never reads is labelled too.

import { db } from "./db.ts";
import { labelsFromMail } from "./ai.ts";
import { modelConfigured } from "./llm.ts";
import { act, engineSettings, undo } from "./actions.ts";

export type Example = { sender: string; subject?: string };
export type Label = { slug: string; display_name: string; description: string; examples: Example[]; position: number; gmail_label: string | null };
export type Suggestion = { name: string; description: string; senders: string[]; count: number };

const EXAMPLES_IN_PROMPT = 4;
const MAX_EXAMPLES = 12;

export async function userLabels(userId: string): Promise<Label[]> {
  const { data } = await db.from("categories").select("slug, display_name, description, examples, position, gmail_label").eq("user_id", userId).order("position", { ascending: true });
  return ((data ?? []) as Record<string, unknown>[]).map((r) => ({
    slug: String(r.slug),
    display_name: String(r.display_name),
    description: String(r.description ?? ""),
    examples: Array.isArray(r.examples) ? (r.examples as Example[]) : [],
    position: Number(r.position ?? 0),
    gmail_label: (r.gmail_label as string | null) ?? null,
  }));
}

// The Gmail label a user label maps to.
export const gmailLabelOf = (l: Pick<Label, "display_name" | "gmail_label">) => l.gmail_label?.trim() || `Tabellar/${l.display_name}`;

// Does an address match an example's sender?
export function senderMatches(example: string, address: string): boolean {
  const e = example.trim().toLowerCase();
  const a = address.trim().toLowerCase();
  if (!e || !a) return false;
  if (e.startsWith("@")) {
    const domain = a.split("@")[1] ?? "";
    return domain === e.slice(1) || domain.endsWith(`.${e.slice(1)}`);
  }
  return e === a;
}

// The labels an email gets from its sender alone.
export function labelsBySender(labels: Label[], address: string): string[] {
  return labels.filter((l) => l.examples.some((x) => senderMatches(x.sender, address))).map((l) => l.slug);
}

// The labels as the model reads them: slug, the line, and a few examples.
export function labelsForPrompt(labels: Label[]): { slug: string; description: string }[] {
  return labels.map((l) => {
    const ex = l.examples
      .filter((x) => x.subject)
      .slice(0, EXAMPLES_IN_PROMPT)
      .map((x) => `"${x.subject}" from ${x.sender}`);
    const senders = [...new Set(l.examples.filter((x) => !x.subject).map((x) => x.sender))].slice(0, EXAMPLES_IN_PROMPT);
    const rest = [l.description, ex.length ? `for example ${ex.join("; ")}` : "", senders.length ? `mail from ${senders.join(", ")}` : ""].filter(Boolean);
    return { slug: l.slug, description: `"${l.display_name}"${rest.length ? `: ${rest.join("; ")}` : ""}` };
  });
}

// Labels to suggest, from the senders of the last 90 days and recent
// subjects: one careful-model call, kept in profiles.label_suggestions. Only
// senders that are in the list are kept, and a suggestion needs one.
let suggesting: Promise<Suggestion[]> | null = null;
export function suggestLabels(userId: string): Promise<Suggestion[]> {
  suggesting ??= findSuggestions(userId).finally(() => {
    suggesting = null;
  });
  return suggesting;
}

async function findSuggestions(userId: string): Promise<Suggestion[]> {
  if (!modelConfigured()) return [];
  const [{ data: senders }, { data: mail }] = await Promise.all([
    db.from("senders").select("address, name, received, opened, replied, sent_to").eq("user_id", userId).gte("received", 2).order("received", { ascending: false }).limit(150),
    db.from("emails").select("sender_email, subject").eq("user_id", userId).not("label_ids", "cs", '{"SENT"}').order("received_at", { ascending: false }).limit(250),
  ]);
  const known = new Map<string, number>();
  for (const s of (senders ?? []) as Record<string, unknown>[]) known.set(String(s.address), Number(s.received ?? 0));
  if (known.size < 5) return [];
  const sample = [
    "SENDERS (address, name, emails received):",
    ...((senders ?? []) as Record<string, unknown>[]).map((s) => `${s.address} | ${s.name ?? ""} | ${s.received}`),
    "",
    "RECENT SUBJECTS (sender: subject):",
    ...((mail ?? []) as Record<string, unknown>[]).map((e) => `${e.sender_email}: ${String(e.subject ?? "").slice(0, 90)}`),
  ].join("\n");
  const taken = new Set((await userLabels(userId)).map((l) => l.display_name.toLowerCase()));
  const out: Suggestion[] = [];
  for (const l of await labelsFromMail(sample)) {
    const own = [...new Set(l.senders.filter((s) => known.has(s)))];
    if (!own.length || taken.has(l.name.toLowerCase())) continue;
    out.push({ name: l.name, description: l.description, senders: own, count: own.reduce((n, s) => n + (known.get(s) ?? 0), 0) });
  }
  await db.from("profiles").update({ label_suggestions: out }).eq("id", userId);
  return out;
}

// An email put in or taken out of a label by the user. In: the Gmail label
// is added and the email becomes an example. Out: the label is taken off in
// Gmail (by undoing the action that added it) and the example dropped.
export async function applyLabel(userId: string, emailId: string, slug: string, on: boolean): Promise<void> {
  const [{ data: email }, { data: proc }, labels, settings] = await Promise.all([
    db.from("emails").select("id, subject, sender_email").eq("id", emailId).eq("user_id", userId).maybeSingle(),
    db.from("email_processed").select("extra_labels").eq("email_id", emailId).maybeSingle(),
    userLabels(userId),
    engineSettings(userId),
  ]);
  const label = labels.find((l) => l.slug === slug);
  if (!email || !label) throw Object.assign(new Error("That email or label no longer exists"), { status: 404 });
  const extra = new Set((proc?.extra_labels as string[] | null) ?? []);
  if (on) extra.add(slug);
  else extra.delete(slug);
  await db.from("email_processed").update({ extra_labels: [...extra] }).eq("email_id", emailId);

  const sender = String(email.sender_email ?? "").toLowerCase();
  const subject = String(email.subject ?? "").slice(0, 120);
  const examples = label.examples.filter((x) => !(x.sender === sender && (x.subject ?? "") === subject));
  if (on && sender) examples.unshift({ sender, subject });
  await db.from("categories").update({ examples: examples.slice(0, MAX_EXAMPLES) }).eq("user_id", userId).eq("slug", slug);

  const name = gmailLabelOf(label);
  if (on) {
    const r = await act(userId, { kind: "label", emailId, summary: `Label "${label.display_name}"`, detail: { label: name } }, { ...settings, source: "user" });
    if (r === "failed") throw new Error("Gmail did not take the label. Try again.");
  } else {
    const { data: rows } = await db.from("action_log").select("id, detail").eq("user_id", userId).eq("email_id", emailId).eq("kind", "label").eq("status", "done");
    for (const r of (rows ?? []) as Record<string, unknown>[]) if ((r.detail as { label?: string } | null)?.label === name) await undo(userId, String(r.id));
  }
}
