// Label colours. A label's colour only ever shows as a small dot beside its
// name, so the set is short and muted to sit with the neutral interface. This
// is the one file where colour values are written out.
const C = {
  brick: "#b4604e",
  ochre: "#b38a3e",
  moss: "#72894c",
  teal: "#3f8a86",
  blue: "#5b7fa6",
  plum: "#86699f",
  rose: "#ad6784",
  stone: "#8a857d",
};

export const LABEL_COLORS: { hex: string; name: string }[] = [
  { hex: C.brick, name: "Brick" },
  { hex: C.ochre, name: "Ochre" },
  { hex: C.moss, name: "Moss" },
  { hex: C.teal, name: "Teal" },
  { hex: C.blue, name: "Blue" },
  { hex: C.plum, name: "Plum" },
  { hex: C.rose, name: "Rose" },
  { hex: C.stone, name: "Stone" },
];

// The four labels every email is sorted into.
export const BUILT_IN_COLORS: Record<string, string> = {
  important: C.brick,
  "action-required": C.ochre,
  promotions: C.plum,
  updates: C.blue,
};

// Labels saved before the palette was reduced carry brighter colours; each is
// shown as its nearest muted one.
const OLDER: Record<string, string> = {
  "#ef4444": C.brick,
  "#f97316": C.ochre,
  "#eab308": C.ochre,
  "#22c55e": C.moss,
  "#10b981": C.moss,
  "#06b6d4": C.teal,
  "#14b8a6": C.teal,
  "#3b82f6": C.blue,
  "#6366f1": C.plum,
  "#8b5cf6": C.plum,
  "#a855f7": C.plum,
  "#ec4899": C.rose,
  "#6b7280": C.stone,
  "#64748b": C.stone,
  "#1e293b": C.stone,
};

export function labelColor(stored: string | null | undefined): string {
  const hex = (stored || "").toLowerCase();
  if (LABEL_COLORS.some((c) => c.hex === hex)) return hex;
  return OLDER[hex] ?? C.stone;
}

export type TagSuggestion = {
  id: string;
  name: string;
  slug: string;
  color: string;
  description: string;
  matchCount: number;
  examples: string[];
  source: "domain" | "keyword";
};

type EmailRow = { subject: string; sender_email: string };

type DomainTemplate = {
  slug: string;
  name: string;
  color: string;
  description: string;
};

type KeywordCluster = {
  slug: string;
  name: string;
  color: string;
  description: string;
  keywords: string[];
};

type DismissedStore = {
  userId: string;
  slugs: string[];
  updatedAt: string;
};

// Sender domain to label
// Keyed by sender domain. Multiple domains can share a slug (counts are merged).
const DOMAIN_TAG_MAP: Record<string, DomainTemplate> = {
  "github.com":      { slug: "github",     name: "GitHub",     color: C.plum, description: "Notifications and activity from GitHub repositories" },
  "gitlab.com":      { slug: "gitlab",     name: "GitLab",     color: C.ochre, description: "Notifications and activity from GitLab projects" },
  "linear.app":      { slug: "linear",     name: "Linear",     color: C.plum, description: "Issue updates and project activity from Linear" },
  "notion.so":       { slug: "notion",     name: "Notion",     color: C.stone, description: "Comments, mentions, and updates from Notion" },
  "slack.com":       { slug: "slack",      name: "Slack",      color: C.moss, description: "Notifications and digests from Slack" },
  "atlassian.com":   { slug: "jira",       name: "Jira",       color: C.blue, description: "Jira issue updates, assignments, and comments" },
  "jira.com":        { slug: "jira",       name: "Jira",       color: C.blue, description: "Jira issue updates, assignments, and comments" },
  "figma.com":       { slug: "figma",      name: "Figma",      color: C.rose, description: "Figma file comments, shares, and updates" },
  "asana.com":       { slug: "asana",      name: "Asana",      color: C.ochre, description: "Task assignments and project updates from Asana" },
  "trello.com":      { slug: "trello",     name: "Trello",     color: C.blue, description: "Trello card activity and board notifications" },
  "monday.com":      { slug: "monday",     name: "Monday",     color: C.brick, description: "Updates and assignments from Monday.com" },
  "zoom.us":         { slug: "zoom",       name: "Zoom",       color: C.blue, description: "Zoom meeting invites, recordings, and webinar links" },
  "loom.com":        { slug: "loom",       name: "Loom",       color: C.plum, description: "Loom video shares and comments" },
  "vercel.com":      { slug: "vercel",     name: "Vercel",     color: C.teal, description: "Vercel deployment status updates and alerts" },
  "sentry.io":       { slug: "sentry",     name: "Sentry",     color: C.brick, description: "Error alerts and performance issues from Sentry" },
  "pagerduty.com":   { slug: "pagerduty",  name: "PagerDuty",  color: C.brick, description: "Incident alerts and on-call notifications from PagerDuty" },
  "hubspot.com":     { slug: "hubspot",    name: "HubSpot",    color: C.ochre, description: "CRM activity, deal updates, and contact notifications from HubSpot" },
  "salesforce.com":  { slug: "salesforce", name: "Salesforce", color: C.blue, description: "Salesforce CRM notifications and pipeline updates" },
  "intercom.io":     { slug: "intercom",   name: "Intercom",   color: C.blue, description: "Customer conversation notifications from Intercom" },
  "stripe.com":      { slug: "stripe",     name: "Stripe",     color: C.plum, description: "Stripe payment notifications, disputes, and receipts" },
  "clickup.com":     { slug: "clickup",    name: "ClickUp",    color: C.rose, description: "Task updates and notifications from ClickUp" },
  "airtable.com":    { slug: "airtable",   name: "Airtable",   color: C.moss, description: "Record updates and base activity from Airtable" },
  "datadog.com":     { slug: "datadog",    name: "Datadog",    color: C.plum, description: "Monitoring alerts and reports from Datadog" },
};

