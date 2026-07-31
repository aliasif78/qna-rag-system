import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { getSupabaseKeys } from './get-supabase-keys';

export async function createSupabaseServerClient() {
  const cookieStore = await cookies();
  const { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } = getSupabaseKeys();

  return createServerClient(SUPABASE_URL!, SUPABASE_PUBLISHABLE_KEY!, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll() {
        // Route handlers cannot set cookies — session refresh is handled by middleware.
        // Intentionally a no-op here.
      },
    },
  });
}
