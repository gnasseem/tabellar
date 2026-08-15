// Phishing heuristics computed from the message we already have in hand.
//
// Deliberately not an AI call: these checks are deterministic, run instantly on
// data already loaded, and are explainable, which matters because the output is
// a security warning. Gmail's own SPF/DKIM verdicts are not stored, so this
// leans on signals visible in the message itself.
//
// Tuned to under-report. A warning on honest mail teaches people to dismiss the
// banner, which is worse than staying quiet, so each signal has to be something
// legitimate senders rarely do.

export type SuspicionSignal = {
  id: string;
  label: string;
  detail: string;
};

export type SuspicionVerdict = {
  level: "none" | "caution" | "danger";
  signals: SuspicionSignal[];
};

// Brands impersonated often enough to be worth a name check. A display name
// claiming one of these while sending from an unrelated domain is the single
// most common phishing pattern.
const IMPERSONATED_BRANDS = [
  "paypal", "apple", "microsoft", "google", "amazon", "netflix", "meta",
  "facebook", "instagram", "linkedin", "dropbox", "docusign", "adobe",
  "chase", "wells fargo", "bank of america", "citibank", "hsbc", "barclays",
  "coinbase", "binance", "irs", "usps", "fedex", "dhl", "ups",
];

// Domains those brands actually send from. Matched as a suffix so regional and
// subdomain variants (paypal.co.uk, email.apple.com) pass.
const BRAND_DOMAINS: Record<string, string[]> = {
  paypal: ["paypal.com", "paypal.co.uk"],
  apple: ["apple.com", "icloud.com"],
  microsoft: ["microsoft.com", "office.com", "outlook.com", "live.com", "azure.com"],
  google: ["google.com", "gmail.com", "youtube.com", "googlemail.com"],
  amazon: ["amazon.com", "amazon.co.uk", "amazonses.com"],
  netflix: ["netflix.com"],
  meta: ["meta.com", "facebook.com", "facebookmail.com"],
  facebook: ["facebook.com", "facebookmail.com"],
  instagram: ["instagram.com", "mail.instagram.com"],
  linkedin: ["linkedin.com"],
  dropbox: ["dropbox.com", "dropboxmail.com"],
  docusign: ["docusign.com", "docusign.net"],
  adobe: ["adobe.com"],
  chase: ["chase.com"],
  coinbase: ["coinbase.com"],
  binance: ["binance.com"],
  irs: ["irs.gov"],
  usps: ["usps.com", "usps.gov"],
  fedex: ["fedex.com"],
  dhl: ["dhl.com", "dhl.de"],
  ups: ["ups.com"],
};

const CREDENTIAL_PHRASES = [
  "verify your account", "verify your identity", "confirm your password",
  "update your payment", "update your billing", "account has been suspended",
  "account will be closed", "unusual sign-in", "unusual activity",
  "click here to verify", "validate your account", "reactivate your account",
  "your account will be terminated", "confirm your identity",
  "re-enter your password", "unlock your account",
];

function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  if (at === -1) return "";
  return address.slice(at + 1).trim().toLowerCase().replace(/[>,;\s]+$/, "");
}

// Compare on the registrable-ish domain so mail.paypal.com and paypal.com match
// but paypal.security-check.ru does not.
function endsWithDomain(host: string, base: string): boolean {
  return host === base || host.endsWith(`.${base}`);
}

function extractAnchors(html: string): { text: string; href: string }[] {
  if (typeof window === "undefined" || !html) return [];
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.querySelectorAll("a[href]")).map((a) => ({
      text: (a.textContent || "").trim(),
      href: a.getAttribute("href") || "",
    }));
  } catch {
    return [];
  }
}

