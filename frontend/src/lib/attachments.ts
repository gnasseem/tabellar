// Attachments fetched in this window, kept across emails. Bounded: an object
// URL keeps its Blob alive until revoked.
import { createClient } from "@/lib/db";

export type Att = { filename: string; mime_type: string; size: number; attachment_id: string };
export type CachedAttachment = { blobUrl: string; blob: Blob; text: string | null };

const CACHE_MAX_BYTES = 64 * 1024 * 1024;
const CACHE_MAX_ENTRIES = 24;
const cache = new Map<string, CachedAttachment>();
let cacheBytes = 0;

function evict(key: string) {
  const entry = cache.get(key);
  if (!entry) return;
  URL.revokeObjectURL(entry.blobUrl);
  cacheBytes -= entry.blob.size;
  cache.delete(key);
}

function remember(key: string, entry: CachedAttachment) {
  evict(key);
  cache.set(key, entry);
  cacheBytes += entry.blob.size;
  while (cache.size > 1 && (cacheBytes > CACHE_MAX_BYTES || cache.size > CACHE_MAX_ENTRIES)) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    evict(oldest);
  }
}

// Reading an entry moves it to the back, so eviction is least recently used.
function recall(key: string): CachedAttachment | undefined {
  const entry = cache.get(key);
  if (entry) {
    cache.delete(key);
    cache.set(key, entry);
  }
  return entry;
}

// `accountId` names the mailbox of mail that is not kept in Tabellar.
export async function fetchAttachment(att: Att, gmailId: string, accountId?: string): Promise<CachedAttachment> {
  const key = `${gmailId}::${att.attachment_id}`;
  const cached = recall(key);
  if (cached) return cached;
  const { data } = await createClient().auth.getSession();
  const res = await fetch(`/api/attachment?gmail_id=${encodeURIComponent(gmailId)}&attachment_id=${encodeURIComponent(att.attachment_id)}${accountId ? `&account_id=${encodeURIComponent(accountId)}` : ""}`, {
    headers: { Authorization: `Bearer ${data.session?.access_token}` },
  });
  if (!res.ok) throw new Error("Could not fetch the attachment");
  const binary = atob(((await res.json()).data as string).replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: att.mime_type || "application/octet-stream" });
  const text = att.mime_type?.startsWith("text/") || att.mime_type === "application/json" ? await blob.text() : null;
  const entry = { blobUrl: URL.createObjectURL(blob), blob, text };
  remember(key, entry);
  return entry;
}

export async function saveAttachment(att: Att, gmailId: string, accountId?: string): Promise<void> {
  const a = document.createElement("a");
  a.href = (await fetchAttachment(att, gmailId, accountId)).blobUrl;
  a.download = att.filename;
  a.click();
}

export const fileSize = (n: number) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`);

// What kind of file it is, from its type and its name.
export type FileKind = "pdf" | "document" | "sheet" | "slides" | "image" | "other";
export function fileKind(att: { filename: string; mime_type?: string }): FileKind {
  const ext = att.filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  const mime = (att.mime_type ?? "").toLowerCase();
  if (ext === "pdf" || mime.includes("pdf")) return "pdf";
  if (/^(xlsx?|csv|numbers|ods|tsv)$/.test(ext) || /spreadsheet|excel|csv/.test(mime)) return "sheet";
  if (/^(pptx?|key|odp)$/.test(ext) || /presentation|powerpoint/.test(mime)) return "slides";
  if (/^(docx?|pages|odt|rtf|txt|md)$/.test(ext) || /wordprocessing|msword|opendocument\.text|rtf/.test(mime) || mime === "text/plain") return "document";
  if (/^(png|jpe?g|gif|heic|webp|svg|tiff?|bmp)$/.test(ext) || mime.startsWith("image/")) return "image";
  return "other";
}
export const FILE_ICON: Record<FileKind, string> = { pdf: "picture_as_pdf", document: "description", sheet: "sheet", slides: "slides", image: "image", other: "draft" };
