"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";

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

  // Check local part starts with or exactly matches a marketing prefix
  for (const prefix of MARKETING_LOCAL_PREFIXES) {
    if (local === prefix || local.startsWith(prefix)) return true;
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
        supabase.from("gmail_accounts").select("id").eq("user_id", userId).eq("is_active", true),
        supabase.from("scheduled_emails").select("to_addresses, cc_addresses, bcc_addresses").eq("user_id", userId).limit(200),
        supabase.from("meetings").select("attendees").eq("user_id", userId).limit(200),
        supabase.from("email_memory").select("sender_email, sender_name").eq("user_id", userId).order("interaction_count", { ascending: false }).limit(500),
        supabase.from("contacts").select("email, name, source").eq("user_id", userId).limit(5000),
      ]);

      const accountIds = (accountsRes.data ?? []).map((a: { id: string }) => a.id);
      if (accountIds.length > 0) setPrimaryAccountId(accountIds[0]);

      // Cached Google Contacts + directory (highest priority — good display names)
      for (const row of cachedRes.data ?? []) {
        if (row.email && !seen.has(row.email) && !isMarketingEmail(row.email)) {
          seen.set(row.email, { email: row.email, name: row.name ?? "", source: row.source });
        }
      }

      // email_memory: ranked contacts with frequency data — best display names
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

      // Senders from received emails — use `sender` field (RFC 2822) to extract name
      if (accountIds.length > 0) {
        const [emailsRes, recipientsRes] = await Promise.all([
          supabase.from("emails").select("sender_email, sender").in("gmail_account_id", accountIds).not("sender_email", "is", null).limit(1000),
          supabase.from("emails").select("recipients").in("gmail_account_id", accountIds).not("recipients", "is", null).limit(500),
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
    const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL + "/functions/v1/api";
    await fetch(`${apiUrl}/contacts/sync`, {
      method: "POST",
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
  } catch {
    syncTriggered = false;
  }
}

/** Autocomplete logic for a comma-separated email field */
function useEmailAutocomplete(contacts: Contact[], accountId: string, multi = true) {
  const [suggestions, setSuggestions] = useState<Contact[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const supabase = createClient();

  const getSuggestions = useCallback(
    (value: string) => {
      const lastToken = multi
        ? (value.split(",").pop()?.trim() ?? "")
        : value.trim();
      if (lastToken.length < 1) { setSuggestions([]); return; }
      const lower = lastToken.toLowerCase();
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
      if (lastToken.length >= 2 && accountId) {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
          try {
            const { data: { session } } = await supabase.auth.getSession();
            if (!session) return;
            const apiUrl = process.env.NEXT_PUBLIC_SUPABASE_URL + "/functions/v1/api";
            const res = await fetch(
              `${apiUrl}/contacts/search?q=${encodeURIComponent(lastToken)}&account_id=${encodeURIComponent(accountId)}`,
              { headers: { Authorization: `Bearer ${session.access_token}` } },
            );
            if (!res.ok) return;
            const { contacts: live } = await res.json() as { contacts: { name: string; email: string; source?: string }[] };
            if (!live?.length) return;
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
    [contacts, accountId, multi]
  );

  const applySuggestion = useCallback(
    (value: string, contact: Contact) => {
      // Insert only the email address — name is shown in the dropdown for identification only
      const formatted = contact.email;
      if (multi) {
        const parts = value.split(",");
        parts[parts.length - 1] = " " + formatted;
        setSuggestions([]);
        return parts.join(",").replace(/^ /, "");
      } else {
        setSuggestions([]);
        return formatted;
      }
    },
    [multi]
  );

  const clear = useCallback(() => setSuggestions([]), []);

  return { suggestions, activeIdx, setActiveIdx, getSuggestions, applySuggestion, clear };
}

/**
 * A controlled email input with autocomplete dropdown.
 * - `multi` (default true): comma-separated list of addresses
 * - `multi=false`: single address
 * - `label` is optional; omit for a plain input
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
  suffix?: React.ReactNode;
  placeholder?: string;
  multi?: boolean;
  inputClassName?: string;
}) {
  const { suggestions, activeIdx, setActiveIdx, getSuggestions, applySuggestion, clear } =
    useEmailAutocomplete(contacts, accountId, multi);
  const ref = useRef<HTMLInputElement>(null);
  const [dropdownStyle, setDropdownStyle] = useState<React.CSSProperties>({});
  // Detect theme from the nearest .dark ancestor so the portal inherits it
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(!!document.querySelector(".dark"));
  }, [suggestions.length]);

  // Recompute dropdown position whenever suggestions open/change
  useEffect(() => {
    if (!suggestions.length || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    setDropdownStyle({
      position: "fixed",
      top: rect.bottom + 4,
      left: rect.left,
      width: Math.max(320, rect.width),
      zIndex: 9999,
    });
  }, [suggestions.length]);

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!suggestions.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      onChange(applySuggestion(value, suggestions[activeIdx]));
    } else if (e.key === "Escape") { clear(); }
  };

  const dropdown = suggestions.length > 0 && typeof document !== "undefined"
    ? createPortal(
        // Wrap in the theme class so CSS variables resolve correctly outside the app root
        <div className={isDark ? "dark" : ""}>
          <div
            style={dropdownStyle}
            className="bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl overflow-hidden text-[var(--foreground)]"
          >
            {suggestions.map((c, i) => (
              <button
                key={c.email}
                type="button"
                onMouseDown={() => onChange(applySuggestion(value, c))}
                className={`w-full text-left px-3 py-2 text-sm flex items-center gap-2 hover:bg-[var(--surface-2)] ${i === activeIdx ? "bg-[var(--surface-2)]" : ""}`}
              >
                <span className="material-symbols-outlined text-[var(--muted)]" style={{ fontSize: "14px" }}>
                  {c.source === "directory" ? "domain" : "person"}
                </span>
                <span className="truncate flex-1">
                  {c.name && <span className="font-medium">{c.name} </span>}
                  <span className="text-[var(--muted)]">{c.email}</span>
                </span>
                {c.source === "directory" && (
                  <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 font-medium">
                    org
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )
    : null;

  return (
    <div className={`relative ${label ? "flex items-center gap-2" : ""} ${className ?? ""}`}>
      {label && (
        <span className="text-xs text-[var(--muted)] w-8 shrink-0">{label}</span>
      )}
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => { onChange(e.target.value); getSuggestions(e.target.value); }}
        onKeyDown={handleKey}
        onBlur={() => setTimeout(clear, 150)}
        placeholder={placeholder}
        className={
          inputClassName ??
          (label
            ? "flex-1 px-2 py-1.5 border-b border-[var(--border)] bg-transparent text-sm focus:outline-none focus:border-[var(--accent)]"
            : "w-full px-3 py-1.5 rounded-lg border border-[var(--border)] bg-transparent text-sm focus:outline-none")
        }
      />
      {suffix}
      {dropdown}
    </div>
  );
}
