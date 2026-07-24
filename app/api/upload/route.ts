// app/api/upload/route.ts

import { createSupabaseServerClient } from '@/lib/supabase/server';
import { extractPages, stripBackMatter, splitIntoParagraphs, chunkParagraphs, embedWithRetry, errorMessage } from '@/lib/ai/ingest-pipeline';

// Long-running route: PDF parse + N serial embedding calls with backoff.
// 60s is tight if the Gemini free tier rate-limits mid-ingestion and backoff
// kicks in repeatedly. For larger documents (50+ pages → 50+ chunks) this
// will time out. The fix is either async job processing (beyond this scope)
// or batched parallel embedding (risk: hammers rate limits harder).
export const maxDuration = 60;

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

// Stale-lock threshold for the upload_locks table. Must exceed maxDuration
// (60s) with margin for the request/response round trip PostgREST itself
// adds, or a legitimately still-running upload can have its lock stolen
// mid-ingestion. This value is a recovery mechanism for the case where the
// platform kills the function on timeout before the `finally` block below
// can run — without it, a single crashed request permanently locks the user
// out of uploading ever again.
const LOCK_STALE_MS = 75_000;

export async function POST(request: Request): Promise<Response> {
  // Auth — getUser(), not getSession().
  // getSession() reads the JWT from the cookie without re-validating with the
  // Supabase auth server. A replayed or tampered token passes silently.
  // getUser() makes a server round-trip to verify the token every time.
  // For a route that deletes and re-writes user data, anything less is wrong.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const userId = user.id;

  // Parse multipart body
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return Response.json({ error: 'Could not parse multipart/form-data body.' }, { status: 400 });
  }

  const file = formData.get('file');

  if (!file || !(file instanceof File)) {
    return Response.json({ error: 'Missing "file" field in form data.' }, { status: 400 });
  }

  // MIME type comes from the client — trivially spoofable. Check it anyway
  // for fast rejection of obvious mistakes, but don't trust it as the sole
  // content guard. Magic bytes below are the real check.
  if (file.type !== 'application/pdf') {
    return Response.json({ error: `Invalid file type: "${file.type}". Only application/pdf is accepted.` }, { status: 415 });
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return Response.json({ error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Maximum is 20MB.` }, { status: 413 });
  }

  const arrayBuffer = await file.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Magic bytes: every valid PDF starts with %PDF (hex 25 50 44 46).
  // This catches spoofed MIME types and genuinely corrupt uploads before
  // they hit the parser, which would otherwise surface a less useful error.
  if (buffer.length < 4 || buffer.subarray(0, 4).toString('ascii') !== '%PDF') {
    return Response.json({ error: 'File does not appear to be a valid PDF.' }, { status: 422 });
  }

  // Concurrency guard. Nothing previously stopped two requests for the same
  // user (double-click, retry after an apparent failure that actually
  // succeeded) from both reaching the delete-then-reingest section below and
  // interleaving their upserts against the same document_id. This insert is
  // the acquire: the primary key on upload_locks.user_id makes a second
  // concurrent insert fail with a unique violation instead of silently
  // succeeding.
  const { error: lockError } = await supabase.from('upload_locks').insert({ user_id: userId });

  if (lockError) {
    if (lockError.code !== '23505') {
      // Not a conflict — something else broke (RLS misconfig, connection
      // issue). Fail closed rather than proceed without a lock.
      console.error(`Failed to acquire upload lock for user ${userId}:`, lockError.message);
      return Response.json({ error: 'Could not acquire upload lock.' }, { status: 500 });
    }

    // A lock row already exists. Either a real concurrent upload is running,
    // or a previous invocation was killed by the platform's function timeout
    // before it reached the `finally` cleanup below. Distinguish by age.
    const { data: existingLock } = await supabase.from('upload_locks').select('started_at').eq('user_id', userId).single();

    const isStale = existingLock && Date.now() - new Date(existingLock.started_at).getTime() > LOCK_STALE_MS;

    if (!isStale) {
      return Response.json({ error: 'Another upload is already in progress for this document. Wait for it to finish and try again.' }, { status: 409 });
    }

    // Steal the stale lock via compare-and-swap. The UPDATE...WHERE clause is
    // evaluated against the row's current state at execution time, row-locked
    // — not against the stale `existingLock.started_at` value we read a
    // moment ago. If two requests race to steal the same stale lock, the
    // first UPDATE commits and changes started_at; the second UPDATE's WHERE
    // no longer matches (started_at is no longer less than the value it
    // captured) and returns zero rows. That's what makes this atomic instead
    // of a second TOCTOU bug layered on top of the first one.
    const { data: stolen, error: stealError } = await supabase.from('upload_locks').update({ started_at: new Date().toISOString() }).eq('user_id', userId).lt('started_at', existingLock.started_at).select('user_id');

    if (stealError || !stolen || stolen.length === 0) {
      return Response.json({ error: 'Another upload is already in progress for this document. Wait for it to finish and try again.' }, { status: 409 });
    }
  }

  try {
    // Extract, strip back matter, split, chunk — BEFORE touching existing data.
    // This is pure/in-memory: no reason it should happen after a destructive delete.
    let chunks: Awaited<ReturnType<typeof chunkParagraphs>>;
    try {
      const pages = await extractPages(buffer);
      const contentPages = stripBackMatter(pages);
      const paragraphs = splitIntoParagraphs(contentPages);
      chunks = chunkParagraphs(paragraphs);
    } catch (err) {
      console.error(`Pipeline (extract/chunk) failed for user ${userId}:`, errorMessage(err));
      return Response.json({ error: 'Document processing failed. The file may be corrupt or image-only.' }, { status: 422 });
    }

    if (chunks.length === 0) {
      return Response.json({ error: 'Document produced no chunks. It may be empty, image-only, or entirely back matter.' }, { status: 422 });
    }

    // Only now do we know the new document is viable. Safe to delete the old one.
    //
    // KNOWN LIMITATION — STILL NOT ATOMIC: this reorder eliminates the "delete
    // then fail validation" failure mode, but the embed loop below can still
    // fail partway through and leave a degraded document (old data is gone,
    // new data is incomplete). Real fix is ingest-to-new-id + atomic swap,
    // or a Postgres transaction via RPC. Out of scope for this stage —
    // documented, not solved. The upload_locks guard above prevents two
    // requests from corrupting each other; it does nothing for this
    // single-request partial-failure case.
    const { error: deleteError } = await supabase.from('document_chunks').delete().eq('user_id', userId);

    if (deleteError) {
      console.error(`Failed to delete existing chunks for user ${userId}:`, deleteError.message);
      return Response.json({ error: 'Failed to clear existing document.' }, { status: 500 });
    }

    const documentId = userId;

    // Embed and upsert — serial, one chunk at a time.
    // Serial is correct here given Gemini's free-tier rate limits. Parallel
    // requests would batch faster in theory but hammer the limit and cause
    // more backoff retries. For paid-tier keys with high RPM, switch to
    // batched parallel with a concurrency cap (e.g. p-limit(5)).
    let chunksIngested = 0;

    for (const chunk of chunks) {
      let embedding: number[];

      try {
        embedding = await embedWithRetry(chunk.content);
      } catch (err) {
        console.error(`Embedding failed on chunk ${chunk.chunkIndex} for user ${userId}: ${errorMessage(err)}. ` + `Document is now in a degraded state — ${chunksIngested} of ${chunks.length} chunks ingested.`);
        // Do not continue the loop: if embedding is failing (quota exhausted,
        // persistent error), subsequent calls will also fail. Returning now
        // avoids burning through all remaining chunks only to fail again.
        return Response.json(
          {
            error: `Ingestion failed at chunk ${chunk.chunkIndex}: ${errorMessage(err)}. Document is incomplete — ${chunksIngested} of ${chunks.length} chunks were stored.`,
            chunksIngested,
          },
          { status: 500 }
        );
      }

      const { error: upsertError } = await supabase.from('document_chunks').upsert(
        {
          document_id: documentId,
          content: chunk.content,
          embedding,
          chunk_index: chunk.chunkIndex,
          page_number: chunk.pageNumber,
          section_heading: chunk.sectionHeading,
          user_id: userId,
        },
        { onConflict: 'document_id,chunk_index' }
      );

      if (upsertError) {
        console.error(`Supabase upsert failed on chunk ${chunk.chunkIndex} for user ${userId}: ${upsertError.message}. ` + `Document is now in a degraded state.`);
        return Response.json(
          {
            error: `Database write failed at chunk ${chunk.chunkIndex}. Document is incomplete — ${chunksIngested} of ${chunks.length} chunks were stored.`,
            chunksIngested,
          },
          { status: 500 }
        );
      }

      chunksIngested++;
    }

    return Response.json({ chunksIngested });
  } finally {
    // Release the lock on every exit path — success, validation error, or
    // mid-loop failure. If this delete itself fails, the lock becomes stale
    // after LOCK_STALE_MS and the steal path above recovers it; log so the
    // failure isn't silent in the meantime.
    const { error: unlockError } = await supabase.from('upload_locks').delete().eq('user_id', userId);
    if (unlockError) {
      console.error(`Failed to release upload lock for user ${userId}:`, unlockError.message);
    }
  }
}
