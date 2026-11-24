import { useState, type ChangeEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { setupPost, type MailboxChoice, type SetupState } from "@/lib/setup";
import { Choice, ErrorLine, ui } from "./ModelSetup";

// Adding a mailbox, in onboarding and in Settings > Accounts. The choices
// come from the server's list (server/providers.ts), so a new provider shows
// up in both. Google and Outlook sign in on their own page; the rest take
// the address and an app password, checked against the servers before the
// account is kept.

const HINTS: Record<string, string> = {
  gmail: "Gmail, Google Workspace",
  microsoft: "Outlook.com, Microsoft 365",
  imap: "Any IMAP mailbox",
};

const hintOf = (c: MailboxChoice) => {
  const calendar = c.calendar ? "" : "no calendar";
  if (!HINTS[c.id]) return calendar ? "No calendar" : undefined;
  return calendar ? `${HINTS[c.id]}, ${calendar}` : HINTS[c.id];
};

export default function AddMailbox({ state, refresh, google, beforeSignIn, onAdded }: {
  state: SetupState;
  refresh: () => Promise<void>;
  // What the Google choice shows; a plain sign-in button by default.
  google?: ReactNode;
  // Runs before the window leaves for Google's or Microsoft's page.
  beforeSignIn?: () => void;
  onAdded: (first: boolean) => void;
}) {
  const [id, setId] = useState(state.mailboxes[0]?.id ?? "gmail");
  const choice = state.mailboxes.find((c) => c.id === id) ?? state.mailboxes[0];
  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Mailbox" className="-mx-2 grid sm:grid-cols-2">
        {state.mailboxes.map((c) => (
          <Choice key={c.id} on={c.id === id} onClick={() => setId(c.id)} title={c.name} hint={hintOf(c)} />
        ))}
      </div>
      {choice.provider === "gmail" ? (
        (google ?? <SignIn href="/oauth/start" label="Sign in with Google" before={beforeSignIn} />)
      ) : choice.provider === "microsoft" ? (
        <Outlook choice={choice} state={state} refresh={refresh} before={beforeSignIn} />
      ) : (
        <PasswordForm key={choice.id} choice={choice} onAdded={onAdded} />
      )}
    </div>
  );
}

function SignIn({ href, label, before }: { href: string; label: string; before?: () => void }) {
  const [going, setGoing] = useState(false);
  return (
    <a
      href={href}
      className={ui.btnPrimary}
      aria-busy={going}
      onClick={() => {
        before?.();
        setGoing(true);
      }}
    >
      {going ? "Opening the sign-in page" : label}
    </a>
  );
}

// Outlook needs the app registered in Microsoft's Azure portal; until its
// client ID is saved there is nothing to sign in with.
function Outlook({ choice, state, refresh, before }: { choice: MailboxChoice; state: SetupState; refresh: () => Promise<void>; before?: () => void }) {
  const [clientId, setClientId] = useState(state.microsoft.clientId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (choice.ready) return <SignIn href="/oauth/start?provider=microsoft" label="Sign in with Microsoft" before={before} />;
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await setupPost("/microsoft", { clientId });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  return (
    <form
      className="space-y-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <label htmlFor="ms-client" className="label block">
        Application (client) ID
      </label>
      <div className="flex gap-2">
        <input id="ms-client" className={`${ui.input} font-mono`} value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="00000000-0000-0000-0000-000000000000" spellCheck={false} autoComplete="off" />
        <button type="submit" className={`${ui.btnSecondary} flex-none`} disabled={busy || !clientId.trim()}>
          {busy ? "Saving" : "Save"}
        </button>
      </div>
      <p className="text-xs leading-normal text-ink2">From the app you registered in Microsoft's Azure portal. The README lists the steps.</p>
      <ErrorLine text={error} />
    </form>
  );
}

type Fields = { address: string; password: string; imapHost: string; imapPort: string; smtpHost: string; smtpPort: string; user: string };

function PasswordForm({ choice, onAdded }: { choice: MailboxChoice; onAdded: (first: boolean) => void }) {
  const other = !choice.imap;
  const [f, setF] = useState<Fields>({ address: "", password: "", imapHost: "", imapPort: "993", smtpHost: "", smtpPort: "465", user: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const set = (k: keyof Fields) => (e: ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const add = async () => {
    setBusy(true);
    setError("");
    try {
      const { first } = await setupPost<{ first: boolean }>("/mailbox", { choice: choice.id, ...f });
      onAdded(first);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  const field = (k: keyof Fields, label: string, props: InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block min-w-0">
      <span className="label mb-1 block">{label}</span>
      <input className={ui.input} value={f[k]} onChange={set(k)} spellCheck={false} autoComplete="off" disabled={busy} {...props} />
    </label>
  );
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        add();
      }}
    >
      {field("address", "Address", { type: "email", placeholder: "you@example.com", autoComplete: "email" })}
      <div>
        <div className="mb-1 flex items-baseline justify-between gap-3">
          <label htmlFor="app-password" className="label">
            {other ? "Password or app password" : "App password"}
          </label>
          {choice.passwordUrl && (
            <a href={choice.passwordUrl} target="_blank" rel="noreferrer" className="link">
              Make one at {choice.name}
            </a>
          )}
        </div>
        <input id="app-password" type="password" className={`${ui.input} font-mono`} value={f.password} onChange={set("password")} autoComplete="off" spellCheck={false} disabled={busy} />
      </div>
      {other && (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
            {field("imapHost", "IMAP server", { placeholder: "imap.example.com" })}
            {field("imapPort", "Port", { inputMode: "numeric" })}
            {field("smtpHost", "SMTP server", { placeholder: "smtp.example.com" })}
            {field("smtpPort", "Port", { inputMode: "numeric" })}
          </div>
          {field("user", "User name", { placeholder: "The address, if left empty" })}
        </>
      )}
      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5">
        <button type="submit" className={ui.btnPrimary} disabled={busy || !f.address.trim() || !f.password}>
          {busy ? "Checking" : `Add ${choice.id === "imap" ? "mailbox" : choice.name}`}
        </button>
        <span className="text-xs text-ink2">Kept in the macOS Keychain. Nothing is sent to check it.</span>
      </div>
      <ErrorLine text={error} />
    </form>
  );
}
