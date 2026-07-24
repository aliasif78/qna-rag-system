# QnA RAG System

A retrieval-augmented Q&A chatbot. Each authenticated user uploads their own PDF and asks questions about it, grounded in retrieved chunks with per-message source citations.

**Status: functional multi-tenant proof of concept. Not load-tested, not evaluated against a retrieval quality benchmark, not hardened for production traffic.** Read Limitations before describing this as more than that — in an interview or client conversation, say exactly what's below, not more.

---

## What this actually does

1. A user signs up / signs in (Supabase Auth, email + password). Middleware (`proxy.ts`) gates `/` and `/auth` based on session state.
2. The user uploads a PDF via `/api/upload`. The server extracts text page-by-page, strips bibliography/back-matter, chunks it (~500 words, 50-word overlap, sentence-safe), embeds each chunk with `gemini-embedding-001`, and stores it in a Supabase `pgvector` table scoped to that user's ID.
3. Uploading a new PDF replaces the old one. This is destructive by design — one document per user, not a document library.
4. At query time, the question is embedded (`RETRIEVAL_QUERY` task type — deliberately different from the `RETRIEVAL_DOCUMENT` type used at ingestion), and the top 5 chunks above a 0.5 cosine similarity threshold are retrieved via a Postgres RPC (`match_document_chunks`), scoped to the requesting user's own document.
5. Retrieved chunks are injected into a system prompt instructing the model to answer only from that context, cite page numbers, avoid conflating adjacent-but-distinct values, paraphrase rather than mirror source wording, and explicitly say when the document doesn't answer the question.
6. If nothing clears the similarity threshold, the LLM is never called — a fixed "not enough information" response is returned by code, not by prompt instruction.
7. Chunks stream to the client as a `data-citations` part before generation starts, so sources render immediately; the answer streams in afterward via the Vercel AI SDK's `useChat`.

There is no agent, no tool calling, no multi-step reasoning, and no cross-document retrieval. It is auth + per-user ingestion + retrieval + a grounded prompt + streaming. Don't describe it as more than that.

---

## Stack

- Next.js (App Router) + TypeScript + Tailwind
- Vercel AI SDK v5 (`streamText`, `useChat`, `DefaultChatTransport`, `createUIMessageStream`)
- Google Gemini: `gemini-2.5-flash-lite` (generation), `gemini-embedding-001` (embeddings, 768 dimensions)
- Supabase: Postgres + pgvector (HNSW index, cosine similarity), Auth, RLS

---

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

`SUPABASE_SECRET_KEY` is used only by `scripts/ingest.ts` (bypasses RLS intentionally, for offline/manual ingestion). The app itself — both API routes and the browser client — uses the publishable key and goes through RLS. Never ship the secret key to the client.

### Database

Run the SQL checked into the repo (reference SQL, not migrations — there is no migration tooling here) to create:

- `document_chunks` — columns for `document_id`, `content`, `embedding` (vector(768)), `chunk_index`, `page_number`, `section_heading`; HNSW index on `embedding`; unique constraint on `(document_id, chunk_index)`; RLS policy scoping rows to the owning user.
- `upload_locks` — `user_id` (PK), `started_at`. Prevents concurrent uploads for the same user from corrupting each other.
- `match_document_chunks` RPC — cosine similarity search, parameterized by `query_embedding`, `match_document_id`, `match_count`, `match_threshold`.

**Before relying on RLS as an isolation guarantee, verify `match_document_chunks`'s security mode:**

```sql
SELECT proname, prosecdef FROM pg_proc WHERE proname = 'match_document_chunks';
```

If `prosecdef = true` (`SECURITY DEFINER`), the function runs with the privileges of its owner, not the caller — RLS does not apply inside it, and the `match_document_id` parameter passed from `/api/chat` (always derived from the authenticated session, never from client input) is the _only_ isolation boundary. If `prosecdef = false` (`SECURITY INVOKER`), RLS applies as a second layer. Know which one you have before claiming isolation is enforced.

### Run

```bash
npm run dev
```

Sign up, upload a PDF, ask questions.

### CLI ingestion (optional, for manual/offline use)

```bash
npx tsx scripts/ingest.ts --file <path> --document-id <id>
```

