import { embed, APICallError } from "ai";
import { google } from "@ai-sdk/google";

const EMBEDDING_DIMENSIONS = 768;

type EmbedErrorKind = "quota_exhausted" | "rate_limited" | "other";

export class QueryEmbeddingError extends Error {
  constructor(
    message: string,
    public readonly kind: EmbedErrorKind,
  ) {
    super(message);
    this.name = "QueryEmbeddingError";
  }
}

function classify(err: unknown): EmbedErrorKind {
  if (APICallError.isInstance(err) && err.statusCode === 429) {
    const body = typeof err.responseBody === "string" ? err.responseBody.toLowerCase() : "";
    return body.includes("quota") ? "quota_exhausted" : "rate_limited";
  }
  return "other";
}

export async function embedQuery(text: string): Promise<number[]> {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new QueryEmbeddingError("Cannot embed empty query text.", "other");
  }

  try {
    const { embedding } = await embed({
      model: google.embeddingModel("gemini-embedding-001"),
      value: trimmed,
      maxRetries: 0,
      providerOptions: {
        google: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
          taskType: "RETRIEVAL_QUERY",
        },
      },
    });

    if (embedding.length !== EMBEDDING_DIMENSIONS) {
      throw new QueryEmbeddingError(`Embedding dimension mismatch: expected ${EMBEDDING_DIMENSIONS}, got ${embedding.length}.`, "other");
    }

    return embedding;
  } catch (err) {
    if (err instanceof QueryEmbeddingError) throw err;
    const kind = classify(err);
    const message = kind === "quota_exhausted" ? "Embedding quota exhausted for this project." : kind === "rate_limited" ? "Embedding service is rate-limited right now." : `Query embedding failed: ${err instanceof Error ? err.message : String(err)}`;
    throw new QueryEmbeddingError(message, kind);
  }
}
