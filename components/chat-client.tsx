// app/chat-client.tsx

'use client';

import { useRouter } from 'next/navigation';
import { createSupabaseBrowserClient } from '@/lib/supabase/client';

import { useEffect, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport } from 'ai';

interface CitationChunk {
  id: number;
  content: string;
  pageNumber: number;
  chunkIndex: number;
  sectionHeading: string | null;
  similarity: number;
}

// Upload lifecycle. 'uploading' is deliberately NOT called 'progress' —
// fetch() gives no upload-progress events. A percentage would require
// XMLHttpRequest, and even then the bar would hit 100% the instant the bytes
// land and then sit there for the entire embed loop, which is the slow part.
// An indeterminate state is the honest representation.
type UploadState = 'idle' | 'uploading' | 'success' | 'error';

// Deterministic PRNG so server-rendered and client-hydrated star positions
// match exactly. Math.random() here would cause a hydration mismatch on every
// load — the same class of bug as the one this file was restructured to fix.
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function useStars(count: number) {
  const rand = mulberry32(1337);
  return Array.from({ length: count }, (_, i) => ({
    id: i,
    top: rand() * 100,
    left: rand() * 100,
    size: rand() * 1.6 + 0.6,
    delay: rand() * 6,
    duration: rand() * 3 + 3,
  }));
}

// Document-agnostic. Any user can upload any PDF, so prompts naming a subject
// would be wrong for most documents — the same reason the chat route's system
// prompt no longer names one.
const EXAMPLE_PROMPTS = ['What are the main conclusions?', 'Summarise the key findings.', 'What questions does this document not answer?'];