// Keyword clusters
const KEYWORD_CLUSTERS: KeywordCluster[] = [
  {
    slug: "finance",
    name: "Finance & Bills",
    color: C.moss,
    description: "Invoices, bills, receipts, payment confirmations, and financial statements",
    keywords: ["invoice", "receipt", "payment", "billing", "bill", "statement", "transaction", "charge", "subscription", "renewal", "refund", "balance due", "overdue", "wire transfer", "bank statement"],
  },
  {
    slug: "travel",
    name: "Travel",
    color: C.teal,
    description: "Flight confirmations, hotel bookings, itineraries, and travel-related emails",
    keywords: ["flight", "booking confirmation", "itinerary", "hotel", "reservation", "check-in", "boarding pass", "airline", "your trip", "airbnb", "rental car", "e-ticket", "passport"],
  },
  {
    slug: "newsletters",
    name: "Newsletters",
    color: C.plum,
    description: "Email newsletters, digests, and subscription-based content updates",
    keywords: ["newsletter", "digest", "weekly roundup", "unsubscribe", "this week in", "edition", "issue #", "weekly update", "monthly update", "curated", "briefing", "what's new"],
  },
  {
    slug: "shopping",
    name: "Shopping",
    color: C.ochre,
    description: "Order confirmations, shipping updates, and e-commerce notifications",
    keywords: ["order confirmed", "your order", "has shipped", "out for delivery", "delivered", "tracking number", "shipment", "purchase confirmation", "return request", "package", "amazon"],
  },
  {
    slug: "health",
    name: "Health",
    color: C.brick,
    description: "Medical appointments, prescriptions, lab results, and health-related communications",
    keywords: ["appointment", "prescription", "lab result", "test result", "doctor", "clinic", "health", "medical", "insurance claim", "pharmacy", "patient portal", "your health"],
  },
  {
    slug: "security",
    name: "Security Alerts",
    color: C.brick,
    description: "Login alerts, password resets, two-factor authentication, and account security notices",
    keywords: ["security alert", "new sign-in", "new login", "password reset", "two-factor", "2fa", "verify your", "verification code", "unusual activity", "account access", "confirm your email"],
  },
  {
    slug: "jobs",
    name: "Jobs & Recruiting",
    color: C.ochre,
    description: "Job applications, recruiter outreach, and hiring-related emails",
    keywords: ["application received", "job opportunity", "we reviewed your", "interview", "hiring", "open position", "recruiter", "linkedin recruiter", "offer letter", "candidate", "apply now"],
  },
  {
    slug: "events",
    name: "Events",
    color: C.rose,
    description: "Event invitations, RSVPs, conference registrations, and webinar links",
    keywords: ["invitation", "rsvp", "conference", "webinar", "register now", "join us", "you're invited", "event registration", "meetup", "summit", "workshop", "virtual event"],
  },
  {
    slug: "social",
    name: "Social",
    color: C.plum,
    description: "Notifications from social networks such as LinkedIn, Twitter, and similar platforms",
    keywords: ["linkedin", "mentioned you", "commented on your", "liked your", "followed you", "connection request", "twitter", "instagram", "reacted to", "tagged you", "new follower"],
  },
  {
    slug: "legal",
    name: "Legal & Compliance",
    color: C.stone,
    description: "Contracts, NDAs, privacy policy updates, terms of service, and compliance notices",
    keywords: ["agreement", "contract", "terms of service", "privacy policy", "nda", "compliance", "legal notice", "policy update", "gdpr", "data protection", "terms and conditions"],
  },
];

