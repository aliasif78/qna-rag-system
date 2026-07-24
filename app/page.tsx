// app/page.tsx
//
// Server Component. No 'use client'.
//
// Document status is read here, on the server, during the same render that
// produces the HTML. This removes an entire class of problem that the
// client-fetch version had:
//   - No hydration mismatch: the server and client both render from the same
//     prop, because the client never re-derives it.
//   - No module-level promise cache. That cache was a real bug, not just an
//     inelegance: module scope on the server is shared across every request
//     the instance handles, so one user's document status could be served to
//     another. Request-scoped server state has no such hazard.
//   - No /api/documents route to maintain, and no auth check duplicated into it.
//
// proxy.ts has already run getUser() and redirected unauthenticated requests
// before this renders, so reaching this component implies a session — but we
// re-read the user rather than assuming, because the count query needs the ID
// and an assumed ID is how RLS gets bypassed by accident.

import { redirect } from 'next/navigation';
import { createSupabaseServerClient } from '@/lib/supabase/server';
import ChatClient from '@/components/chat-client';

// Status must reflect the current upload state on every visit, not a value
// captured at build time.
export const dynamic = 'force-dynamic';

export default async function Page() {
  const supabase = await createSupabaseServerClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect('/auth');
  }

  // head: true — count only, no rows over the wire. Selecting chunk bodies to
  // then discard them would pull the whole document to answer a yes/no.
  const { count, error: countError } = await supabase.from('document_chunks').select('*', { count: 'exact', head: true }).eq('user_id', user.id);

  if (countError) {
    console.error(`Document status read failed for user ${user.id}:`, countError.message);
  }

  // Distinguish "zero chunks" from "could not read". Both show the upload
  // panel, but only one warrants a warning — telling a user with a working
  // document to re-upload is destructive, since upload deletes before it
  // ingests.
  return <ChatClient initialChunkCount={count ?? 0} statusUnavailable={Boolean(countError)} />;
}
