import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY. Check .env.local.");
}

// Publishable key, not the secret key. This client is safe to use in an API
// route (server) and safe to ship to the browser if you ever need client-side
// reads. It relies on RLS to restrict what it can actually touch — it does NOT
// bypass RLS the way the secret-key client in ingest.ts does. Do not use this
// client for anything that needs to write across RLS boundaries.
export const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
