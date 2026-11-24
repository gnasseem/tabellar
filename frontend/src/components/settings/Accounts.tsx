import { useEffect, useState } from "react";
import Icon from "@/components/Icon";
import { api } from "@/lib/outcomes";
import { useApp } from "../AppShell";
import AddMailbox from "../AddMailbox";
import { useSetupState } from "../ModelSetup";
import { Menu } from "../ui";
import { Group, loadingLines, Row, Switch } from "./parts";

// Where Settings opens after Google or Microsoft sends the window back from
// adding an account.
export const RETURN_TAB = "tabellar_settings_tab";

function returnHere() {
  try {
    sessionStorage.setItem(RETURN_TAB, "accounts");
  } catch {
    // the window then opens on General
  }
}

function signInAgain(provider: string) {
  returnHere();
  window.location.assign(provider === "microsoft" ? "/oauth/start?provider=microsoft" : "/oauth/start");
}

// Settings > Accounts: each mailbox, its default From, whether it is read,
// which one is the default, and adding or removing one.
export default function Accounts() {
  const { accounts, addToast, mail } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const setup = useSetupState();
  const nameOf = (choice: string) => setup.state?.mailboxes.find((c) => c.id === choice)?.name ?? "";
  const several = accounts.list.length > 1;

  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent) => !(e.target as HTMLElement).closest("[data-account-menu]") && setMenu(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [menu]);

  const change = async (id: string, patch: { paused?: boolean; is_default?: boolean; default_from?: string }) => {
    setBusy(id);
    try {
      await api("/accounts/update", { id, ...patch });
      await accounts.reload();
    } catch (e) {
      addToast("error", `Could not save that. ${(e as Error).message}`);
    }
    setBusy(null);
  };

  const remove = async (id: string, address: string) => {
    setMenu(null);
    const last = accounts.list.length === 1;
    if (!window.confirm(`Remove ${address} from Tabellar?\n\nIts mail leaves Tabellar; the mailbox itself is not changed.${last ? " It is the only account, so this window signs out." : ""}`)) return;
    setBusy(id);
    try {
      await api("/accounts/remove", { id });
      if (last) window.location.href = "/";
      else await accounts.reload();
    } catch (e) {
      addToast("error", `Could not remove the account. ${(e as Error).message}`);
    }
    setBusy(null);
  };

  const again = (provider: string) => (provider === "imap" ? setAdding(true) : signInAgain(provider));

  return (
    <Group
      title="Accounts"
      right={
        <button className="btn btn-sm" aria-expanded={adding} onClick={() => setAdding(!adding)}>
          {adding ? "Cancel" : "Add an account"}
        </button>
      }
      note="A Gmail account also sends from the addresses in its Send mail as list."
    >
      {adding && (
        <div className="border-b border-line-soft pb-5 pt-1">
          {setup.state ? (
            <AddMailbox
              state={setup.state}
              refresh={setup.refresh}
              beforeSignIn={returnHere}
              onAdded={async () => {
                setAdding(false);
                await accounts.reload();
                addToast("success", "Account added. Its mail is being read.");
              }}
            />
          ) : (
            <p className="py-2 text-ink3">{setup.error || "Loading"}</p>
          )}
        </div>
      )}
      {!accounts.loaded ? (
        loadingLines
      ) : !accounts.list.length ? (
        <p className="py-3 text-ink3">No account connected</p>
      ) : (
        accounts.list.map((a) => (
          <Row
            key={a.id}
            name={
              <span className="flex min-w-0 items-center gap-2">
                {several && <span className="mark">{accounts.mark(a.id)}</span>}
                <span className="truncate">{a.address}</span>
                {several && a.is_default && <span className="flex-none text-xs text-ink3">Default</span>}
              </span>
            }
            text={[
              nameOf(a.choice),
              a.paused ? "Paused" : a.from.length > 1 ? `Also sends as ${a.from.filter((f) => f.address !== a.address.toLowerCase()).map((f) => f.address).join(", ")}` : "",
            ].filter(Boolean).join(". ") || undefined}
          >
            {a.from.length > 1 && (
              <Menu label="From" value={a.default_from} onChange={(v) => change(a.id, { default_from: v })} options={a.from.map((f) => ({ id: f.address, label: f.address }))} />
            )}
            {mail.engine?.signIn === a.address && (
              <button className="btn btn-sm" onClick={() => again(a.provider)}>
                {a.provider === "imap" ? "Change the app password" : "Sign in again"}
              </button>
            )}
            <Switch label={`Read mail from ${a.address}`} on={!a.paused} disabled={busy === a.id} onChange={(on) => change(a.id, { paused: !on })} />
            <div className="relative" data-account-menu>
              <button className="iconbtn" title="More" aria-label={`More for ${a.address}`} aria-haspopup="menu" aria-expanded={menu === a.id} onClick={() => setMenu(menu === a.id ? null : a.id)}>
                <Icon name="more" size={16} />
              </button>
              {menu === a.id && (
                <div className="pop absolute right-0 top-full z-10 mt-1 min-w-[160px]" role="menu">
                  {several && !a.is_default && (
                    <button role="menuitem" className="pop-item" onClick={() => (setMenu(null), change(a.id, { is_default: true }))}>
                      Make default
                    </button>
                  )}
                  <button role="menuitem" className="pop-item" onClick={() => (setMenu(null), again(a.provider))}>
                    {a.provider === "imap" ? "Change the app password" : "Sign in again"}
                  </button>
                  <button role="menuitem" className="pop-item text-danger" onClick={() => remove(a.id, a.address)}>
                    Remove
                  </button>
                </div>
              )}
            </div>
          </Row>
        ))
      )}
    </Group>
  );
}
