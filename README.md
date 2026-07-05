# QnA RAG System

A single-document, retrieval-augmented Q&A chatbot. Ask questions about one specific PDF and get answers grounded in retrieved chunks, with source citations shown per message.

**Status: single-document proof of concept. Not multi-tenant, not evaluated against a test set, not production-hardened.** Read the Limitations section before describing this as more than that.

---

## What this actually does

1. A PDF is parsed offline (`scripts/ingest.ts`), split into ~500-word chunks with 50-word overlap, embedded with Google's `gemini-embedding-001`, and stored in a Supabase `pgvector` table.
2. At query time, the user's question is embedded (`RETRIEVAL_QUERY` task type — deliberately different from the `RETRIEVAL_DOCUMENT` type used at ingestion), and the top 3 chunks above a 0.5 cosine similarity threshold are retrieved via a Postgres RPC (`match_document_chunks`).
3. Retrieved chunks are injected into a system prompt that instructs the model to answer only from that context, cite page numbers, and explicitly say when it doesn't know.
4. The chunks are streamed to the client as a `data-citations` part _before_ the LLM starts generating, so the UI can show sources immediately. The answer streams in afterward via the Vercel AI SDK's `useChat`.

That's the whole system. There is no agent, no tool calling, no multi-step reasoning. It is retrieval + a grounded prompt + streaming. Don't call it more than that in an interview.

---

## Stack

- Next.js (App Router) + TypeScript + Tailwind
- Vercel AI SDK v5 (`streamText`, `useChat`, `DefaultChatTransport`, `createUIMessageStream`)
- Google Gemini: `gemini-2.5-flash-lite` (generation), `gemini-embedding-001` (embeddings, 768 dimensions)
- Supabase + pgvector (HNSW index, cosine distance)

## Setup

```bash
npm install
```

Create `.env.local`:

```
GOOGLE_GENERATIVE_AI_API_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SECRET_KEY=
```

Run the SQL in your Supabase project to create the `document_chunks` table (HNSW index, RLS policy, unique constraint on `(document_id, chunk_index)`) and the `match_document_chunks` RPC. Both are checked into the repo as reference SQL, not migrations — there is no migration tooling here.

Ingest the document:

```bash
npx tsx scripts/ingest.ts --file data/skeletal-muscle-growth.pdf --document-id skeletal-muscle-growth
```

The script is idempotent — re-running it skips chunks already present for that `document_id` by checking existing `chunk_index` values first. It does not re-embed unchanged chunks, and it does not detect content drift if you replace the PDF at the same path without changing chunk boundaries — see Limitations.

Run the app:

```bash
npm run dev
```

---

## Hardcoded to one document — by design, for now

`app/api/chat/route.ts` hardcodes `match_document_id: "skeletal-muscle-growth"` in the RPC call. The system prompt is also written in prose specific to this document's topic ("skeletal muscle growth"), and the UI (`page.tsx`) hardcodes the header text and example prompts to match.

This means: **ingesting a second document does nothing for this app as it stands.** The RPC will simply never be asked about it. This was a deliberate scope decision to finish the single-document pipeline correctly before generalizing — multi-document/multi-tenant retrieval, with `document_id` as a request parameter instead of a literal, is a Week 6 concern (metadata filtering, multi-tenant isolation) and is intentionally not built yet.

If asked in an interview "does this support multiple documents" — the honest answer is no, and here's what would need to change: `document_id` becomes a parameter passed from the client (or resolved from a document-selection UI), the system prompt becomes templated rather than hardcoded prose, and there needs to be a mechanism (RLS policy, most likely) enforcing that a user can only query documents they have access to.

---

## Chunking strategy

Paragraph-first, sentence-safe, word-count-target chunking (`scripts/ingest.ts`):

- Pages are split into paragraphs on double-newlines or long whitespace gaps.
- A lightweight heuristic flags likely headings (`< 80 chars`, no terminal punctuation, `≤ 10` words) and attaches the most recent heading as chunk metadata (`section_heading`).
- Content accumulates word-by-word; once a chunk hits ~500 words, it flushes with a 50-word overlap carried into the next chunk.
- Critically, the flush check happens at **sentence** granularity, not paragraph granularity. This document's two-column academic PDF layout doesn't survive extraction with clean paragraph breaks — `pdf-parse` merges what should be several paragraphs into one blob. Checking after every sentence instead of every paragraph bounds the overshoot to about one sentence's length instead of blowing 700–1200 words past target, which is what happened before this fix.
- A hard backstop (`MAX_SENTENCE_WORDS = 150`) force-splits any single "sentence" longer than that into fixed word windows, for extraction garbage with no usable punctuation at all.

### What this chunking strategy does NOT handle

