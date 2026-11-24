import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "@/components/Icon";
import { createClient } from "@/lib/db";
import { FILE_ICON, fileKind, fileSize, saveAttachment, type Att, type FileKind } from "@/lib/attachments";
import { addressesIn } from "@/lib/accounts";
import { api } from "@/lib/outcomes";
import { parseSearch } from "@/lib/searchQuery";
import { isTypingTarget } from "@/lib/shortcuts";
import { useApp } from "../AppShell";
import { ReaderById } from "../EmailDetail";
import FilePreview from "../FilePreview";
import { Empty, Menu, SkeletonRows, ViewBar, VirtualList, useSizes, shortWhen } from "../ui";

// Files: every attachment of the mail kept here, received and sent, newest
// first, one line each. A search also asks the mailboxes for older ones.

/* eslint-disable @typescript-eslint/no-explicit-any */
type File = { key: string; att: Att; kind: FileKind; gmailId: string; emailId: string | null; accountId: string; who: string; address: string; sent: boolean; subject: string; at: string };
type Head = { head: true; key: string; name: string };
type Item = Head | File;
type Kind = "all" | FileKind;

const KINDS: { id: Kind; label: string }[] = [
  { id: "all", label: "All" },
  { id: "pdf", label: "PDFs" },
  { id: "document", label: "Documents" },
  { id: "sheet", label: "Sheets" },
  { id: "slides", label: "Slides" },
  { id: "image", label: "Images" },
  { id: "other", label: "Other" },
];
const COLUMNS = "!grid grid-cols-[26px_minmax(0,1fr)_46px] md:grid-cols-[26px_minmax(0,5fr)_164px_minmax(0,4fr)_64px_46px]";
const MAX = 3000;

