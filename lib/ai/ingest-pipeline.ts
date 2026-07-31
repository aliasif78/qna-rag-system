// Must be imported before "pdf-parse" — registers the canvas polyfill
// (DOMMatrix, Path2D, etc.) that pdf-parse's PDFParse constructor needs
// in serverless/Vercel environments where these globals don't exist natively.
import { CanvasFactory } from 'pdf-parse/worker';
import { PDFParse } from 'pdf-parse';
import { embed, APICallError } from 'ai';
import { google } from '@ai-sdk/google';

// ---------- Constants (exported so callers can reference them in logs/assertions) ----------

export const EMBEDDING_DIMENSIONS = 768;
export const CHUNK_WORD_TARGET = 500;
export const CHUNK_WORD_OVERLAP = 50;
export const MAX_EMBED_RETRIES = 5;

// Hard ceiling on a single "sentence" fragment. Real prose sentences run
// 10–40 words. Anything past this is not a sentence — it's PDF extraction
// garbage (missing punctuation, merged columns, a run-on the regex failed
// to split). Without this cap, one pathological fragment can reproduce the
// 700–1200 word overshoot bug at the sentence level instead of the paragraph
// level.
export const MAX_SENTENCE_WORDS = 150;

// ---------- Types ----------

export interface PageText {
  pageNumber: number;
  text: string;
}

export interface Paragraph {
  pageNumber: number;
  text: string;
  isLikelyHeading: boolean;
}

export interface Chunk {
  content: string;
  chunkIndex: number;
  pageNumber: number;
  sectionHeading: string | null;
}

// ---------- Utilities ----------

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------- PDF extraction (page-aware) ----------

// Takes a Buffer — NOT a file path. The caller is responsible for reading
// the file or receiving it from a request. This keeps the function usable
// in both CLI and API route contexts without coupling it to the filesystem.
export async function extractPages(buffer: Buffer): Promise<PageText[]> {
  const parser = new PDFParse({ data: buffer, CanvasFactory });

  try {
    const info = await parser.getInfo();
    const totalPages = info.total;

    if (!totalPages || totalPages === 0) {
      throw new Error('PDF reports zero pages. File may be corrupt or unreadable.');
    }

    const pages: PageText[] = [];

    for (let pageNumber = 1; pageNumber <= totalPages; pageNumber++) {
      const result = await parser.getText({ partial: [pageNumber] });
      if (!result.text.trim()) {
        console.warn(`Page ${pageNumber} extracted empty text — may be image-based/scanned.`);
      }
      pages.push({ pageNumber, text: result.text });
    }

    return pages;
  } finally {
    await parser.destroy();
  }
}

// ---------- Back-matter detection ----------

// Academic papers end with a References/Bibliography section: entries that
// are dense with domain vocabulary (condition names, author names, paper
// titles) and score competitively — sometimes higher — in cosine similarity
// than body prose, while containing zero synthesized findings. Left in the
// corpus they get retrieved and the downstream model paraphrases citation
// titles as if they were the review's own conclusions.
//
// Detection must happen at raw-line granularity BEFORE splitIntoParagraphs.
// Verified against this PDF's actual extraction output: the References page
// has no blank-line separators — every line ends in \r\n, so
// splitIntoParagraphs's \n{2,} regex never fires, and a paragraph-level
// check would miss the heading entirely.
//
// Heuristic, not a guarantee. Assumes: single heading, alone on its own
// line, one of these three English headings, and everything after it is
// back matter. Multi-article PDFs would need a different approach.
const BACK_MATTER_HEADING = /^(references|bibliography|works cited)$/i;

export function stripBackMatter(pages: PageText[]): PageText[] {
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const lines = pages[pageIdx].text.split(/\r?\n/);
    const lineIdx = lines.findIndex((line) => BACK_MATTER_HEADING.test(line.trim()));

    if (lineIdx === -1) continue;

    console.warn(`Back matter detected on page ${pages[pageIdx].pageNumber} ("${lines[lineIdx].trim()}"). ` + `Truncating at line ${lineIdx} and dropping ${pages.length - pageIdx - 1} page(s) after it.`);

    const truncatedPage: PageText = {
      pageNumber: pages[pageIdx].pageNumber,
      text: lines.slice(0, lineIdx).join('\n'),
    };

    return [...pages.slice(0, pageIdx), truncatedPage];
  }

  console.warn('No "References"/"Bibliography"/"Works Cited" heading found — nothing stripped. ' + 'Verify the document does not have a reference list that was missed.');
  return pages;
}

// ---------- Paragraph splitting ----------

