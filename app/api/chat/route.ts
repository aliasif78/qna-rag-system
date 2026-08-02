// app/api/chat/route.ts

import { createUIMessageStream, createUIMessageStreamResponse, streamText, convertToModelMessages, UIMessage, toUIMessageStream } from 'ai';
import { google } from '@ai-sdk/google';
import { embedQuery, QueryEmbeddingError } from '@/lib/ai/embed-query';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const maxDuration = 30;

// Retrieval cutoff: chunks below this never make it into context at all.
// This lives in the RPC call (see match_document_chunks below).
const RETRIEVAL_THRESHOLD = 0.5;

// Confidence cutoff: separate from retrieval. A chunk can clear
// RETRIEVAL_THRESHOLD and still not be similar enough to trust as a
// grounded answer. Chunks between these two thresholds are shown to the
// model AND flagged to the client as low-confidence, instead of being
// treated identically to a strong match. This value is unvalidated against
// a real eval set — treat it as a starting point, not a tuned constant.
const CONFIDENCE_THRESHOLD = 0.65;

const NO_CONTEXT_MESSAGE = "I don't have enough information in this document to answer that.";

interface RetrievedChunk {
  id: number;
  content: string;
  pageNumber: number;
  chunkIndex: number;
  sectionHeading: string | null;
  similarity: number;
}