const nameOf = (s: string) => s.replace(/<.*>/, "").replace(/"/g, "").trim();
// Signatures' little pictures, invitations and mail formats are not files anyone looks for.
const noise = (a: Att) => /\.(ics|p7s|vcf|asc)$|^winmail\.dat$/i.test(a.filename) || (fileKind(a) === "image" && a.size < 15_000) || /^image\d{3}\./i.test(a.filename);

// One row per attachment of a message.
function filesOf(e: any, sent: boolean): File[] {
  const to = addressesIn(e.recipients || "");
  const who = sent ? `To ${nameOf(String(e.recipients || "").split(",")[0]) || to[0] || "nobody"}` : nameOf(e.sender || "") || e.sender_email || "Unknown";
  return ((e.attachments || []) as Att[])
    .filter((a) => !noise(a))
    .map((att) => ({ key: `${e.gmail_id}:${att.attachment_id}`, att, kind: fileKind(att), gmailId: e.gmail_id, emailId: e.id ?? null, accountId: e.account_id, who, address: sent ? to.join(" ") : e.sender_email || "", sent, subject: e.subject || "(no subject)", at: e.received_at }));
}

export default function FilesView() {
  const { user, search, setSearch, addToast, accounts, liveChanges } = useApp();
  const supabase = createClient();
  const [files, setFiles] = useState<File[] | null>(null);
  const [older, setOlder] = useState<File[]>([]);
  const [looking, setLooking] = useState(false);
  const [kind, setKind] = useState<Kind>("all");
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [preview, setPreview] = useState<File | null>(null);
  const [reading, setReading] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("emails")
      .select("id, gmail_id, account_id, subject, sender, sender_email, recipients, received_at, label_ids, attachments")
      .eq("user_id", user.id)
      .eq("has_attachments", true)
      .order("received_at", { ascending: false })
      .limit(MAX)
      .then(({ data }: { data: any[] | null }) => setFiles((data || []).flatMap((e) => filesOf(e, (e.label_ids || []).includes("SENT")))));
  }, [user.id, liveChanges.emails]);

  const q = useMemo(() => parseSearch(search), [search]);

  // Older files: the mailboxes themselves are asked, once typing pauses.
  useEffect(() => {
    setOlder([]);
    if (q.text.length < 3 && !q.from) return setLooking(false);
    let live = true;
    setLooking(true);
    const timer = setTimeout(() => {
      api(`/files/search?text=${encodeURIComponent(q.text)}&from=${encodeURIComponent(q.from ?? "")}`)
        .then((r: { files: any[] }) => live && setOlder(r.files.flatMap((e) => filesOf(e, e.sent))))
        .catch(() => {})
        .finally(() => live && setLooking(false));
    }, 600);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [q.text, q.from]);

  const matches = useCallback(
    (f: File, words: boolean) => {
      if (accounts.only && f.accountId !== accounts.only) return false;
      if (kind !== "all" && f.kind !== kind) return false;
      if (q.from && !`${f.who} ${f.address}`.toLowerCase().includes(q.from.toLowerCase())) return false;
      if (q.after && f.at < q.after) return false;
      if (q.before && f.at >= q.before) return false;
      if (q.subject && !f.subject.toLowerCase().includes(q.subject.toLowerCase())) return false;
      const hay = `${f.att.filename} ${f.who} ${f.address} ${f.subject}`.toLowerCase();
      return !words || !q.text || q.text.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
    },
    [accounts.only, kind, q],
  );

  const items = useMemo(() => {
    const out: Item[] = (files || []).filter((f) => matches(f, true));
    const here = new Set(out.map((f) => f.key));
    // The mailbox matched on its own terms (the text of the email too).
    const more = older.filter((f) => !here.has(f.key) && matches(f, false));
    if (more.length) out.push({ head: true, key: "head:older", name: "Elsewhere in your mailboxes" }, ...more);
    return out;
  }, [files, older, matches]);

  const rows = useMemo(() => items.filter((i): i is File => !("head" in i)), [items]);
  const cursor = rows.find((f) => f.key === cursorKey) || rows[0] || null;
  const { row, head } = useSizes();
  const heightOf = useCallback((i: Item) => ("head" in i ? head : row), [row, head]);

  const move = (delta: number) => {
    if (!rows.length) return;
    const at = cursor ? rows.indexOf(cursor) : -1;
    setCursorKey(rows[Math.min(rows.length - 1, Math.max(0, at + delta))].key);
  };
  const download = (f: File) => saveAttachment(f.att, f.gmailId, f.accountId).catch(() => addToast("error", "Download failed"));
  const openEmail = (f: File) => (f.emailId ? setReading(f.emailId) : addToast("info", "That email is not kept here. Search for it in your mailbox."));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (reading || preview || document.querySelector("[data-compose-modal]")) return;
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "j" || e.key === "ArrowDown") move(1);
      else if (k === "k" || e.key === "ArrowUp") move(-1);
      else if ((e.key === "Enter" || e.key === " ") && cursor && !(e.target as HTMLElement).closest?.("button, a")) setPreview(cursor);
      else if (k === "o" && cursor) openEmail(cursor);
      else if (k === "d" && cursor) download(cursor);
      else return;
      e.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  if (reading) return <ReaderById emailId={reading} onClose={() => setReading(null)} />;

  const render = (item: Item) => {
    if ("head" in item)
      return (
        <div key={item.key} className="day !static">
          <b>{item.name}</b>
        </div>
      );
    const f = item;
    return (
      <div key={f.key} role="option" aria-selected={cursor === f} className={`row group relative ${COLUMNS}`} onClick={() => setCursorKey(f.key)} onDoubleClick={() => setPreview(f)}>
        <span className="grid place-items-center">
          <Icon name={FILE_ICON[f.kind]} size={15} className="text-ink3" />
        </span>
        <span className="truncate pr-4 text-ink" title={f.att.filename}>
          {f.att.filename}
        </span>
        <button
          className="hidden min-w-0 truncate pr-3 text-left text-ink2 hover:text-ink hover:underline md:block"
          title={f.sent ? f.address : `Files from ${f.who}`}
          onClick={(e) => {
            e.stopPropagation();
            setCursorKey(f.key);
            if (!f.sent) setSearch(`from:${f.address}`);
          }}
        >
          {f.who}
        </button>
        <span className="hidden truncate pr-3 text-ink3 md:block">{f.subject}</span>
        <span className="hidden text-right text-xs text-ink3 md:block">{f.att.size > 0 ? fileSize(f.att.size) : ""}</span>
        <time className="text-right text-xs text-ink3">{shortWhen(f.at)}</time>
        <span className="absolute right-1.5 top-1/2 hidden -translate-y-1/2 gap-0.5 rounded-md bg-hover pl-1 group-hover:flex group-aria-selected:bg-sel">
          {f.emailId && (
            <button className="iconbtn h-6 w-6" title="Open the email (O)" aria-label="Open the email" onClick={(e) => (e.stopPropagation(), openEmail(f))}>
              <Icon name="mail" size={14} />
            </button>
          )}
          <button className="iconbtn h-6 w-6" title="Download (D)" aria-label="Download" onClick={(e) => (e.stopPropagation(), download(f))}>
            <Icon name="download" size={14} />
          </button>
        </span>
      </div>
    );
  };

  return (
    <>
      <ViewBar title="Files" search="Search files, people, subjects" right={<Menu label="Kind" value={kind} onChange={setKind} options={KINDS} />} />
      {files === null ? (
        <div className="pt-2.5">
          <SkeletonRows count={18} />
        </div>
      ) : !items.length ? (
        looking ? (
          <div className="pt-2.5">
            <SkeletonRows count={4} />
          </div>
        ) : search || kind !== "all" ? (
          <Empty icon="search" title="Nothing matches that search" />
        ) : (
          <Empty icon="attach_file" title="No files yet" />
        )
      ) : (
        <div className="flex min-h-0 flex-1 flex-col pt-1.5" role="listbox" aria-label="Files">
          <VirtualList items={items} heightOf={heightOf} render={render} cursor={cursor ? items.indexOf(cursor) : -1} />
        </div>
      )}
      {preview && <FilePreview att={preview.att} gmailId={preview.gmailId} accountId={preview.accountId} onClose={() => setPreview(null)} />}
    </>
  );
}