export function splitIntoParagraphs(pages: PageText[]): Paragraph[] {
  const paragraphs: Paragraph[] = [];

  for (const page of pages) {
    const rawParagraphs = page.text
      .split(/\n{2,}|(?<=[.?!])\s{2,}/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0);

    for (const p of rawParagraphs) {
      const isLikelyHeading = p.length < 80 && !/[.,;:]$/.test(p) && p.split(' ').length <= 10;
      paragraphs.push({ pageNumber: page.pageNumber, text: p, isLikelyHeading });
    }
  }

  return paragraphs;
}

// ---------- Chunking ----------

// Splits a word array into fixed-size windows. Backstop for extraction
// garbage that has no punctuation to split on: without this, a single
// malformed "sentence" can reproduce the original 700–1200 word overshoot
// bug at sentence granularity.
function splitLongFragment(words: string[], maxWords: number): string[][] {
  if (words.length <= maxWords) return [words];
  const windows: string[][] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    windows.push(words.slice(i, i + maxWords));
  }
  return windows;
}

// Flush condition runs at sentence granularity, not paragraph granularity.
// This PDF's 2-column layout produces merged "paragraphs" that are actually
// several real paragraphs glued together. Checking after each sentence bounds
// overshoot to ~1 sentence rather than ~1 merged blob.
export function chunkParagraphs(paragraphs: Paragraph[]): Chunk[] {
  const chunks: Chunk[] = [];
  let currentWords: string[] = [];
  let currentPageNumber: number | null = null;
  let currentHeading: string | null = null;
  let activeHeading: string | null = null;
  let chunkIndex = 0;

  const flush = () => {
    if (currentWords.length === 0) return;
    chunks.push({
      content: currentWords.join(' '),
      chunkIndex,
      pageNumber: currentPageNumber ?? 1,
      sectionHeading: currentHeading,
    });
    chunkIndex++;
  };

  for (const paragraph of paragraphs) {
    if (paragraph.isLikelyHeading) {
      activeHeading = paragraph.text;
      continue;
    }

    if (currentPageNumber === null) {
      currentPageNumber = paragraph.pageNumber;
      currentHeading = activeHeading;
    }

    const sentences = paragraph.text.split(/(?<=[.?!])\s+/).filter(Boolean);

    for (const sentence of sentences) {
      const rawWords = sentence.split(/\s+/).filter(Boolean);
      const wordGroups = splitLongFragment(rawWords, MAX_SENTENCE_WORDS);

      for (const words of wordGroups) {
        currentWords.push(...words);

        if (currentWords.length >= CHUNK_WORD_TARGET) {
          flush();
          const overlapWords = currentWords.slice(-CHUNK_WORD_OVERLAP);
          currentWords = [...overlapWords];
          currentPageNumber = paragraph.pageNumber;
          currentHeading = activeHeading;
        }
      }
    }
  }

  flush();

  return chunks;
}

// ---------- Embedding ----------

type EmbedErrorClass = 'rate_limited' | 'quota_exhausted' | 'other';

function classifyEmbedError(err: unknown): EmbedErrorClass {
  if (APICallError.isInstance(err) && err.statusCode === 429) {
    const body = typeof err.responseBody === 'string' ? err.responseBody.toLowerCase() : '';
    if (body.includes('quota')) return 'quota_exhausted';
    return 'rate_limited';
  }
  return 'other';
}

// RETRIEVAL_DOCUMENT task type is mandatory here. RETRIEVAL_QUERY is for
// the search side. A mismatch degrades retrieval silently — no error thrown,
// scores just drop. Do not change this without also changing embedQuery.ts.
export async function embedWithRetry(text: string): Promise<number[]> {
  let attempt = 0;

  while (true) {
    try {
      const { embedding } = await embed({
        model: google.embeddingModel('gemini-embedding-001'),
        value: text,
        maxRetries: 0, // we own retry/backoff explicitly
        providerOptions: {
          google: {
            outputDimensionality: EMBEDDING_DIMENSIONS,
            taskType: 'RETRIEVAL_DOCUMENT',
          },
        },
      });

      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${embedding.length}. ` + `outputDimensionality may not be honoured by the current SDK/provider version.`);
      }

      return embedding;
    } catch (err: unknown) {
      const classification = classifyEmbedError(err);

      if (classification === 'quota_exhausted') {
        throw new Error(`Quota exhausted — retrying will not help until quota resets. ${errorMessage(err)}`);
      }

      attempt++;

      if (classification !== 'rate_limited' || attempt >= MAX_EMBED_RETRIES) {
        throw err;
      }

      const delayMs = Math.min(1000 * 2 ** attempt, 30000);
      console.warn(`Embed rate-limited (attempt ${attempt}/${MAX_EMBED_RETRIES}). Retrying in ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }
}