export async function POST(req: Request) {
  // Auth first. Nothing else — no body parse, no embedding call — happens
  // for an unauthenticated request. getUser() revalidates the JWT against
  // the Supabase Auth server; getSession() only decodes the cookie and is
  // spoofable, so it must not be used for an authorization decision.
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return new Response('Unauthorized.', { status: 401 });
  }

  // One document per user: the ingestion pipeline stores the user's ID as
  // document_id. This is a deliberate single-document limitation, not a
  // multi-document design. Adding a second document per user requires a
  // real document_id column and a request parameter.
  const documentId = user.id;

  let messages: UIMessage[];
  try {
    ({ messages } = await req.json());
  } catch {
    return new Response('Malformed request body.', { status: 400 });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response('messages must be a non-empty array.', { status: 400 });
  }

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== 'user') {
    return new Response('Last message must be from the user.', { status: 400 });
  }

  const userText = lastMessage.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join(' ')
    .trim();

  if (!userText) {
    return new Response('Message has no text content.', { status: 400 });
  }

  // Everything in this block runs BEFORE the stream opens. If any of it
  // fails, we return a normal HTTP error — not a corrupted stream.
  let chunks: RetrievedChunk[];
  try {
    const queryEmbedding = await embedQuery(userText);

    // match_document_id is derived from the verified session, never from the
    // request body. A client cannot address another user's document by
    // forging a parameter. Whether RLS provides a second layer here depends
    // on match_document_chunks being SECURITY INVOKER — verify with:
    //   SELECT proname, prosecdef FROM pg_proc
    //   WHERE proname = 'match_document_chunks';
    // prosecdef = true means this parameter is the ONLY isolation boundary.
    const { data, error } = await supabase.rpc('match_document_chunks', {
      query_embedding: queryEmbedding,
      match_document_id: documentId,
      match_count: 5,
      match_threshold: RETRIEVAL_THRESHOLD,
    });

    if (error) {
      console.error('match_document_chunks RPC failed:', error.message);
      return new Response('Retrieval failed.', { status: 500 });
    }

    chunks = (data ?? []).map((row: { id: number; content: string; page_number: number; chunk_index: number; section_heading: string | null; similarity: number }) => ({
      id: row.id,
      content: row.content,
      pageNumber: row.page_number,
      chunkIndex: row.chunk_index,
      sectionHeading: row.section_heading,
      similarity: row.similarity,
    }));
  } catch (err) {
    if (err instanceof QueryEmbeddingError) {
      const status = err.kind === 'rate_limited' ? 429 : err.kind === 'quota_exhausted' ? 503 : 500;
      return new Response(err.message, { status });
    }
    console.error('Unexpected retrieval error:', err);
    return new Response('Internal error.', { status: 500 });
  }

  // Hard gate: nothing cleared RETRIEVAL_THRESHOLD. Do not call the model at
  // all. Refusal here is a code-level guarantee, not a prompt instruction the
  // model could choose to ignore, and it saves a generation call we already
  // know should refuse. Note this branch is also what an authenticated user
  // with no ingested document hits — it is indistinguishable from a genuine
  // no-match, which is a UX gap worth closing separately.
  if (chunks.length === 0) {
    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        writer.write({ type: 'data-citations', data: { chunks: [], lowConfidence: false } });

        const id = crypto.randomUUID();
        writer.write({ type: 'text-start', id });
        writer.write({ type: 'text-delta', id, delta: NO_CONTEXT_MESSAGE });
        writer.write({ type: 'text-end', id });
      },
    });
    return createUIMessageStreamResponse({ stream });
  }

  const maxSimilarity = Math.max(...chunks.map((c) => c.similarity));
  const lowConfidence = maxSimilarity < CONFIDENCE_THRESHOLD;

  const contextBlock = chunks.map((c, i) => `[Chunk ${i + 1} — page ${c.pageNumber}]\n${c.content}`).join('\n\n');

  const systemPrompt = `You answer questions about a single document using ONLY the context chunks provided below.

You do not know what this document is about beyond what the chunks contain. Do not infer a subject area and do not apply domain knowledge you were not given. If the chunks are the only thing you know about this document, that is correct and intentional.

Rules:
- If the answer is not contained in the chunks, say explicitly: "${NO_CONTEXT_MESSAGE}" Do not use outside knowledge and do not guess.
- When you use a chunk, cite the page number in parentheses, e.g. "(page 4)".
- Never invent a page number or a claim not present in the chunks below.
- Before citing any specific value (a number, date, name, percentage, duration, quantity, or identifier), verify it answers the exact thing the question asked for — not a related or adjacent value that happens to sit nearby in the same chunk. Two values can share a chunk, a unit, and a topic and still measure different things. If the chunks contain a related-but-distinct value rather than the one asked for, say so explicitly ("the document reports X, but does not report Y") instead of presenting the related value as the answer.
- When multiple chunks contain relevant material, synthesize across all of them rather than answering from the first one alone.
- Include specific values and findings where they are present, but express them in your own sentence structure. Do not mirror the wording, phrasing, or sentence shape of the source text.
- If the question is broad, structure the answer to cover the distinct points present in the retrieved chunks.
- The chunks are retrieved by semantic similarity and may be incomplete or out of order. Absence of something from the chunks is not evidence it is absent from the document — if a question asks what the document does NOT contain, or asks for a total, count, or exhaustive list, say that you can only speak to the retrieved passages.
${lowConfidence ? `- The retrieved chunks are only weakly similar to this question (below the confidence threshold). Treat this as a signal the document may not address what was asked. Be conservative: if the chunks do not squarely answer the question, say so rather than stretching them to fit.` : ''}

Context chunks:
${contextBlock}`;

  const stream = createUIMessageStream({
    execute: async ({ writer }) => {
      writer.write({
        type: 'data-citations',
        data: { chunks, lowConfidence },
      });

      const result = streamText({
        model: google('gemini-3.5-flash-lite'),
        system: systemPrompt,
        messages: await convertToModelMessages(messages),
        onFinish: ({ finishReason, usage, finalStep }) => {
          if (finishReason !== 'stop') {
            console.error(`Generation ended abnormally: ${finishReason}`, usage, JSON.stringify(finalStep.providerMetadata));
          }
        },
      });

      writer.merge(toUIMessageStream({ stream: result.stream }));
    },
  });

  return createUIMessageStreamResponse({ stream });
}
