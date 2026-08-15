import { createBrowserClient } from "@supabase/ssr";

// One shared browser client for the whole app.
//
// This used to return a new client on every call. Because components create
// their client in the render body, every render produced a new object, which
// changed the identity of every useCallback and useEffect that lists the
// client as a dependency. In useLiveUpdates that meant the background sync
// effect tore down and re-ran on every render of AppShell, firing a sync
// immediately each time and resetting its interval so it never ran on
// schedule. It also opened a separate realtime connection per component.
//
// createBrowserClient reads auth state from cookies on each request, so a
// single long-lived instance stays correct across sign-in and sign-out.
let browserClient: ReturnType<typeof createBrowserClient> | null = null;

export function createClient() {
  // Never cache during SSR: a module-level instance would be shared across
  // requests. Client components can have their module evaluated on the server.
  if (typeof window === "undefined") {
    return createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
    );
  }
  if (!browserClient) {
    browserClient = createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(),
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!.trim(),
    );
  }
  return browserClient;
}