Idempotent — checks existing `chunk_index` values for that `document_id` and skips chunks already present. Does not re-embed unchanged chunks, and does not detect content drift if you re-run against a different file under the same `document_id` — see Limitations. This path bypasses the app's own upload flow (and its lock/replace semantics) entirely; it's a lower-level tool, not an alternate front door for end users.

---

## Architecture

```
proxy.ts (middleware)
  → getUser() [validates JWT server-side, NOT a cookie read]
  → unauth'd + "/"     → redirect "/auth"
  → auth'd + "/auth"   → redirect "/"

app/page.tsx (Server Component)
  → re-checks getUser() independently of middleware
  → head-count query on document_chunks scoped to user.id
  → passes { initialChunkCount, statusUnavailable } to ChatClient

components/chat-client.tsx (Client Component)
  → upload flow → POST /api/upload
  → chat flow   → useChat → POST /api/chat (streamed)
  → client-side session watchdog (UX only — not a security boundary)

app/api/upload/route.ts
  → auth (getUser)
  → acquire upload_locks row (CAS steal for stale locks)
  → extractPages → stripBackMatter → splitIntoParagraphs → chunkParagraphs
  → validate chunks non-empty BEFORE deleting old document
  → delete existing document_chunks for user → embed + insert new chunks
  → release lock (finally block, every exit path)

app/api/chat/route.ts
  → auth (getUser)
  → documentId = user.id
  → embedQuery(userText) → match_document_chunks RPC
  → 0 chunks  → hard-coded refusal, no LLM call
  → >0 chunks → build system prompt, streamText, stream response

lib/ai/ingest-pipeline.ts   — shared chunking/embedding logic (upload route + CLI script)
lib/ai/embed-query.ts       — query-side embedding (RETRIEVAL_QUERY)
lib/supabase/{client,server}.ts — browser vs. server Supabase clients (publishable key, RLS-bound)
```

---

## Chunking strategy

Paragraph-first, sentence-safe, word-count-target chunking (`lib/ai/ingest-pipeline.ts`):

- Pages are extracted individually (`pdf-parse`, page-aware) so every chunk retains a real page number.
- A back-matter detector removes References/Bibliography sections at raw line granularity — this PDF format extracts as single-newline-separated lines, not blank-line-separated paragraphs, so paragraph-level heading detection silently misses the "References" boundary. Left in, citation-dense bibliography text scores competitively (sometimes higher) than body prose in cosine similarity and gets paraphrased as if it were a finding.
- A lightweight heuristic flags likely headings (short, no terminal punctuation, few words) and attaches the most recent heading as chunk metadata (`section_heading`).
- Content accumulates word-by-word; at ~500 words it flushes with a 50-word overlap carried into the next chunk.
- The flush check runs at **sentence** granularity, not paragraph granularity, because this PDF's multi-column layout merges what should be several paragraphs into one extracted blob. Checking after every sentence bounds chunk overshoot to about one sentence instead of 700–1200 words past target.
- A hard backstop (`MAX_SENTENCE_WORDS = 150`) force-splits any "sentence" longer than that into fixed word windows, for extraction garbage with no usable punctuation.

### What this chunking strategy does not handle

- **Tables** extract as word soup with no structural markers and get chunked as prose, mid-row.
- **Figures/captions** are not distinguished from body text.
- Chunking is tuned against one PDF's layout quirks (two-column academic format). A structurally different PDF (single-column, heavy tabular data, scanned images) will expose different failure modes and has not been tested against this pipeline.

---

## Hardcoded / scoped-out decisions — by design, for now

- **One document per user.** Uploading replaces the previous document's chunks entirely. There is no document library, no versioning, no ability to keep multiple documents and switch between them. If asked "does this support multiple documents per user" — no, and the change required is a real `document_id` column decoupled from `user_id`, a document-selection UI, and RLS policies keyed on document ownership rather than the user ID directly.
- **No hybrid search, no reranking.** Retrieval is pure cosine similarity, top-5, single threshold. If the best-matching embedding isn't the best answer, there is no second pass to catch it.
- **Thresholds are unvalidated.** `RETRIEVAL_THRESHOLD = 0.5` and `CONFIDENCE_THRESHOLD = 0.65` are starting points, not values tuned against a labeled eval set. In a small, topically uniform corpus, in-domain unanswerable questions and real answers can cluster in the same similarity band — the confidence gate reliably catches cross-domain rejection but cannot reliably distinguish in-domain gaps from genuine answers. That's a generation-layer instruction backstop, not a code-level guarantee, and it should be described as such.

