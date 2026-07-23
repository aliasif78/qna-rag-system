import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env.local') });

import { readFile } from 'fs/promises';
import { PDFParse } from 'pdf-parse';
import { createClient } from '@supabase/supabase-js';
import { embed, APICallError } from 'ai';
import { google } from '@ai-sdk/google';

// ---------- Config ----------

const EMBEDDING_DIMENSIONS = 768;
const CHUNK_WORD_TARGET = 500;
const CHUNK_WORD_OVERLAP = 50;
const MAX_EMBED_RETRIES = 5;

// Hard ceiling on a single "sentence" fragment. Real prose sentences run
// 10-40 words. Anything past this is not a sentence — it's PDF extraction
// garbage (missing punctuation, merged columns, a run-on the regex failed
// to split). Without this cap, one pathological fragment can reproduce the
// exact 700-1200 word overshoot bug this file was rewritten to fix, just
// at the sentence level instead of the paragraph level.
const MAX_SENTENCE_WORDS = 150;

interface CliArgs {
  filePath: string;
  documentId: string;
}

function parseCliArgs(): CliArgs {
  const args = process.argv.slice(2);
  const fileFlagIndex = args.indexOf('--file');
  const docIdFlagIndex = args.indexOf('--document-id');

  if (fileFlagIndex === -1 || docIdFlagIndex === -1) {
    console.error('Usage: tsx scripts/ingest.ts --file <path> --document-id <id>');
    process.exit(1);
  }

  const filePath = args[fileFlagIndex + 1];
  const documentId = args[docIdFlagIndex + 1];

  if (!filePath || !documentId) {
    console.error('Missing value for --file or --document-id');
    process.exit(1);
  }

  return { filePath, documentId };
}

// ---------- Env validation ----------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const SUPABASE_SECRET_KEY = requireEnv('SUPABASE_SECRET_KEY');
requireEnv('GOOGLE_GENERATIVE_AI_API_KEY');

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// ---------- PDF extraction (page-aware) ----------

interface PageText {
  pageNumber: number;
  text: string;
}

