import { createRoot } from "react-dom/client";
import "material-symbols/outlined.css";
import "material-symbols/rounded.css";
import "./index.css";
import AppShell from "@/components/AppShell";
import EmailDashboard from "@/components/EmailDashboard";
import Welcome from "@/components/Welcome";
import { loadSession } from "@/lib/db";

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
