// Settings, Notifications: Telegram. The user's own bot: made with BotFather,
// its token pasted here, then paired with the one chat that sends the code.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/outcomes";
import { ErrorLine } from "../ModelSetup";
import { Group, loadingLines, Row } from "./parts";

type State = { bot: string | null; who?: string | null; paired?: boolean; code?: string | null; link?: string; error?: string | null };

const POLL_MS = 2000;

export function Telegram() {
  const [state, setState] = useState<State | null>(null);
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    (api("/telegram") as Promise<State>).then(setState).catch((e) => setError((e as Error).message));
  }, []);
  useEffect(load, [load]);

  // Until the code is sent from the phone, or has run out.
  const waiting = !!state?.code;
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
  const disconnect = () => {
    if (state?.paired && !window.confirm(`Disconnect @${state.bot}?\n\nNothing more goes to Telegram. The bot itself stays until you delete it in BotFather.`)) return;
    void run("disconnect");
  };

  return (
    <Group title="Telegram" note="Telegram can read what a bot sends you: who wrote, the summary, short answers, and a longer draft when you press Read. Attachments are never sent.">
      {!state ? (
        error ? <ErrorLine text={error} /> : loadingLines
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
                  In Telegram, write{" "}
                  <span className="font-mono text-ink">/newbot</span> to{" "}
                  <a className="link" href="https://t.me/BotFather" target="_blank" rel="noreferrer">
                    @BotFather
                  </a>
                </li>
                <li>
                  Give it any name, then a username that ends in <span className="font-mono text-ink">bot</span>
                </li>
                <li>Paste the token it answers with</li>
              </ol>
              <div className="flex flex-wrap gap-2">
                <input className="input min-w-[200px] flex-1 font-mono" type="password" autoFocus value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AAE..." aria-label="Bot token" spellCheck={false} autoComplete="off" disabled={busy} />
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
