import { createRoot } from "react-dom/client";
import "./index.css";
import AppShell from "@/components/AppShell";
import EmailDashboard from "@/components/EmailDashboard";
import Welcome, { AGAIN } from "@/components/Welcome";
import { loadSession } from "@/lib/db";

// A page's code that no longer exists (the interface was rebuilt while the
// window was open): reload once to get the new build. The flag stops a loop
// if the reload does not help.
window.addEventListener("vite:preloadError", (e) => {
  try {
    if (sessionStorage.getItem("tabellar:reloaded")) return;
    sessionStorage.setItem("tabellar:reloaded", "1");
  } catch {
    return;
  }
  e.preventDefault();
  window.location.reload();
});
setTimeout(() => {
  try {
    sessionStorage.removeItem("tabellar:reloaded");
  } catch {
    // Storage blocked; the reload above is skipped as well.
  }
}, 10_000);

const root = createRoot(document.getElementById("root")!);

// The first run until it is done (or while no mailbox is connected), then
// the window. Settings opens the first-run steps again at #setup.
loadSession()
  .then((session) => {
    const p = session.profile;
    let again = window.location.hash === "#setup";
    try {
      if (sessionStorage.getItem(AGAIN)) {
        sessionStorage.removeItem(AGAIN);
        again = true;
      }
    } catch {
      // Storage blocked: the sign-in returns to Settings instead.
    }
    if (session.user && p && session.accounts > 0 && p.onboarding === "done" && !again) {
      root.render(
        <AppShell user={session.user} profile={p as never}>
          <EmailDashboard />
        </AppShell>,
      );
    } else {
      root.render(<Welcome session={session} again={again && !!p && p.onboarding === "done" && session.accounts > 0} />);
    }
  })
  .catch((e: Error) => {
    root.render(<Welcome error={e.message} />);
  });