async function extractPages(filePath: string): Promise<PageText[]> {
  const buffer = await readFile(filePath);
  const parser = new PDFParse({ data: buffer });

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

// ---------- Chunking (paragraph-aware, sentence-safe, word-based, with overlap) ----------

interface Paragraph {
  pageNumber: number;
  text: string;
  isLikelyHeading: boolean;
}

interface Chunk {
  content: string;
  chunkIndex: number;
  pageNumber: number;
  sectionHeading: string | null;
}

function splitIntoParagraphs(pages: PageText[]): Paragraph[] {
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

// This PDF's 2-column academic layout does not survive pdf-parse extraction
// with clean double-newline paragraph breaks. splitIntoParagraphs's regex
// then fails silently: instead of raising an error, it just hands back a
// small number of "paragraphs" that are actually several real paragraphs
// glued together. The original version of this function appended an entire
// paragraph's words to the buffer BEFORE checking the flush condition, so a
// single one of these merged blobs could blow straight past
// CHUNK_WORD_TARGET by 2-3x before anything stopped it — confirmed in
// production data as 700-1200 word chunks against a 500-word target.
//
// Fix: check the flush condition at sentence granularity, not paragraph
// granularity. A merged 1000-word "paragraph" is still made of ~40-word
// sentences, so checking after each sentence bounds the overshoot to
// ~1 sentence's length instead of ~1 paragraph's length. MAX_SENTENCE_WORDS
// then catches the residual case where even a "sentence" (extraction
// garbage with no usable punctuation) is itself pathologically long, by
// force-splitting it into fixed-size word windows rather than trusting
// punctuation at all.
function splitLongFragment(words: string[], maxWords: number): string[][] {
  if (words.length <= maxWords) return [words];
  const windows: string[][] = [];
  for (let i = 0; i < words.length; i += maxWords) {
    windows.push(words.slice(i, i + maxWords));
  }
  return windows;
}

// Academic papers end with a References/Bibliography section: dozens of
// entries like "175. Kadi, F.; Eriksson, A. Effects of anabolic steroids on
// the muscle cells of strength-trained athletes. Med. Sci. Sports Exerc.
// 1999..." These are dense with exactly the domain vocabulary a real query
// uses (condition names, author names, topic words in paper titles), which
// makes them score competitively — sometimes HIGHER — than actual body
// prose in cosine similarity, while containing zero synthesized findings.
// Left in the corpus, they get retrieved, and a downstream model will
// paraphrase a citation's TITLE as if it were the review's own conclusion.
// This is a content-type problem, not a similarity-threshold problem — no
// amount of threshold tuning fixes a bibliography entry outscoring the real
// answer.
//
// Detection MUST happen on raw page text, at line granularity, BEFORE
// splitIntoParagraphs runs. Confirmed against this PDF's actual extraction
// output: the page containing "References" has no blank-line separators at
// all — every line ends in a single \r\n, including the line break right
// before and after the heading itself. splitIntoParagraphs's regex
// (\n{2,} or punctuation + 2 spaces) never fires here, so "References"
// would be silently merged into one large paragraph with the surrounding
// text and an exact-match check against a paragraph string would never
// trigger. Checking raw lines sidesteps that entirely.
//
// This is a heuristic, not a guarantee: it assumes (a) the paper has
// exactly one such heading, (b) it appears alone on its own line, (c) it
// uses one of these three conventional English headings, and (d) once
// found, EVERYTHING from that line to the end of the document is back
// matter (true for a single-article PDF; would be wrong for a PDF
// containing multiple concatenated articles). Papers with unconventional
// structure will not be caught by this and need manual review. Known
// limitation to revisit in Week 6 when ingesting other documents.
const BACK_MATTER_HEADING = /^(references|bibliography|works cited)$/i;

function stripBackMatter(pages: PageText[]): PageText[] {
  for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
    const lines = pages[pageIdx].text.split(/\r?\n/);
    const lineIdx = lines.findIndex((line) => BACK_MATTER_HEADING.test(line.trim()));

    if (lineIdx === -1) continue;

    console.log(`Back matter detected on page ${pages[pageIdx].pageNumber} ("${lines[lineIdx].trim()}"). Truncating this page there and dropping all ${pages.length - pageIdx - 1} page(s) after it entirely.`);

    const truncatedPage: PageText = {
      pageNumber: pages[pageIdx].pageNumber,
      text: lines.slice(0, lineIdx).join('\n'),
    };

    return [...pages.slice(0, pageIdx), truncatedPage];
  }

  console.warn('No "References"/"Bibliography"/"Works Cited" heading found on any page — nothing stripped. If this document has a reference list, verify it was not silently missed.');
  return pages;
}

function chunkParagraphs(paragraphs: Paragraph[]): Chunk[] {
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

    // Split at sentence granularity so a single oversized "paragraph"
    // (merged by a bad PDF extraction) can't blow past target in one shot.
    const sentences = paragraph.text.split(/(?<=[.?!])\s+/).filter(Boolean);

    for (const sentence of sentences) {
      const rawWords = sentence.split(/\s+/).filter(Boolean);

      // Hard guard: force-split any single fragment longer than
      // MAX_SENTENCE_WORDS into fixed-size word windows. This is the
      // backstop for extraction garbage that has no punctuation to
      // split on at all — without it, one malformed "sentence" can
      // still reproduce the original overshoot bug.
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

// ---------- Embedding with retry/backoff, distinguishing rate-limit vs quota ----------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

type EmbedErrorClass = 'rate_limited' | 'quota_exhausted' | 'other';

function classifyEmbedError(err: unknown): EmbedErrorClass {
  if (APICallError.isInstance(err) && err.statusCode === 429) {
    const body = typeof err.responseBody === 'string' ? err.responseBody.toLowerCase() : '';
    if (body.includes('quota')) return 'quota_exhausted';
    return 'rate_limited';
  }
  return 'other';
}

async function embedWithRetry(text: string): Promise<number[]> {
  let attempt = 0;

  while (true) {
    try {
      const { embedding } = await embed({
        model: google.embeddingModel('gemini-embedding-001'),
        value: text,
        maxRetries: 0, // disable SDK's internal retry — we own retry/backoff explicitly below
        providerOptions: {
          google: {
            outputDimensionality: EMBEDDING_DIMENSIONS,
            taskType: 'RETRIEVAL_DOCUMENT',
          },
        },
      });

      if (embedding.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${embedding.length}. outputDimensionality may not be respected by the current AI SDK/provider version — do not proceed with ingestion.`);
      }

      return embedding;
    } catch (err: unknown) {
      const classification = classifyEmbedError(err);

      if (classification === 'quota_exhausted') {
        throw new Error(`Quota exhausted — stopping ingestion, retrying will not help until quota resets. ${errorMessage(err)}`);
      }

      attempt++;

      if (classification !== 'rate_limited' || attempt >= MAX_EMBED_RETRIES) {
        throw err;
      }

      const delayMs = Math.min(1000 * 2 ** attempt, 30000);
      console.warn(`Rate limited (attempt ${attempt}/${MAX_EMBED_RETRIES}). Backing off ${delayMs}ms.`);
      await sleep(delayMs);
    }
  }
}

// ---------- Supabase upsert ----------

interface DocumentChunkRow {
  document_id: string;
  content: string;
  embedding: number[];
  chunk_index: number;
  page_number: number;
  section_heading: string | null;
}

async function upsertChunk(row: DocumentChunkRow): Promise<void> {
  const { error } = await supabase.from('document_chunks').upsert(row, { onConflict: 'document_id,chunk_index' });

  if (error) {
    throw new Error(`Supabase upsert failed for chunk_index ${row.chunk_index}: ${error.message}`);
  }
}

async function getExistingChunkIndices(documentId: string): Promise<Set<number>> {
  const { data, error } = await supabase.from('document_chunks').select('chunk_index').eq('document_id', documentId);

  if (error) {
    throw new Error(`Failed to check existing chunks: ${error.message}`);
  }

  return new Set(data.map((row) => row.chunk_index as number));
}

// ---------- Main ----------

async function main(): Promise<void> {
  const { filePath, documentId } = parseCliArgs();
  const startedAt = Date.now();

  console.log(`Extracting text from ${filePath}...`);
  const pages = await extractPages(filePath);
  console.log(`Extracted ${pages.length} pages.`);

  const contentPages = stripBackMatter(pages);
  const paragraphs = splitIntoParagraphs(contentPages);
  const chunks = chunkParagraphs(paragraphs);
  console.log(`Built ${chunks.length} chunks (target ${CHUNK_WORD_TARGET} words, ${CHUNK_WORD_OVERLAP} word overlap, ${MAX_SENTENCE_WORDS} word sentence cap).`);

  const existingIndices = await getExistingChunkIndices(documentId);
  console.log(`${existingIndices.size} chunks already ingested. ${chunks.length - existingIndices.size} remaining.`);

  let succeeded = 0;
  let skipped = 0;
  let failed = 0;

  for (const chunk of chunks) {
    if (existingIndices.has(chunk.chunkIndex)) {
      skipped++;
      console.log(`Chunk ${chunk.chunkIndex + 1}/${chunks.length} already exists, skipping.`);
      continue;
    }

    try {
      const embedding = await embedWithRetry(chunk.content);
      await upsertChunk({
        document_id: documentId,
        content: chunk.content,
        embedding,
        chunk_index: chunk.chunkIndex,
        page_number: chunk.pageNumber,
        section_heading: chunk.sectionHeading,
      });
      succeeded++;
      console.log(`Chunk ${chunk.chunkIndex + 1}/${chunks.length} ingested (page ${chunk.pageNumber}).`);
    } catch (err: unknown) {
      failed++;
      console.error(`Chunk ${chunk.chunkIndex} FAILED: ${errorMessage(err)}`);
    }
  }

  const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log('--- Ingestion summary ---');
  console.log(`Document ID: ${documentId}`);
  console.log(`Chunks succeeded this run: ${succeeded}`);
  console.log(`Chunks skipped (already ingested): ${skipped}`);
  console.log(`Chunks failed: ${failed}`);
  console.log(`Total chunks now stored: ${succeeded + skipped}/${chunks.length}`);
  console.log(`Elapsed: ${elapsedSeconds}s`);

  if (failed > 0) {
    console.error('Ingestion completed with failures. Corpus is incomplete — do not proceed to retrieval testing until this is resolved.');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Ingestion aborted:', errorMessage(err));
  process.exit(1);
});