Be honest about these if asked, because they will surface the moment a different PDF is ingested:

- **Tables**: extracted as word soup with no structural markers. Will be chunked as if it were prose, mid-row.
- **Repeated headers/footers**: a running header or page footer that repeats on every page gets extracted as a "paragraph" every single page and pollutes multiple chunks with duplicate junk text.
- **Heading detection is a heuristic, not a real classifier**: it will misfire in both directions — short sentences without terminal punctuation get flagged as headings; genuine headings with a colon (`Results:`) don't. `section_heading` metadata quality is unreliable, not verified.
- **Multi-column reading order is not fixed, only the overshoot is**: if the PDF parser extracts column A fully then column B fully, chunk-to-chunk narrative order can be scrambled even though the overshoot bug is resolved. Not tested against a document where this actually occurs.
- **No reference/bibliography detection**: a citation-heavy document will have its reference list chunked and embedded like body content, which can pollute retrieval.

This chunker was validated against exactly one PDF (32 pages, single/near-single column, prose-heavy). It has not been stress-tested against tables, multi-column layouts, or scanned/image PDFs. "Generic" is not a claim this code can currently support.

---

## What's verified vs. what's assumed

**Verified** (via direct SQL against Supabase, not assumed from ingestion logs):

- Row count matches expected chunk count (28/28)
- No gaps in `chunk_index` sequence
- Embedding dimension is 768 on every row
- Spot-checked chunk content against source PDF pages

**Not yet done:**

- No formal retrieval evaluation. There is no test set of known-answer questions run against this pipeline and scored. "It answered my test questions correctly a few times" is not evaluation — precision/recall/faithfulness measurement is a Week 6 topic and hasn't started.
- No adversarial testing — hasn't been deliberately asked questions with no answer in the document to confirm the refusal path holds up under variation, beyond basic manual spot checks.
- No load or concurrency testing.
- No check for whether the 0.5 similarity threshold is actually the right cutoff for this embedding model and this document — it's an assumed default, not a tuned value.

If a client or interviewer asks "how do you know this works," the honest answer right now is: manual spot-checking, not measurement. Say that plainly, don't imply more rigor than exists.

---

## Reliability behavior that IS implemented

- **Retrieval fails before the stream opens, not during it.** Embedding the query and calling the retrieval RPC both happen before `createUIMessageStream` is invoked. If either fails, the route returns a normal HTTP error (429, 500, 503) instead of corrupting an in-progress stream. This is a real production concern, not a hypothetical — mid-stream failures leave the client in an unrecoverable UI state.
- **429 errors are classified, not treated uniformly.** `embed-query.ts` and `ingest.ts` both distinguish quota-exhaustion 429s (retrying is pointless until midnight Pacific reset) from rate-limit 429s (retryable with backoff) by inspecting the response body. Retrying a quota-exhausted request is a wasted call and, at scale, a wasted cost.
- **`maxRetries: 0` is set explicitly on every `embed()` call.** The AI SDK has its own internal retry logic; without disabling it, a custom retry loop and the SDK's retry loop stack and silently multiply the number of API calls made per failure. This was an actual bug caught during ingestion, not a defensive habit copied from a tutorial.
- **Ingestion is resumable.** `getExistingChunkIndices()` checks what's already in the table before embedding, so a failed or interrupted ingestion run can be re-run without re-embedding (and re-paying for) chunks that already succeeded.

## Reliability behavior that is NOT implemented

- No caching of embeddings or repeated query results.
- No rate limiting on the `/api/chat` route itself — nothing stops a client from hammering it and running up the Gemini bill. Free tier makes this low-stakes right now; it would not be acceptable with a real user base.
- No hybrid search (vector + full-text) and no reranking — retrieval is pure cosine similarity, top-3, single threshold. If the top embedding match isn't the best answer, there's no second pass to catch that.
- No observability — no structured logging of retrieval quality, latency, or per-request cost. If this were failing for real users, there's currently no way to see it happening.
- No multi-tenant isolation, because there's only one document and no user-scoping at all yet.

---

## Known open issue (unrelated to this project)

A corrupted row from an earlier (Week 4) exercise still exists in a separate Supabase project — the source file was deleted but the database row was not cleaned up. Not part of this project's data, but flagged here as an open item, not swept under the rug.

---

## Honest one-line summary

This is a correctly-scoped, single-document RAG pipeline with real attention paid to failure modes around streaming, retries, and idempotent ingestion — that part is defensible. It is not evaluated, not multi-document, not load-tested, and the chunking strategy is proven on exactly one document layout. Present it as "Week 5 of a RAG curriculum, working single-doc pipeline, evaluation and multi-tenancy are the next milestones" — not as a finished production RAG system.
