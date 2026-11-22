import type { Session } from "@/lib/db";

// Shown until a Google account is connected.
export default function Welcome({ session, error }: { session?: Session; error?: string }) {
  const steps: { done: boolean; text: string }[] = session
    ? [
        { done: session.googleConfigured, text: "Google sign-in client set up" },
        { done: session.modelConfigured, text: "Cloud model set up" },
      ]
    : [];
  const ready = !!session?.googleConfigured;

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--background)] px-4">
      <div className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface)] p-8 shadow-sm">
        <div className="flex items-center gap-3 mb-6">
          <img src="/logo.svg" alt="" width={36} height={36} className="rounded-lg" />
          <h1 className="text-2xl font-semibold text-[var(--foreground)]">Tabellar</h1>
        </div>
        {error ? (
          <p className="text-[var(--danger)]">Could not reach Tabellar: {error}</p>
        ) : (
          <>
            <p className="text-[var(--muted)] mb-6">
              Your mail stays on this Mac. Connect a Google account to start.
            </p>
            <ul className="mb-6 space-y-2">
              {steps.map((s) => (
                <li key={s.text} className="flex items-center gap-2 text-sm text-[var(--foreground)]">
                  <span className={`material-symbols-outlined text-[18px] ${s.done ? "text-[var(--success)]" : "text-[var(--muted)]"}`}>
                    {s.done ? "check_circle" : "radio_button_unchecked"}
                  </span>
                  {s.text}
                </li>
              ))}
            </ul>
            {!ready || !session?.modelConfigured ? (
              <p className="text-sm text-[var(--muted)] mb-6">
                Run <code className="px-1 rounded bg-[var(--surface-2)]">tabellar setup</code> in the terminal to finish setting up, then reload this page.
              </p>
            ) : null}
            <a
              href={ready ? "/oauth/start" : undefined}
              aria-disabled={!ready}
              className={`flex w-full items-center justify-center gap-2 rounded-lg px-4 py-2.5 font-medium ${
                ready ? "bg-[var(--accent)] text-white hover:opacity-90" : "bg-[var(--surface-2)] text-[var(--muted)] cursor-not-allowed"
              }`}
            >
              <span className="material-symbols-outlined text-[20px]">login</span>
              Sign in with Google
            </a>
          </>
        )}
      </div>
    </div>
  );
}
