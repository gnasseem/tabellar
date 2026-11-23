// Parses Gmail-style search operators out of the search box.
//
// Anything that is not an operator is left alone and still goes to the
// existing full-text query, so a plain search behaves exactly as before.

export type ParsedSearch = {
  /** Free text with all operators stripped out. May be empty. */
  text: string;
  from?: string;
  to?: string;
  subject?: string;
  category?: string;
  /** ISO date (YYYY-MM-DD) lower bound, inclusive. */
  after?: string;
  /** ISO date (YYYY-MM-DD) upper bound, exclusive of the following day. */
  before?: string;
  isUnread?: boolean;
  isRead?: boolean;
  isStarred?: boolean;
  isResolved?: boolean;
  isUnresolved?: boolean;
  hasAttachment?: boolean;
  /** What Tabellar made of it: is:need, is:going, is:handled, is:filed. */
  state?: "need" | "going" | "handled" | "filed";
};

export const SEARCH_OPERATORS = [
  { syntax: "from:name", description: "Sender name or address contains" },
  { syntax: "to:name", description: "Recipient contains" },
  { syntax: "subject:word", description: "Subject contains" },
  { syntax: "category:important", description: "AI category" },
  { syntax: "after:2026-08-01", description: "Received on or after" },
  { syntax: "before:2026-08-15", description: "Received before" },
  { syntax: "is:unread", description: "Also read, starred, resolved, unresolved" },
  { syntax: "is:going", description: "Also need, handled, filed" },
  { syntax: "has:attachment", description: "Has at least one attachment" },
];

// Matches key:value, allowing "quoted values with spaces".
const OPERATOR_RE = /(\w+):("([^"]*)"|[^\s]+)/g;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Relative forms are far more natural to type than a date, and cheap to accept.
function resolveDate(raw: string): string | undefined {
  const value = raw.toLowerCase();
  if (DATE_RE.test(value)) return value;

  const days: Record<string, number> = {
    today: 0,
    yesterday: 1,
    week: 7,
    month: 30,
    year: 365,
  };
  if (!(value in days)) return undefined;
  const d = new Date();
  d.setDate(d.getDate() - days[value]);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function parseSearch(raw: string): ParsedSearch {
  const result: ParsedSearch = { text: "" };
  if (!raw) return result;

  let consumedAny = false;
  const leftovers = raw.replace(OPERATOR_RE, (match, key, _q, quoted) => {
    const rawValue = quoted !== undefined ? quoted : match.slice(key.length + 1);
    const value = rawValue.trim();
    if (!value) return match;
    const k = String(key).toLowerCase();

    switch (k) {
      case "from":
        result.from = value;
        break;
      case "to":
        result.to = value;
        break;
      case "subject":
        result.subject = value;
        break;
      case "category":
      case "label":
        result.category = value.toLowerCase();
        break;
      case "after":
      case "newer": {
        const d = resolveDate(value);
        if (!d) return match;
        result.after = d;
        break;
      }
      case "before":
      case "older": {
        const d = resolveDate(value);
        if (!d) return match;
        result.before = d;
        break;
      }
      case "is":
        switch (value.toLowerCase()) {
          case "unread":
            result.isUnread = true;
            break;
          case "read":
            result.isRead = true;
            break;
          case "starred":
            result.isStarred = true;
            break;
          case "resolved":
            result.isResolved = true;
            break;
          case "unresolved":
            result.isUnresolved = true;
            break;
          case "need":
          case "going":
          case "handled":
          case "filed":
            result.state = value.toLowerCase() as ParsedSearch["state"];
            break;
          default:
            return match; // unknown value, treat as plain text
        }
        break;
      case "has":
        if (value.toLowerCase() !== "attachment") return match;
        result.hasAttachment = true;
        break;
      default:
        return match; // not an operator we know; leave it in the free text
    }
    consumedAny = true;
    return " ";
  });

  result.text = leftovers.replace(/\s+/g, " ").trim();
  void consumedAny;
  return result;
}

/** True when the query used at least one recognised operator. */
export function hasOperators(parsed: ParsedSearch): boolean {
  return Object.keys(parsed).some((k) => k !== "text" && parsed[k as keyof ParsedSearch] !== undefined);
}
