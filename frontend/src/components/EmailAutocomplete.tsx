import { useState, useRef, useCallback, useEffect, useLayoutEffect, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import Icon from "@/components/Icon";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/db";

export interface Contact {
  email: string;
  name: string;
  source?: "directory" | "contact";
}

// Local-part prefixes that indicate automated/marketing senders
const MARKETING_LOCAL_PREFIXES = [
  "noreply", "no-reply", "donotreply", "do-not-reply", "do_not_reply",
  "notifications", "notification", "newsletter", "newsletters",
  "mailer-daemon", "mailer", "bounce", "bounces", "unsubscribe",
  "marketing", "automated", "alerts", "updates", "info-",
  "reply-", "bounce-", "return-",
];

// Domains that are bulk email platforms (never real people)
const MARKETING_DOMAINS = new Set([
  "mailchimp.com", "list-manage.com", "sendgrid.net", "sendgrid.com",
  "sparkpostmail.com", "mailgun.org", "mailgun.net",
  "constantcontact.com", "campaignmonitor.com", "cmail19.com", "cmail20.com",
  "klaviyo.com", "klaviyomail.com", "braze.com", "sailthru.com",
  "marketo.com", "exacttarget.com", "salesforce.com", "pardot.com",
  "customerio.com", "mailjet.com", "sendinblue.com", "brevo.com",
  "hubspot.com", "hs-marketing.com", "amazonses.com", "email.amazon.com",
  "iterable.com", "drip.com", "activecampaign.com", "getresponse.com",
  "icontact.com", "aweber.com", "postmarkapp.com", "mandrill.com",
]);

/** Returns true if the email is an automated/marketing address that shouldn't appear in suggestions. */
function isMarketingEmail(email: string): boolean {
  const lower = email.toLowerCase();
  const atIdx = lower.indexOf("@");
  if (atIdx < 0) return false;
  const local = lower.slice(0, atIdx);
  const domain = lower.slice(atIdx + 1);

  if (MARKETING_DOMAINS.has(domain)) return true;

  // Check if local part contains any marketing prefix (noreply can appear mid-string: payments-noreply@)
  for (const prefix of MARKETING_LOCAL_PREFIXES) {
    if (local.includes(prefix)) return true;
  }
  return false;
}

/** Parse a raw RFC 2822 address like `"Name" <email>` or `Name <email>` or bare `email` */
function parseAddress(raw: string): { email: string; name: string } | null {
  if (!raw) return null;
  const angleMatch = raw.match(/^(.*?)<([^>]+)>\s*$/);
  if (angleMatch) {
    const name = angleMatch[1].trim().replace(/^"|"$/g, "").trim();
    const email = angleMatch[2].trim().toLowerCase();
    if (!email.includes("@")) return null;
    return { email, name };
  }
  const bare = raw.trim().toLowerCase();
  if (bare.includes("@") && !bare.includes(" ")) return { email: bare, name: "" };
  return null;
}

/** Loads all known contacts from DB and triggers a background Google Contacts sync. */
export function useContacts(userId: string): {
  contacts: Contact[];
  addContacts: (newContacts: Contact[]) => void;
  primaryAccountId: string;
} {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [primaryAccountId, setPrimaryAccountId] = useState<string>("");
  const supabase = createClient();

  const addContacts = (newContacts: Contact[]) => {
    setContacts((prev) => {
      const seen = new Map(prev.map((c) => [c.email, c]));
      for (const c of newContacts) {
        if (!seen.has(c.email)) seen.set(c.email, c);
      }
      return Array.from(seen.values());
    });
  };

  useEffect(() => {
    if (!userId) return;
    (async () => {
      const seen = new Map<string, Contact>();

      // Run all independent queries in parallel, handling each failure individually
      const [
        accountsRes,
        sentRes,
        meetingRes,
        memoryRes,
        cachedRes,
      ] = await Promise.all([
        supabase.from("accounts").select("id").eq("user_id", userId),
        supabase.from("scheduled_emails").select("to_addresses, cc_addresses, bcc_addresses").eq("user_id", userId).limit(200),
        supabase.from("meetings").select("attendees").eq("user_id", userId).limit(200),
        supabase.from("email_memory").select("sender_email, sender_name").eq("user_id", userId).order("interaction_count", { ascending: false }).limit(500),
        supabase.from("contacts").select("email, name, source").eq("user_id", userId).limit(5000),
      ]);

      const accountIds = (accountsRes.data ?? []).map((a: { id: string }) => a.id);
      if (accountIds.length > 0) setPrimaryAccountId(accountIds[0]);

      // Cached Google Contacts + directory (highest priority  -  good display names)
      for (const row of cachedRes.data ?? []) {
        if (row.email && !seen.has(row.email) && !isMarketingEmail(row.email)) {
          seen.set(row.email, { email: row.email, name: row.name ?? "", source: row.source });
        }
      }

      // email_memory: ranked contacts with frequency data  -  best display names
      // sender_name is stored as RFC 2822 format e.g. "Name <email@x.com>", parse it
      for (const row of memoryRes.data ?? []) {
        const email = row.sender_email?.toLowerCase?.();
        if (!email || !email.includes("@") || isMarketingEmail(email)) continue;
        const parsedName = parseAddress(row.sender_name ?? "")?.name
          || row.sender_name?.split("<")[0]?.replace(/^"|"$/g, "").trim()
          || "";
        const existing = seen.get(email);
        seen.set(email, { email, name: parsedName || existing?.name || "", source: existing?.source });
      }

      // Senders from received emails  -  use `sender` field (RFC 2822) to extract name
      if (accountIds.length > 0) {
        const [emailsRes, recipientsRes] = await Promise.all([
          supabase.from("emails").select("sender_email, sender").in("account_id", accountIds).not("sender_email", "is", null).limit(1000),
          supabase.from("emails").select("recipients").in("account_id", accountIds).not("recipients", "is", null).limit(500),
        ]);

        for (const row of emailsRes.data ?? []) {
          const email = row.sender_email?.toLowerCase?.();
          if (!email || !email.includes("@") || isMarketingEmail(email)) continue;
          if (seen.has(email)) continue;
          const parsed = parseAddress(row.sender ?? row.sender_email);
          seen.set(email, { email, name: parsed?.name ?? "" });
        }

        for (const row of recipientsRes.data ?? []) {
          if (!row.recipients) continue;
          for (const part of row.recipients.split(",")) {
            const parsed = parseAddress(part.trim());
            if (parsed && !seen.has(parsed.email) && !isMarketingEmail(parsed.email)) {
              seen.set(parsed.email, { email: parsed.email, name: parsed.name });
            }
          }
        }
      }

      // Recipients from sent/scheduled emails
      for (const row of sentRes.data ?? []) {
        for (const raw of [...(row.to_addresses ?? []), ...(row.cc_addresses ?? []), ...(row.bcc_addresses ?? [])]) {
          const parsed = parseAddress(raw);
          if (parsed && !seen.has(parsed.email) && !isMarketingEmail(parsed.email)) {
            seen.set(parsed.email, { email: parsed.email, name: parsed.name });
          }
        }
      }

      // Meeting attendees
      for (const row of meetingRes.data ?? []) {
        for (const raw of row.attendees ?? []) {
          const parsed = parseAddress(raw);
          if (parsed && !seen.has(parsed.email) && !isMarketingEmail(parsed.email)) {
            seen.set(parsed.email, { email: parsed.email, name: parsed.name });
          }
        }
      }

      setContacts(Array.from(seen.values()));

      // Background sync of Google Contacts (fire-and-forget, runs once per session)
      triggerContactsSync();
    })();
  }, [userId]);

  return { contacts, addContacts, primaryAccountId };
}

let syncTriggered = false;

async function triggerContactsSync() {
  if (syncTriggered) return;
  syncTriggered = true;
  try {
    const supabase = createClient();
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;
    const apiUrl = "/api";
    await fetch(`${apiUrl}/contacts/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    syncTriggered = false;
  }
}

/** Suggestions for the address being typed: known contacts first, then a live People search. */
function useEmailAutocomplete(contacts: Contact[], accountId: string) {
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Counts lookups so a slow search cannot reopen the list after it was closed.
  const lookup = useRef(0);
  const supabase = createClient();

  const clear = useCallback(() => {
    lookup.current++;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSuggestions([]);
  }, []);

  const getSuggestions = useCallback(
    (typed: string) => {
      const query = typed.trim();
      if (query.length < 1) { clear(); return; }
      const mine = ++lookup.current;
      const lower = query.toLowerCase();
      const filtered = contacts
        .filter(
          (c) =>
            c.email.toLowerCase().includes(lower) ||
            (c.name && c.name.toLowerCase().includes(lower))
        )
        .slice(0, 6);

      setSuggestions(filtered);
      setActiveIdx(0);

      // Live Google People API search (debounced, 2+ chars)
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (query.length >= 2 && accountId) {
        debounceRef.current = setTimeout(async () => {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;
            const apiUrl = "/api";
            const res = await fetch(
              `${apiUrl}/contacts/search?q=${encodeURIComponent(query)}&account_id=${encodeURIComponent(accountId)}`,
              { headers: { Authorization: `Bearer ${session.access_token}` } },
            );
            if (!res.ok || mine !== lookup.current) return;
            const { contacts: live } = await res.json() as { contacts: { name: string; email: string; source?: string }[] };
            if (!live?.length || mine !== lookup.current) return;
            setSuggestions((prev) => {
              const seen = new Set(prev.map((c) => c.email));
              const merged = [...prev];
              for (const c of live as Contact[]) {
                if (!seen.has(c.email) && !isMarketingEmail(c.email)) {
                  seen.add(c.email);
                  merged.push(c);
                }
              }
              return merged.slice(0, 8);
            });
          } catch { /* ignore */ }
        }, 300);
      }
    },
    [contacts, accountId, clear]
  );

  return { suggestions, activeIdx, setActiveIdx, getSuggestions, clear };
}

const looksLikeAddress = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

/**
 * A controlled email input with autocomplete.
 * - `multi` (default true): `value` is a comma-separated list. Finished
 *   addresses show as tokens; the address being typed is the last entry.
 * - `multi=false`: single address
 * - `label` puts the field on a borderless row (the compose window); without
 *   it the field is a filled box like `.input`.
 */
export function EmailField({
  label,
  value,
  onChange,
  contacts,
  accountId = "",
  className,
  suffix,
  placeholder,
  multi = true,
  inputClassName,
}: {
  label?: string;
  value: string;
  onChange: (v: string) => void;
  contacts: Contact[];
  accountId?: string;
  className?: string;
  suffix?: ReactNode;
  placeholder?: string;
  multi?: boolean;
  inputClassName?: string;
}) {
  const { suggestions, activeIdx, setActiveIdx, getSuggestions, clear } =
    useEmailAutocomplete(contacts, accountId);
  const ref = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<CSSProperties>({});

  // The text being typed is kept here and also sent up as the last entry of
  // `value`, so the parent always holds everything in the field. When the two
  // stop matching (the parent set a new value), every entry is a token.
  const [draft, setDraft] = useState("");
  const parts = multi ? value.split(",").map((s) => s.trim()).filter(Boolean) : [];
  const typing = multi && draft.trim() !== "" && parts[parts.length - 1] === draft.trim();
  const tokens = typing ? parts.slice(0, -1) : parts;
  const text = multi ? (typing ? draft : "") : value;

  const emit = (list: string[], typed: string) =>
    onChange([...list, typed.trim()].filter(Boolean).join(", "));

  const type = (typed: string) => {
    if (!multi) {
      onChange(typed);
      getSuggestions(typed);
      return;
    }
    // A comma or semicolon, typed or pasted, finishes the addresses before it.
    const pieces = typed.split(/[,;]/);
    const rest = pieces.pop() ?? "";
    setDraft(rest);
    emit([...tokens, ...pieces.map((s) => s.trim()).filter(Boolean)], rest);
    getSuggestions(rest);
  };

  const pick = (c: Contact) => {
    clear();
    if (!multi) {
      onChange(c.email);
      return;
    }
    setDraft("");
    emit([...tokens, c.email], "");
  };

  const remove = (index: number) => {
    emit(tokens.filter((_, i) => i !== index), text);
    ref.current?.focus();
  };

  // Place the list under the field whenever it opens or changes.
  useLayoutEffect(() => {
    if (!suggestions.length || !boxRef.current) return;
    const rect = boxRef.current.getBoundingClientRect();
    const width = Math.max(320, Math.min(rect.width, 440));
    setDropdownStyle({
      position: "fixed",
      top: rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
      zIndex: 9999,
    });
  }, [suggestions.length, tokens.length]);

  const handleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (suggestions.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
      else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(suggestions[activeIdx]); }
      else if (e.key === "Escape") { e.stopPropagation(); clear(); }
      return;
    }
    if (!multi) return;
    if (e.key === "Enter" && text.trim()) {
      // Finish the address being typed: it becomes a token.
      e.preventDefault();
      setDraft("");
    } else if (e.key === "Backspace" && !text && tokens.length) {
      // Put the last token back in the input so it can be corrected.
      e.preventDefault();
      setDraft(tokens[tokens.length - 1]);
    }
  };

  const dropdown = suggestions.length > 0 && typeof document !== "undefined"
    ? createPortal(
        <div style={dropdownStyle} className="pop max-h-[236px] overflow-y-auto" role="listbox">
          {suggestions.map((c, i) => (
            <button
              key={c.email}
              type="button"
              role="option"
              aria-selected={i === activeIdx}
              data-active={i === activeIdx}
              // mousedown, and no default, so the input keeps focus for the next address
              onMouseDown={(e) => { e.preventDefault(); pick(c); }}
              onMouseEnter={() => setActiveIdx(i)}
              className="pop-item"
            >
              <span className="max-w-[50%] flex-none truncate">{c.name || c.email}</span>
              {c.name && <span className="min-w-0 truncate text-ink3">{c.email}</span>}
              {c.source === "directory" && <span className="ml-auto flex-none pl-2 text-xs text-ink3">Directory</span>}
            </button>
          ))}
        </div>,
        document.body
      )
    : null;

  const input = (
    <input
      ref={ref}
      type="text"
      value={text}
      onChange={(e) => type(e.target.value)}
      onKeyDown={handleKey}
      // Leaving the field finishes the address being typed. The delay lets a
      // click on a suggestion land first.
      onBlur={() => setTimeout(() => { clear(); setDraft(""); }, 150)}
      placeholder={tokens.length ? undefined : placeholder}
      spellCheck={false}
      autoComplete="off"
      className={inputClassName ?? "h-[22px] min-w-[120px] flex-1 bg-transparent text-[13px] text-ink outline-none"}
    />
  );

  const chips = tokens.map((t, i) => (
    <span
      key={`${t}:${i}`}
      title={looksLikeAddress(t) ? undefined : "This is not a complete email address"}
      className={`flex h-[22px] max-w-full items-center gap-0.5 rounded-md pl-1.5 pr-0.5 text-[13px] ${label ? "bg-field" : "bg-canvas"} ${looksLikeAddress(t) ? "text-ink" : "text-danger"}`}
    >
      <span className="truncate">{t}</span>
      <button
        type="button"
        aria-label={`Remove ${t}`}
        className="grid h-4 w-4 flex-none place-items-center rounded text-ink3 transition-colors duration-150 hover:bg-sel hover:text-ink"
        onClick={(e) => { e.stopPropagation(); remove(i); }}
      >
        <Icon name="close" size={11} />
      </button>
    </span>
  ));

  if (label) {
    return (
      <div ref={boxRef} className={`flex min-h-9 items-start gap-2 border-b border-line-soft py-[7px] ${className ?? ""}`} onClick={() => ref.current?.focus()}>
        <span className="w-12 flex-none text-xs leading-[22px] text-ink3">{label}</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {chips}
          {input}
        </div>
        {suffix}
        {dropdown}
      </div>
    );
  }

  return (
    <div
      ref={boxRef}
      className={`flex min-h-7 flex-wrap items-center gap-1 rounded-[7px] bg-field py-[3px] pl-2.5 pr-1.5 focus-within:shadow-[0_0_0_2px_color-mix(in_oklch,var(--wax)_55%,transparent)] ${className ?? ""}`}
      onClick={() => ref.current?.focus()}
    >
      {chips}
      {input}
      {suffix}
      {dropdown}
    </div>
  );
}