const DOMAIN_THRESHOLD = 3;
const KEYWORD_THRESHOLD = 5;
const MAX_SUGGESTIONS = 8;
const EXAMPLES_LIMIT = 3;

export function analyzeEmailPatterns(
  emails: EmailRow[],
  existingTagSlugs: string[],
  dismissedSlugs: string[],
): TagSuggestion[] {
  // Domain pass
  // Accumulate by template slug (multiple domains can share a slug, e.g. jira.com + atlassian.com)
  const domainAccum = new Map<string, { template: DomainTemplate; count: number; examples: string[] }>();

  for (const email of emails) {
    if (!email.sender_email) continue;
    const atIdx = email.sender_email.lastIndexOf("@");
    if (atIdx === -1) continue;
    const domain = email.sender_email.slice(atIdx + 1).toLowerCase().trim();
    const template = DOMAIN_TAG_MAP[domain];
    if (!template) continue;

    const existing = domainAccum.get(template.slug);
    if (existing) {
      existing.count += 1;
      if (existing.examples.length < EXAMPLES_LIMIT) existing.examples.push(email.sender_email);
    } else {
      domainAccum.set(template.slug, { template, count: 1, examples: [email.sender_email] });
    }
  }

  // Keyword pass
  const keywordAccum = new Map<string, { cluster: KeywordCluster; count: number; examples: string[] }>();

  for (const email of emails) {
    const subjectLower = (email.subject ?? "").toLowerCase();
    for (const cluster of KEYWORD_CLUSTERS) {
      if (!cluster.keywords.some((kw) => subjectLower.includes(kw))) continue;
      const existing = keywordAccum.get(cluster.slug);
      if (existing) {
        existing.count += 1;
        if (existing.examples.length < EXAMPLES_LIMIT) {
          const truncated = email.subject.length > 50 ? email.subject.slice(0, 47) + "..." : email.subject;
          existing.examples.push(truncated);
        }
      } else {
        const truncated = (email.subject ?? "").length > 50 ? email.subject.slice(0, 47) + "..." : email.subject;
        keywordAccum.set(cluster.slug, { cluster, count: 1, examples: [truncated] });
      }
    }
  }

  // Build candidates
  const blocked = new Set([...existingTagSlugs, ...dismissedSlugs]);
  const candidates: TagSuggestion[] = [];

  for (const [slug, { template, count, examples }] of domainAccum) {
    if (count < DOMAIN_THRESHOLD || blocked.has(slug)) continue;
    candidates.push({
      id: `suggestion-${slug}`,
      name: template.name,
      slug,
      color: template.color,
      description: template.description,
      matchCount: count,
      examples: [...new Set(examples)].slice(0, EXAMPLES_LIMIT),
      source: "domain",
    });
  }

  for (const [slug, { cluster, count, examples }] of keywordAccum) {
    if (count < KEYWORD_THRESHOLD || blocked.has(slug)) continue;
    candidates.push({
      id: `suggestion-${slug}`,
      name: cluster.name,
      slug,
      color: cluster.color,
      description: cluster.description,
      matchCount: count,
      examples: examples.slice(0, EXAMPLES_LIMIT),
      source: "keyword",
    });
  }

  candidates.sort((a, b) => b.matchCount - a.matchCount);
  return candidates.slice(0, MAX_SUGGESTIONS);
}

// localStorage helpers
const DISMISSED_PREFIX = "tabellar:dismissed-tag-suggestions:";

export function getDismissedSlugs(userId: string): string[] {
  try {
    const raw = localStorage.getItem(`${DISMISSED_PREFIX}${userId}`);
    if (!raw) return [];
    const parsed: DismissedStore = JSON.parse(raw);
    return parsed.slugs ?? [];
  } catch {
    return [];
  }
}

export function addDismissedSlug(userId: string, slug: string): void {
  try {
    const current = getDismissedSlugs(userId);
    if (current.includes(slug)) return;
    const store: DismissedStore = { userId, slugs: [...current, slug], updatedAt: new Date().toISOString() };
    localStorage.setItem(`${DISMISSED_PREFIX}${userId}`, JSON.stringify(store));
  } catch {
    // silently ignore (SSR or private browsing)
  }
}

export function removeDismissedSlug(userId: string, slug: string): void {
  try {
    const current = getDismissedSlugs(userId);
    const store: DismissedStore = { userId, slugs: current.filter((s) => s !== slug), updatedAt: new Date().toISOString() };
    localStorage.setItem(`${DISMISSED_PREFIX}${userId}`, JSON.stringify(store));
  } catch {
    // private browsing
  }
}
