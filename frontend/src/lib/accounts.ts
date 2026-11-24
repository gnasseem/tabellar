import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./outcomes";

// The connected mailboxes as the window sees them (GET /api/accounts): each
// with the addresses it sends from and its default From.

export type Account = {
  id: string;
  provider: string;
  address: string;
  is_default: boolean;
  paused: boolean;
  from: { address: string; name: string }[];
  default_from: string;
};

export type Accounts = {
  list: Account[];
  loaded: boolean;
  reload: () => Promise<void>;
  byId: Map<string, Account>;
  // Every address the user sends from, lower case: "is this me".
  mine: Set<string>;
  // A one-letter mark per account, shown on rows only when there are several.
  mark: (id: string | null | undefined) => string;
  // The account the sidebar switcher shows, or "" for all of them.
  only: string;
  setOnly: (id: string) => void;
};

const KEY = "tabellar_account";

// The letter that tells accounts apart: the domain's first letter (work and
// personal mail usually differ there), else the address's, else a number.
function marks(list: Account[]): Map<string, string> {
  const out = new Map<string, string>();
  const pick = [(a: Account) => a.address.split("@")[1]?.[0], (a: Account) => a.address[0]];
  for (const choose of pick) {
    const letters = list.map((a) => (choose(a) ?? "").toUpperCase());
    if (new Set(letters).size === letters.length) {
      list.forEach((a, i) => out.set(a.id, letters[i]));
      return out;
    }
  }
  list.forEach((a, i) => out.set(a.id, String(i + 1)));
  return out;
}

export function useAccounts(): Accounts {
  const [list, setList] = useState<Account[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [only, setOnlyRaw] = useState(() => {
    try {
      return localStorage.getItem(KEY) ?? "";
    } catch {
      return "";
    }
  });
  const reload = useCallback(async () => {
    try {
      const { accounts } = await api("/accounts");
      setList(accounts ?? []);
    } catch {
      // The window keeps what it had; the next reload tries again.
    }
    setLoaded(true);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const setOnly = useCallback((id: string) => {
    setOnlyRaw(id);
    try {
      localStorage.setItem(KEY, id);
    } catch {
      // a remembered choice is a convenience
    }
  }, []);
  return useMemo(() => {
    const byId = new Map(list.map((a) => [a.id, a]));
    const m = marks(list);
    return {
      list,
      loaded,
      reload,
      byId,
      mine: new Set(list.flatMap((a) => [a.address.toLowerCase(), ...a.from.map((f) => f.address.toLowerCase())])),
      mark: (id) => m.get(id ?? "") ?? "",
      // A switch to an account since removed falls back to all.
      only: list.length > 1 && byId.has(only) ? only : "",
      setOnly,
    };
  }, [list, loaded, reload, only, setOnly]);
}

const ADDRESS = /[^\s<>,;:"'()[\]]+@[^\s<>,;:"'()[\]]+\.[a-z]{2,}/gi;
export const addressesIn = (header: string | null | undefined): string[] => [...String(header ?? "").matchAll(ADDRESS)].map((m) => m[0].toLowerCase());

// A reply goes out from the address the email was sent to, when its account
// has it; otherwise from that account's default. Same rule as the server.
export function replyFrom(a: Account, email: { recipients?: string | null; cc_recipients?: string | null }): string {
  const to = addressesIn(`${email.recipients ?? ""}, ${email.cc_recipients ?? ""}`);
  return a.from.find((f) => to.includes(f.address))?.address ?? a.default_from;
}