export function assessSuspicion(email: {
  sender?: string | null;
  sender_email?: string | null;
  reply_to_email?: string | null;
  subject?: string | null;
  body_html?: string | null;
  body_text?: string | null;
  snippet?: string | null;
}): SuspicionVerdict {
  const signals: SuspicionSignal[] = [];

  const senderEmail = (email.sender_email || "").toLowerCase().trim();
  const senderDomain = domainOf(senderEmail);
  const displayName = (email.sender || "").toLowerCase();

  // 1. Display name claims a brand the sending domain does not belong to.
  if (senderDomain) {
    for (const brand of IMPERSONATED_BRANDS) {
      if (!displayName.includes(brand)) continue;
      const legit = BRAND_DOMAINS[brand];
      if (!legit) continue;
      if (!legit.some((d) => endsWithDomain(senderDomain, d))) {
        signals.push({
          id: "brand-mismatch",
          label: "Sender name does not match its domain",
          detail: `The name says "${email.sender}" but the message was sent from ${senderDomain}.`,
        });
      }
      break;
    }
  }

  // 2. Display name contains an email address different from the real sender,
  // the "Support <support@bank.com>" trick where the visible part is fake.
  const nameAddr = displayName.match(/[\w.+-]+@[\w.-]+\.\w+/);
  if (nameAddr && senderEmail && nameAddr[0] !== senderEmail) {
    const claimed = domainOf(nameAddr[0]);
    if (claimed && senderDomain && claimed !== senderDomain) {
      signals.push({
        id: "name-address-mismatch",
        label: "Display name shows a different address",
        detail: `It displays ${nameAddr[0]} but was actually sent from ${senderEmail}.`,
      });
    }
  }

  // 3. Reply-To points at another domain, which routes your answer elsewhere.
  const replyTo = (email.reply_to_email || "").toLowerCase().trim();
  const replyDomain = domainOf(replyTo);
  if (replyDomain && senderDomain && replyDomain !== senderDomain) {
    // Mailing lists and ticketing systems do this legitimately all the time,
    // so it only counts as corroboration, never on its own.
    signals.push({
      id: "reply-to-mismatch",
      label: "Replies would go to a different domain",
      detail: `Sent from ${senderDomain}, but replies are addressed to ${replyDomain}.`,
    });
  }

  const anchors = extractAnchors(email.body_html || "");

  // 4. Link text presents itself as one destination, href goes to another.
  for (const a of anchors) {
    const textLooksLikeUrl = /^(https?:\/\/|www\.)[\w.-]+\.\w{2,}/i.test(a.text);
    if (!textLooksLikeUrl) continue;
    const shownHost = domainOfUrlLike(a.text);
    const realHost = domainOfUrlLike(a.href);
    if (shownHost && realHost && !hostsAgree(shownHost, realHost)) {
      signals.push({
        id: "link-mismatch",
        label: "A link points somewhere other than it claims",
        detail: `The link reads ${shownHost} but leads to ${realHost}.`,
      });
      break;
    }
  }

  // 5. Punycode host: the classic homograph trick (аpple.com with a Cyrillic a).
  const punycode = anchors.find((a) => /:\/\/[^/]*xn--/i.test(a.href));
  if (punycode) {
    signals.push({
      id: "punycode",
      label: "A link uses a disguised domain",
      detail:
        "It contains a punycode host, which can render as letters from another alphabet to imitate a familiar name.",
    });
  }

  // 6. Bare IP address in a link, essentially never legitimate in real mail.
  const ipLink = anchors.find((a) =>
    /^https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?(\/|$)/i.test(a.href),
  );
  if (ipLink) {
    signals.push({
      id: "ip-link",
      label: "A link points at a raw IP address",
      detail: "Legitimate senders use a domain name rather than a bare IP.",
    });
  }

  // 7. Credential-harvest language. Only meaningful alongside a link to click.
  const haystack = `${email.subject || ""} ${email.body_text || email.snippet || ""}`
    .toLowerCase()
    .replace(/\s+/g, " ");
  const phrase = CREDENTIAL_PHRASES.find((p) => haystack.includes(p));
  if (phrase && anchors.length > 0) {
    signals.push({
      id: "credential-language",
      label: "Asks you to confirm account details",
      detail: `The message says "${phrase}" and links somewhere to act on it.`,
    });
  }

  // Weighting: some signals are damning alone, others only corroborate.
  const strong = new Set(["brand-mismatch", "name-address-mismatch", "link-mismatch", "punycode", "ip-link"]);
  const hasStrong = signals.some((s) => strong.has(s.id));

  let level: SuspicionVerdict["level"] = "none";
  if (hasStrong && signals.length > 1) level = "danger";
  else if (hasStrong) level = "caution";
  else if (signals.length > 1) level = "caution";

  // A lone reply-to mismatch is far too common in normal mail to report.
  if (
    level === "caution" &&
    signals.length === 1 &&
    signals[0].id === "reply-to-mismatch"
  ) {
    return { level: "none", signals: [] };
  }

  return { level, signals };
}

function domainOfUrlLike(value: string): string {
  try {
    const withScheme = /^https?:\/\//i.test(value) ? value : `http://${value}`;
    return new URL(withScheme).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Same registrable domain counts as agreement, so a link reading example.com
// that resolves to links.example.com is not flagged.
function hostsAgree(shown: string, real: string): boolean {
  if (shown === real) return true;
  const tail = (h: string) => h.split(".").slice(-2).join(".");
  return tail(shown) === tail(real);
}
