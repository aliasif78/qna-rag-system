import { createUIMessageStream, createUIMessageStreamResponse, streamText, convertToModelMessages, UIMessage, toUIMessageStream } from "ai";
import { google } from "@ai-sdk/google";
import { embedQuery, QueryEmbeddingError } from "@/lib/ai/embed-query";
import { supabase } from "@/lib/supabase/client";

export const maxDuration = 30;

interface RetrievedChunk {
  id: number;
  content: string;
  pageNumber: number;
  chunkIndex: number;
  sectionHeading: string | null;
  similarity: number;
}

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "user") {
    return new Response("Last message must be from the user.", { status: 400 });
  }

  const userText = lastMessage.parts
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join(" ")
    .trim();

  if (!userText) {
    return new Response("Message has no text content.", { status: 400 });
  }

  // Everything in this block runs BEFORE the stream opens. If any of it
  // fails, we return a normal HTTP error — not a corrupted stream.
  let chunks: RetrievedChunk[];
  try {
    const queryEmbedding = await embedQuery(userText);

    const { data, error } = await supabase.rpc("match_document_chunks", {
      query_embedding: queryEmbedding,
      match_document_id: "skeletal-muscle-growth",
      match_count: 3,
      match_threshold: 0.5,
    });

    if (error) {
      console.error("match_document_chunks RPC failed:", error.message);
      return new Response("Retrieval failed.", { status: 500 });
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
      const status = err.kind === "rate_limited" ? 429 : err.kind === "quota_exhausted" ? 503 : 500;
      return new Response(err.message, { status });
    }
    console.error("Unexpected retrieval error:", err);
    return new Response("Internal error.", { status: 500 });
  }

  const contextBlock = chunks.length > 0 ? chunks.map((c, i) => `[Chunk ${i + 1} — page ${c.pageNumber}]\n${c.content}`).join("\n\n") : "(No chunks were retrieved above the similarity threshold for this query.)";

  const systemPrompt = `You answer questions about a document on skeletal muscle growth using ONLY the context chunks provided below.

Rules:
- If the answer is not contained in the chunks, say explicitly: "I don't have enough information in this document to answer that." Do not use outside knowledge and do not guess.
- When you use a chunk, cite the page number in parentheses, e.g. "(page 4)".
- Never invent a page number or a claim not present in the chunks below.
- When multiple chunks contain relevant findings, synthesize across all of
  them rather than answering from a single chunk. Prefer specific
  quantitative findings (percentages, durations, sample sizes) over vague
  paraphrase when the chunks contain them.
- If the question is broad, structure the answer to cover the distinct
  findings present in the retrieved chunks, not just the first one.

Context chunks:
${contextBlock}`;

  // createUIMessageStream() itself does nothing until something starts
  // consuming it. It wires up `execute` to run when the stream is read,
  // and handles merging multiple writer.write/writer.merge calls into a
  // single well-formed UIMessageStream, including auto-generating the
  // start/finish envelope events and catching thrown errors inside execute
  // so a crash mid-generation becomes a stream error event instead of an
  // unhandled server exception.
  const stream = createUIMessageStream({
    // This callback runs once per request, on the server. `writer` is your
    // handle for pushing arbitrary parts into the outgoing UI message stream
    // — it is NOT the same as returning a value; nothing is sent until you
    // call writer.write() or writer.merge().
    execute: async ({ writer }) => {
      // Pushes a single, complete, non-streamed part into the stream immediately.
      // `type: "data-citations"` is a custom part type (the "data-" prefix is
      // the AI SDK convention that makes it show up in message.parts on the
      // client as { type: "data-citations", data: {...} }). This part carries
      // your retrieved chunks — content, page, similarity — as one atomic
      // JSON blob, not token-by-token. It arrives before the LLM has generated
      // a single word, because retrieval already finished earlier in the route
      // (before createUIMessageStream was even called).
      writer.write({
        type: "data-citations",
        data: { chunks },
      });

      // Starts the actual LLM generation. streamText() does not block here —
      // it returns immediately with a StreamTextResult object whose
      // .stream property is an async iterable that yields chunks as the
      // model produces them. No tokens have necessarily been generated yet
      // at the point this line finishes executing; you just have the handle.
      const result = streamText({
        model: google("gemini-2.5-flash-lite"),
        system: systemPrompt,
        messages: await convertToModelMessages(messages),
        onFinish: ({ finishReason, usage }) => {
          if (finishReason !== "stop") {
            console.error(`Generation ended abnormally: ${finishReason}`, usage);
          }
        },
      });

      // toUIMessageStream() adapts the raw model stream (text-delta events,
      // tool-call events, finish events) into the UIMessageStream chunk
      // format (start, text-start, text-delta, text-end, finish, etc.) —
      // the same wire format your data-citations part already used.
      // writer.merge() then splices that adapted stream into the SAME
      // outgoing stream as the citations part, back-pressure-aware: it
      // waits for the model to actually produce tokens rather than buffering
      // everything in memory. The client sees one continuous stream where
      // the citations part arrived first, followed by streaming text parts
      // as the model generates them.
      writer.merge(toUIMessageStream({ stream: result.stream }));
    },
  });

  // Wraps the UIMessageStream in an actual HTTP Response object with the
  // correct headers (content-type, no caching, chunked transfer) that
  // useChat's default transport expects. This is the return value of your
  // route handler — the thing Next.js actually sends over the wire.
  return createUIMessageStreamResponse({ stream });
}