// Mirrors MAX_FILE_SIZE_BYTES in app/api/upload/route.ts. Duplicated
// intentionally: a UX fast-path so the user isn't made to upload 40MB before
// being told no. The server check is the real gate — this one is trivially
// bypassed and is not a security control.
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export default function ChatClient({ initialChunkCount, statusUnavailable }: { initialChunkCount: number; statusUnavailable: boolean }) {
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const stars = useStars(90);

  const router = useRouter();

  // Seeded from the server, then updated locally on upload. The upload
  // response returns the new count, so there is nothing to re-fetch.
  const [chunkCount, setChunkCount] = useState(initialChunkCount);
  const [uploadState, setUploadState] = useState<UploadState>('idle');
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [lastIngested, setLastIngested] = useState<number | null>(null);
  // Forces the upload panel even when a document exists. Kept separate from
  // chunkCount so cancelling a replace restores real state instead of having
  // destroyed it.
  const [replacing, setReplacing] = useState(false);

  const { messages, sendMessage, status, error } = useChat({
    transport: new DefaultChatTransport({ api: '/api/chat' }),
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: 'smooth',
    });
  }, [messages, status]);

  // Session-expiry watchdog. NOT the security boundary — proxy.ts runs
  // getUser() server-side on '/' and the Server Component above re-checks
  // before rendering. This only catches a session dying while the tab is open.
  // No setState in the effect body: it navigates or does nothing.
  useEffect(() => {
    let cancelled = false;

    createSupabaseBrowserClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!cancelled && !data.user) router.replace('/auth');
      });

    return () => {
      cancelled = true;
    };
  }, [router]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push('/auth');
    router.refresh();
    // router.refresh() clears the Next.js router cache so middleware
    // re-evaluates auth on the next navigation. Without it a cached '/' render
    // can flash before the redirect completes.
  }

  function startReplace() {
    setReplacing(true);
    setUploadState('idle');
    setUploadError(null);
  }

  function cancelReplace() {
    setReplacing(false);
    setUploadState('idle');
    setUploadError(null);
  }

  async function handleFileSelected(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];

    // Reset immediately. Without this, selecting the same file twice fires no
    // change event, so retrying after a failed upload silently dead-ends.
    e.target.value = '';

    if (!file) return;

    if (file.type !== 'application/pdf') {
      setUploadState('error');
      setUploadError(`Invalid file type: "${file.type || 'unknown'}". Only PDF is accepted.`);
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      setUploadState('error');
      setUploadError(`File too large: ${(file.size / 1024 / 1024).toFixed(1)}MB. Maximum is 20MB.`);
      return;
    }

    setUploadState('uploading');
    setUploadError(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
        // No Content-Type header. Setting it manually omits the multipart
        // boundary and the server's formData() parse fails.
      });

      if (res.status === 401) {
        router.replace('/auth');
        return;
      }

      // The route can fail after partially writing chunks; its 500 body
      // carries chunksIngested. Surface it — "upload failed" while the
      // previous document has already been deleted is a state the user needs
      // to understand, not a generic error.
      const data = (await res.json().catch(() => null)) as { chunksIngested?: number; error?: string } | null;

      if (!res.ok) {
        const partial = typeof data?.chunksIngested === 'number' ? ` (${data.chunksIngested} chunks were stored — the document is incomplete and must be re-uploaded)` : '';
        setUploadState('error');
        setUploadError((data?.error ?? `Upload failed with status ${res.status}.`) + partial);
        // The old document was deleted server-side before ingestion began, so
        // there is no usable document now regardless of what was there before.
        setChunkCount(0);
        return;
      }

      const ingested = data?.chunksIngested ?? 0;

      if (ingested === 0) {
        setUploadState('error');
        setUploadError('Server reported 0 chunks ingested. The document is not queryable.');
        setChunkCount(0);
        return;
      }

      setUploadState('success');
      setLastIngested(ingested);
      setChunkCount(ingested);
      setReplacing(false);
    } catch (err) {
      setUploadState('error');
      setUploadError(err instanceof Error ? err.message : 'Upload failed — could not reach the server.');
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = input.trim();
    if (!trimmed || status === 'streaming' || status === 'submitted') return;
    sendMessage({ text: trimmed });
    setInput('');
  }

  function handleExample(prompt: string) {
    if (status === 'streaming' || status === 'submitted') return;
    sendMessage({ text: prompt });
  }

  const busy = status === 'streaming' || status === 'submitted';
  const uploading = uploadState === 'uploading';
  const hasDocument = chunkCount > 0;
  const showUploadPanel = !hasDocument || replacing;
  // Gate the chat on document presence. Querying with zero chunks guarantees
  // either an ungrounded answer or a hard refusal from the chat route.
  const chatDisabled = busy || !hasDocument;

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-black">
      {/* ---------- Aurora + starfield background ---------- */}
      <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        <div className="aurora aurora-a" />
        <div className="aurora aurora-b" />
        <div className="aurora aurora-c" />
        <div className="stars">
          {stars.map((s) => (
            <span
              key={s.id}
              className="star"
              style={{
                top: `${s.top}%`,
                left: `${s.left}%`,
                width: `${s.size}px`,
                height: `${s.size}px`,
                animationDelay: `${s.delay}s`,
                animationDuration: `${s.duration}s`,
              }}
            />
          ))}
        </div>
        <div className="vignette" />
      </div>

      {/* ---------- Header ---------- */}
      <header className="relative z-10 flex items-center justify-between gap-4 border-b border-white/10 bg-black/40 px-6 py-4 backdrop-blur-sm">
        <div className="min-w-0">
          <p className="mono text-[11px] tracking-[0.2em] text-sky-400/90 uppercase">RAG · Grounded Answers</p>
          <h1 className="sans mt-0.5 truncate text-lg font-semibold text-white">Document Q&amp;A</h1>
        </div>

        <div className="flex shrink-0 items-center gap-3">
          <div className="mono hidden items-center gap-2 text-[11px] tracking-wide text-white/70 uppercase sm:flex">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-sky-400" />
            </span>
            Live
          </div>

          {hasDocument && !replacing && (
            <button onClick={startReplace} className="mono cursor-pointer rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/30 hover:text-white">
              Replace document
            </button>
          )}

          <button onClick={handleSignOut} className="mono cursor-pointer rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/70 transition-colors hover:border-white/30 hover:text-white">
            Sign out
          </button>
        </div>
      </header>

      {/* ---------- Messages ---------- */}
      <div ref={scrollRef} className="relative z-10 flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex max-w-2xl flex-col gap-5">
          {messages.length === 0 && showUploadPanel && (
            <div className="fade-up mt-16 flex flex-col items-center gap-5 text-center">
              <div className="w-full max-w-md rounded-xl border border-white/10 bg-white/5 p-6 backdrop-blur-sm">
                <h2 className="sans text-base font-semibold text-white">{replacing ? 'Replace your document' : 'Upload a document to begin'}</h2>
                <p className="sans mt-2 text-sm leading-relaxed text-white/70">A single PDF, up to 20MB. It is parsed, chunked, and embedded on upload — expect this to take a while for longer documents.</p>

                {statusUnavailable && !replacing && <p className="sans mt-3 text-xs leading-relaxed text-orange-400">Could not read your document status. If you have already uploaded a document it may still be there — reload before re-uploading, since uploading deletes existing chunks first.</p>}

                {replacing && <p className="sans mt-3 text-xs leading-relaxed text-orange-400">Uploading a new file permanently deletes your current document&apos;s chunks before ingesting. If ingestion fails partway, the old document is not recoverable.</p>}

                <input ref={fileInputRef} type="file" accept="application/pdf" onChange={handleFileSelected} className="hidden" />

                <div className="mt-5 flex flex-col items-center gap-3">
                  <button onClick={() => fileInputRef.current?.click()} disabled={uploading} className="mono cursor-pointer rounded-lg border border-sky-400/30 bg-sky-400/10 px-5 py-2.5 text-sm font-medium text-sky-300 transition-all hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-sky-400/10">
                    {uploading ? 'Uploading and ingesting…' : 'Upload PDF'}
                  </button>

                  {uploading && (
                    <div className="flex items-center gap-2">
                      <span className="mono text-xs text-white/60">Parsing, chunking, embedding</span>
                      <span className="flex gap-1">
                        <span className="dot" style={{ animationDelay: '0s' }} />
                        <span className="dot" style={{ animationDelay: '0.15s' }} />
                        <span className="dot" style={{ animationDelay: '0.3s' }} />
                      </span>
                    </div>
                  )}

                  {uploadState === 'error' && uploadError && <p className="sans max-w-sm text-sm leading-relaxed text-orange-400">{uploadError}</p>}

                  {replacing && !uploading && (
                    <button onClick={cancelReplace} className="mono cursor-pointer text-xs text-white/60 underline-offset-4 transition-colors hover:text-white/90 hover:underline">
                      Cancel
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {messages.length === 0 && !showUploadPanel && (
            <div className="fade-up mt-16 flex flex-col items-center gap-6 text-center">
              {uploadState === 'success' && lastIngested !== null && <p className="mono text-xs text-sky-400">Document ingested — {lastIngested} chunks indexed.</p>}

              <p className="sans max-w-sm text-sm leading-relaxed text-white/70">Ask a question about your document. Every answer is grounded in retrieved chunks — you&apos;ll see exactly which passages it came from.</p>

              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-center">
                {EXAMPLE_PROMPTS.map((p) => (
                  <button key={p} onClick={() => handleExample(p)} className="sans cursor-pointer rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs text-white/85 transition-all hover:border-sky-400/40 hover:bg-sky-400/10 hover:text-white">
                    {p}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message) => {
            const isUser = message.role === 'user';
            return (
              <div key={message.id} className={`fade-up flex flex-col ${isUser ? 'items-end' : 'items-start'}`}>
                <span className={`mono mb-1.5 text-[10px] tracking-[0.15em] uppercase ${isUser ? 'text-orange-400/90' : 'text-sky-400/90'}`}>{isUser ? 'You' : 'Assistant'}</span>

                <div className={`max-w-[85%] space-y-3 ${isUser ? '' : 'w-full'}`}>
                  {message.parts.map((part, i) => {
                    if (part.type === 'data-citations') {
                      const { chunks, lowConfidence } = part.data as {
                        chunks: CitationChunk[];
                        lowConfidence: boolean;
                      };
                      return (
                        <div key={i} className="rounded-lg border border-white/10 bg-white/5 p-3.5 backdrop-blur-sm">
                          {chunks.length === 0 ? (
                            <p className="sans flex items-center gap-2 text-sm font-medium text-orange-400">
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" />
                              No relevant chunks found above the similarity threshold — this answer is not grounded in the document.
                            </p>
                          ) : (
                            <>
                              {lowConfidence && (
                                <p className="sans mb-2.5 flex items-center gap-2 text-xs font-medium text-orange-400">
                                  <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-400" />
                                  Low-confidence match — retrieved passages are only weakly similar to this question. Treat this answer with extra scrutiny.
                                </p>
                              )}
                              <p className="mono mb-2.5 text-[10px] tracking-[0.15em] text-white/60 uppercase">Sources</p>
                              <ul className="space-y-3">
                                {chunks.map((c) => (
                                  <li key={c.id} className="text-xs">
                                    <div className="mono mb-1 flex items-center justify-between text-[10px] text-white/60">
                                      <span>page {c.pageNumber}</span>
                                      <span>{c.similarity.toFixed(3)}</span>
                                    </div>
                                    <div className="mb-1.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
                                      <div className="h-full rounded-full bg-linear-to-r from-sky-400 to-orange-400" style={{ width: `${Math.min(c.similarity * 100, 100)}%` }} />
                                    </div>
                                    <p className="sans line-clamp-2 text-white/80">{c.content}</p>
                                  </li>
                                ))}
                              </ul>
                            </>
                          )}
                        </div>
                      );
                    }

                    if (part.type === 'text') {
                      return (
                        <p key={i} className={`sans rounded-2xl px-4 py-3 text-[15px] leading-relaxed whitespace-pre-wrap ${isUser ? 'border border-orange-400/20 bg-orange-400/8 text-white' : 'border border-sky-400/15 bg-white/5 text-white'}`}>
                          {part.text}
                        </p>
                      );
                    }

                    return null;
                  })}
                </div>
              </div>
            );
          })}

          {status === 'submitted' && (
            <div className="fade-up flex items-center gap-2 pl-1">
              <span className="mono text-xs text-white/60">Retrieving and generating</span>
              <span className="flex gap-1">
                <span className="dot" style={{ animationDelay: '0s' }} />
                <span className="dot" style={{ animationDelay: '0.15s' }} />
                <span className="dot" style={{ animationDelay: '0.3s' }} />
              </span>
            </div>
          )}

          {error && (
            <div className="fade-up rounded-lg border border-orange-400/30 bg-orange-400/8 px-4 py-3">
              <p className="sans text-sm text-orange-300">Request failed: {error.message}</p>
            </div>
          )}
        </div>
      </div>

      {/* ---------- Input ---------- */}
      <form onSubmit={handleSubmit} className="relative z-10 border-t border-white/10 bg-black/40 px-4 py-4 backdrop-blur-sm">
        <div className="mx-auto flex max-w-2xl gap-2">
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder={hasDocument ? 'Ask about your document…' : 'Upload a document to start asking questions'} className="sans flex-1 rounded-lg border border-white/15 bg-white/5 px-4 py-2.5 text-[15px] text-white transition-colors outline-none placeholder:text-white/45 focus:border-sky-400/50 disabled:cursor-not-allowed disabled:opacity-50" disabled={chatDisabled} />
          <button type="submit" disabled={chatDisabled || !input.trim()} className="mono cursor-pointer rounded-lg border border-sky-400/30 bg-sky-400/10 px-5 py-2.5 text-sm font-medium text-sky-300 transition-all hover:bg-sky-400/20 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-sky-400/10">
            Send
          </button>
        </div>
      </form>

      <style jsx global>{`
        .mono {
          font-family: var(--font-mono), ui-monospace, monospace;
        }
        .sans {
          font-family: var(--font-sans), ui-sans-serif, system-ui, sans-serif;
        }

        .aurora {
          position: absolute;
          border-radius: 50%;
          filter: blur(110px);
          mix-blend-mode: screen;
          will-change: transform, opacity;
        }
        .aurora-a {
          top: -20%;
          left: -10%;
          width: 60vw;
          height: 60vw;
          background: radial-gradient(circle, rgba(56, 189, 248, 0.35), transparent 70%);
          animation: drift-a 26s ease-in-out infinite alternate;
        }
        .aurora-b {
          top: 10%;
          right: -15%;
          width: 55vw;
          height: 55vw;
          background: radial-gradient(circle, rgba(251, 146, 60, 0.22), transparent 70%);
          animation: drift-b 32s ease-in-out infinite alternate;
        }
        .aurora-c {
          bottom: -25%;
          left: 20%;
          width: 50vw;
          height: 50vw;
          background: radial-gradient(circle, rgba(34, 211, 238, 0.2), transparent 70%);
          animation: drift-c 38s ease-in-out infinite alternate;
        }

        @keyframes drift-a {
          0% {
            transform: translate(0, 0) scale(1);
            opacity: 0.7;
          }
          100% {
            transform: translate(6%, 8%) scale(1.15);
            opacity: 0.45;
          }
        }
        @keyframes drift-b {
          0% {
            transform: translate(0, 0) scale(1);
            opacity: 0.55;
          }
          100% {
            transform: translate(-8%, 6%) scale(1.1);
            opacity: 0.3;
          }
        }
        @keyframes drift-c {
          0% {
            transform: translate(0, 0) scale(1);
            opacity: 0.5;
          }
          100% {
            transform: translate(5%, -6%) scale(1.2);
            opacity: 0.28;
          }
        }

        .stars {
          position: absolute;
          inset: 0;
        }
        .star {
          position: absolute;
          border-radius: 50%;
          background: white;
          animation-name: twinkle;
          animation-timing-function: ease-in-out;
          animation-iteration-count: infinite;
        }
        @keyframes twinkle {
          0%,
          100% {
            opacity: 0.15;
          }
          50% {
            opacity: 0.9;
          }
        }

        .vignette {
          position: absolute;
          inset: 0;
          background: radial-gradient(ellipse at center, transparent 40%, rgba(0, 0, 0, 0.6) 100%);
        }

        .fade-up {
          animation: fade-up 0.4s ease-out both;
        }
        @keyframes fade-up {
          from {
            opacity: 0;
            transform: translateY(6px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .dot {
          width: 4px;
          height: 4px;
          border-radius: 50%;
          background: rgba(255, 255, 255, 0.5);
          display: inline-block;
          animation: dot-pulse 1.2s ease-in-out infinite;
        }
        @keyframes dot-pulse {
          0%,
          80%,
          100% {
            opacity: 0.2;
          }
          40% {
            opacity: 1;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .aurora,
          .star,
          .fade-up,
          .dot {
            animation: none !important;
          }
        }
      `}</style>
    </div>
  );
}
