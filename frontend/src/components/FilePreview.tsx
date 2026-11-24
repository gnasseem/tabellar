// A file, looked at in place: an image, a PDF or text. Escape or a click
// beside it closes it.
import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { fetchAttachment, fileSize, saveAttachment, type Att, type CachedAttachment } from "@/lib/attachments";
import { useApp } from "./AppShell";

export default function FilePreview({ att, gmailId, accountId, onClose }: { att: Att; gmailId: string; accountId?: string; onClose: () => void }) {
  const { addToast } = useApp();
  const [entry, setEntry] = useState<CachedAttachment | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    setEntry(null);
    setError(false);
    fetchAttachment(att, gmailId, accountId)
      .then((e) => live && setEntry(e))
      .catch(() => live && setError(true));
    return () => {
      live = false;
    };
  }, [att, gmailId, accountId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      onClose();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  });
  const download = () => saveAttachment(att, gmailId, accountId).catch(() => addToast("error", "Download failed"));
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={att.filename}
        className="flex flex-col overflow-hidden rounded-[12px] bg-raised shadow-pop"
        style={{ width: "min(92vw, 56.25rem)", height: "min(90vh, 43.75rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-11 flex-none items-center gap-2 border-b border-line-soft pl-4 pr-1.5">
          <p className="min-w-0 flex-1 truncate font-semibold text-ink">{att.filename}</p>
          {att.size > 0 && <span className="flex-none text-xs text-ink3">{fileSize(att.size)}</span>}
          <button className="btn ml-1" onClick={download}>
            Download
          </button>
          <button className="iconbtn" onClick={onClose} title="Close" aria-label="Close">
            <Icon name="close" size={16} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-side">
          {error ? (
            <p className="text-danger">Could not load this attachment from the mailbox.</p>
          ) : !entry ? (
            <div className="skel h-[70%] w-[70%] rounded-[9px]" aria-busy="true" aria-label="Loading" />
          ) : att.mime_type?.startsWith("image/") ? (
            <img src={entry.blobUrl} alt={att.filename} className="max-h-full max-w-full object-contain p-4" />
          ) : att.mime_type?.includes("pdf") ? (
            <iframe src={entry.blobUrl} title={att.filename} className="h-full w-full border-0" />
          ) : entry.text !== null ? (
            <pre className="h-full w-full overflow-auto whitespace-pre-wrap break-all p-4 font-mono text-xs leading-relaxed text-ink">{entry.text}</pre>
          ) : (
            <div className="empty">
              <Icon name="description" size={22} className="text-ink3" />
              <h3>No preview</h3>
              <button className="link mt-1.5" onClick={download}>
                Download it
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
