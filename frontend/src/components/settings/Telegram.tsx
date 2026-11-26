// Settings, Notifications: Telegram. The user's own bot: made with BotFather,
// its token pasted here, then paired with the one chat that sends the code.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/outcomes";
import { ErrorLine } from "../ModelSetup";
import { Group, loadingLines, Row } from "./parts";

type State = { bot: string | null; oneTap?: boolean; making?: boolean; reaching?: boolean; who?: string | null; paired?: boolean; code?: string | null; link?: string; error?: string | null };

const POLL_MS = 2000;

// Every username is taken once, so one is made up that will be free.
const freeName = () => `tabellar_${Math.random().toString(36).slice(2, 8)}_bot`;

export function Telegram() {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [name] = useState(freeName);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    (api("/telegram") as Promise<State>).then(setState).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  // Until the bot is made, and until the code is sent from the phone or has run out.
  const waiting = !!state?.code || !!state?.making || !!state?.reaching;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [waiting, load]);

  const run = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError("");
    try {
      setState((await api(`/telegram/${path}`, body)) as State);
      setOpen(false);
      setToken("");
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };
  // The tab is opened before the link is known, or the browser blocks it.
  const make = async () => {
    const tab = window.open("about:blank", "_blank");
    setError("");
    try {
      const { link } = (await api("/telegram/make", {})) as { link: string };
      if (tab) tab.location.href = link;
      else window.location.href = link;
      load();
    } catch (e) {
      tab?.close();
      setError((e as Error).message);
    }
  };
  const disconnect = () => {
    if (state?.paired && !window.confirm(`Disconnect @${state.bot}?\n\nNothing more goes to Telegram. The bot itself stays until you delete it in BotFather.`)) return;
    void run("disconnect");
  };

  return (
    <Group title="Telegram" note="Telegram can read what a bot sends you: who wrote, the summary, short answers, and a longer draft when you press Read. Attachments are never sent.">
      {!state ? (
        error ? <ErrorLine text={error} /> : loadingLines
      ) : state.reaching ? (
        <Row name="Your bot is saved" text={state.error ? <span className="text-danger">{state.error}</span> : "Reaching Telegram"}>
          <button className="btn btn-plain btn-sm" disabled={busy} onClick={() => run("disconnect")}>
            Cancel
          </button>
        </Row>
      ) : !state.bot && state.making ? (
        <Row name="Waiting for Telegram" text="Press Create there. This goes on by itself.">
          <button className="btn btn-plain btn-sm" onClick={make}>
            Open it again
          </button>
        </Row>
      ) : !state.bot && state.oneTap && !open ? (
        <Row name="On your phone" text={error ? <span className="text-danger">{error}</span> : "The Brief and what needs you, answered there, through a bot of your own"}>
          <button className="btn btn-sm" onClick={make}>
            Make the bot in Telegram
          </button>
          <button className="btn btn-plain btn-sm" onClick={() => setOpen(true)}>
            With BotFather
          </button>
        </Row>
      ) : !state.bot ? (
        <>
          <Row name="On your phone" text="The Brief and what needs you, answered there, through a bot of your own">
            <button className="btn btn-sm" aria-expanded={open} onClick={() => (setOpen(!open), setError(""))}>
              {open ? "Cancel" : "Set up"}
            </button>
          </Row>
          {open && (
            <form
              className="space-y-3 py-3"
              onSubmit={(e) => {
                e.preventDefault();
                void run("connect", { token });
              }}
            >
              <ol className="list-decimal space-y-1 pl-[18px] leading-snug text-ink2 marker:text-ink3">
                <li>
                  <a className="link" href="https://t.me/BotFather?text=%2Fnewbot" target="_blank" rel="noreferrer">
                    Open @BotFather
                  </a>{" "}
                  and send <span className="font-mono text-ink">/newbot</span>
                </li>
                <li>
                  Answer Tabellar for the name, and for the username{" "}
                  <button
                    type="button"
                    className="link font-mono"
                    onClick={() => {
                      void navigator.clipboard.writeText(name).then(() => setCopied(true));
                    }}
                  >
                    {name}
                  </button>{" "}
                  <span aria-live="polite">{copied ? "Copied" : "(press to copy)"}</span>
                </li>
                <li>Copy its whole answer and paste it here</li>
              </ol>
              <div className="flex flex-wrap gap-2">
                <input className="input min-w-[200px] flex-1 font-mono" type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} placeholder="BotFather's answer" aria-label="BotFather's answer, with the token" spellCheck={false} autoComplete="off" disabled={busy} />
                <button className="btn flex-none" type="submit" disabled={busy || !token.trim()}>
                  {busy ? "Connecting" : "Connect"}
                </button>
              </div>
              <ErrorLine text={error} />
            </form>
          )}
        </>
      ) : state.paired ? (
        <Row name={`@${state.bot}`} text={state.error ? <span className="text-danger">{state.error}</span> : error ? <span className="text-danger">{error}</span> : `Writes to ${state.who || "you"} and nobody else`}>
          <button className="btn btn-sm" disabled={busy} onClick={disconnect}>
            Disconnect
          </button>
        </Row>
      ) : state.code ? (
        <Row
          name={
            <>
              Send <span className="select-all font-mono font-medium">{state.code}</span> to @{state.bot}
            </>
          }
          text={state.error ? <span className="text-danger">{state.error}</span> : "From your own Telegram. The chat it comes from is the only one the bot answers."}
        >
          <a className="btn btn-sm" href={state.link} target="_blank" rel="noreferrer">
            Open in Telegram
          </a>
          <button className="btn btn-plain btn-sm" disabled={busy} onClick={disconnect}>
            Cancel
          </button>
        </Row>
      ) : (
        <Row name={`@${state.bot}`} text={error ? <span className="text-danger">{error}</span> : "Not paired. The code has run out."}>
          <button className="btn btn-sm" disabled={busy} onClick={() => run("code")}>
            New code
          </button>
          <button className="btn btn-plain btn-sm" disabled={busy} onClick={disconnect}>
            Cancel
          </button>
        </Row>
      )}
    </Group>
  );
}