---

## Reliability behavior that IS implemented

- **Retrieval fails before the stream opens, not during it.** Query embedding and the retrieval RPC both run before `createUIMessageStream` is invoked in `/api/chat`. A failure returns a normal HTTP error (429/500/503) instead of corrupting an in-progress stream — a real production concern, not hypothetical, since a mid-stream failure leaves the client UI in an unrecoverable state.
- **429s are classified, not treated uniformly.** Both `embed-query.ts` and `ingest-pipeline.ts` distinguish quota-exhaustion 429s (retrying is pointless until quota resets) from rate-limit 429s (retryable with backoff) by inspecting the response body.
- **`maxRetries: 0` is set explicitly on every `embed()` call.** The AI SDK has its own internal retry logic; without disabling it, a custom retry loop and the SDK's retry loop stack multiply the number of calls made per failure silently.
- **Ingestion is resumable.** The CLI script checks existing `chunk_index` values before embedding, so an interrupted run doesn't re-embed (and re-pay for) chunks that already succeeded.
- **Upload concurrency is guarded.** `upload_locks` prevents two concurrent uploads for the same user from corrupting each other, with a compare-and-swap steal mechanism for locks left stale by a killed serverless function (threshold set above the route's own `maxDuration` plus round-trip margin, so a legitimately still-running upload can't have its lock stolen out from under it).
- **Upload ordering avoids the worst failure mode, not all of them.** Extraction/chunking runs and is validated non-empty _before_ the old document is deleted — a bad upload no longer destroys a working document. It does not eliminate a narrower failure: the embed-and-insert loop can still fail partway through _after_ the delete, leaving a degraded document (old data gone, new data incomplete). Documented, not solved — the real fix is ingest-to-a-new-ID with an atomic swap, or a Postgres transaction via RPC.

## Reliability behavior that is NOT implemented

- No caching of embeddings or repeated query results.
- No rate limiting on `/api/chat` or `/api/upload` — nothing stops a client from hammering either and running up the Gemini bill. Low-stakes on free tier; not acceptable with real users.
- No observability — no structured logging of retrieval quality, latency, or per-request cost. If this were failing for real users right now, there is no way to see it happening.
- No async job processing for uploads. `/api/upload` is a single synchronous request capped at `maxDuration = 60`; a large document with rate-limit backoff mid-ingestion can time out. Real fix is background job processing or batched parallel embedding (the latter trades timeout risk for harder rate-limit pressure).
- No load or concurrency testing beyond the single-user upload lock.
- No automated retrieval quality evaluation. Confidence in the 0.5/0.65 thresholds is manual spot-checking, not measurement — say that plainly if asked how you know this works.

---

## Security notes

- All auth checks use `getUser()`, never `getSession()`, in every place a request is authorized (middleware, page, both API routes). `getSession()` only decodes the session cookie without validating it against Supabase's auth server; a replayed or tampered token would pass silently. `getUser()` round-trips to verify the token every time.
- Client-side password strength rules in `app/auth/page.tsx` are UX only — they gate a button, nothing more. A request sent directly to Supabase's REST API bypasses them entirely. The actual enforcement boundary is Supabase Auth's server-side password policy (Dashboard → Authentication → Policies); verify it's configured before claiming password requirements are enforced.
- Client-side file type/size checks on upload are a UX fast-path, not a security control — trivially bypassed. The server-side checks in `/api/upload` are the real gate, and even those trust the client-supplied MIME type for fast rejection rather than sniffing magic bytes; MIME type is spoofable.
- `document_id` in `/api/chat` is always derived from the verified session (`user.id`), never accepted from the request body — a client cannot address another user's document by forging a parameter. See the RLS/`SECURITY DEFINER` verification note under Setup for what actually enforces that at the database layer.

---

## Known open issues

- A corrupted row from an earlier (Week 4) exercise exists in a separate Supabase project — source file was deleted but the database row was not cleaned up. Unrelated to this project's data; flagged here as an open item rather than swept under the rug.
- The upload path's partial-failure window (embed loop fails after delete) remains unresolved — see Reliability above.
