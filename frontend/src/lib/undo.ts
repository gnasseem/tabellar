// Taking back a choice the server spreads over several tables (server/reversible.ts).
import { reversible as take } from "../../../server/reversible.ts";
import { createClient } from "@/lib/db";

// Runs a change; returns what takes it back.
export const reversible = (userId: string, change: () => Promise<unknown>) => take(createClient(), userId, change);
