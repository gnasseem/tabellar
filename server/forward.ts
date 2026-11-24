// What goes out beyond the text the user typed: an email handed on with its
// attachments, and the Message-ID a reply answers. Shared by everything that
// sends or saves a draft (outbox.ts, drafts.ts, /send-email).

import { db } from "./db.ts";
import { mail, type AttachmentInfo, type Outgoing } from "./providers.ts";
import { accountById, type Account } from "./accounts.ts";
import { escapeHtml } from "./mime.ts";

// The email handed on, and the attachments left out of it.
export type Forward = { email_id: string; without?: string[] };

// Mail servers refuse about 25 MB once encoded.
const MAX_BYTES = 18 * 1024 * 1024;

// The user's text followed by the email it hands on, with that email's
// attachments fetched from the mailbox it is in.
export async function withForward(userId: string, m: Outgoing, f: Forward | null | undefined): Promise<Outgoing> {
  if (!f?.email_id) return m;
  const { data: e } = await db.from("emails").select("gmail_id, account_id, subject, sender, recipients, cc_recipients, received_at, body_html, body_text, attachments").eq("id", f.email_id).eq("user_id", userId).maybeSingle();
  if (!e) throw new Error("The email to forward is no longer in Tabellar");
  const head = [["From", e.sender], ["Date", new Date(String(e.received_at)).toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" })], ["Subject", e.subject], ["To", e.recipients], ["Cc", e.cc_recipients]]
    .filter(([, v]) => v)
    .map(([k, v]) => `${k}: ${escapeHtml(String(v))}`)
    .join("<br>");
  const body = String(e.body_html || "") || escapeHtml(String(e.body_text ?? "")).replace(/\n/g, "<br>");
  const html = `${m.html}<br><br><div>---------- Forwarded message ----------<br>${head}</div><br>${body}`;

  const keep = ((e.attachments ?? []) as AttachmentInfo[]).filter((a) => !f.without?.includes(a.attachment_id));
  if (keep.reduce((n, a) => n + a.size, 0) > MAX_BYTES) throw new Error("The attachments are too large to forward");
  const account = keep.length ? await accountById(userId, e.account_id as string) : null;
  const attachments = [...(m.attachments ?? [])];
  for (const a of keep) {
    const got = account ? await mail(account).attachment(account, String(e.gmail_id), a.attachment_id) : null;
    if (!got) throw new Error(`"${a.filename}" could not be read from the mailbox`);
    attachments.push({ name: a.filename, contentType: a.mime_type, data: Buffer.from(got.data, "base64url").toString("base64") });
  }
  return { ...m, html, attachments: attachments.length ? attachments : undefined };
}

// The Message-ID a reply answers. The window names the message by its id in
// the mailbox, which other mail programs do not know.
export async function messageIdOf(account: Account, ref: string | null | undefined): Promise<string | undefined> {
  if (!ref || ref.includes("@")) return ref ?? undefined;
  try {
    return (await mail(account).headers(account, ref, ["Message-ID"]))["message-id"] || undefined;
  } catch {
    return undefined; // the thread id still puts it in the thread
  }
}
