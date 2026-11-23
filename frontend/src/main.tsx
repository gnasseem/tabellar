import { createRoot } from "react-dom/client";
import "./index.css";
import AppShell from "@/components/AppShell";
import EmailDashboard from "@/components/EmailDashboard";
import Welcome from "@/components/Welcome";
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

loadSession()
  .then((session) => {
    if (session.user && session.profile && session.accounts > 0) {
      root.render(
        <AppShell user={session.user} profile={session.profile as never}>
          <EmailDashboard />
        </AppShell>,
      );
    } else {
      root.render(<Welcome session={session} />);
    }
  })
  .catch((e: Error) => {
    root.render(<Welcome error={e.message} />);
  });
