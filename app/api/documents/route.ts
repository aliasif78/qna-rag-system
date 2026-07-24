// app/api/documents/route.ts

import { createSupabaseServerClient } from '@/lib/supabase/server';

// Status-only read. Deliberately NOT a GET handler bolted onto
// /api/upload — that route is a POST that deletes and rewrites user data.
// Overloading one route with an unrelated read makes both harder to reason
// about and to secure.
export async function GET(): Promise<Response> {
  const supabase = await createSupabaseServerClient();

  // getUser(), not getSession() — same reasoning as the upload route.
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  // head: true — count only, no rows over the wire. Selecting the chunk bodies
  // to then discard them would pull the entire document to answer a yes/no.
  const { count, error } = await supabase.from('document_chunks').select('*', { count: 'exact', head: true }).eq('user_id', user.id);

  if (error) {
    console.error(`Document status check failed for user ${user.id}:`, error.message);
    return Response.json({ error: 'Status check failed.' }, { status: 500 });
  }

  return Response.json({ chunkCount: count ?? 0 });
}
