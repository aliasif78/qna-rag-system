import { config } from 'dotenv';
import path from 'path';
config({ path: path.resolve(process.cwd(), '.env.local') });

import { readFile } from 'fs/promises';
import { createClient } from '@supabase/supabase-js';
import { extractPages, stripBackMatter, splitIntoParagraphs, chunkParagraphs, embedWithRetry, errorMessage, CHUNK_WORD_TARGET, CHUNK_WORD_OVERLAP, MAX_SENTENCE_WORDS } from '@/lib/ai/ingest-pipeline';

// ---------- CLI args ----------

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

// ---------- Env ----------

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

const SUPABASE_URL = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
const SUPABASE_SECRET_KEY = requireEnv('SUPABASE_SECRET_KEY');
requireEnv('GOOGLE_GENERATIVE_AI_API_KEY');

// CLI uses the secret key — bypasses RLS intentionally.
// The API route uses the publishable key with the user's session — goes through RLS.
const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY);

// ---------- Supabase operations ----------

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
  // extractPages now takes a Buffer — file reading is the caller's responsibility.
  const buffer = await readFile(filePath);
  const pages = await extractPages(buffer);
  console.log(`Extracted ${pages.length} pages.`);

  const contentPages = stripBackMatter(pages);
  const paragraphs = splitIntoParagraphs(contentPages);
  const chunks = chunkParagraphs(paragraphs);
  console.log(`Built ${chunks.length} chunks ` + `(target ${CHUNK_WORD_TARGET} words, ${CHUNK_WORD_OVERLAP} word overlap, ${MAX_SENTENCE_WORDS} word sentence cap).`);

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
    console.error('Ingestion completed with failures. Corpus is incomplete — do not proceed to retrieval testing until resolved.');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Ingestion aborted:', errorMessage(err));
  process.exit(1);
});
