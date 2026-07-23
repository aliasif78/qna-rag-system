import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseKeys } from "./get-supabase-keys";

// Publishable key, not the secret key. This client is safe to use in an API
// route (server) and safe to ship to the browser if you ever need client-side
// reads. It relies on RLS to restrict what it can actually touch — it does NOT
// bypass RLS the way the secret-key client in ingest.ts does. Do not use this
// client for anything that needs to write across RLS boundaries.
export function createSupabaseBrowserClient() {
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = getSupabaseKeys();
  return createBrowserClient(SUPABASE_URL!, SUPABASE_PUBLISHABLE_KEY!);
}
