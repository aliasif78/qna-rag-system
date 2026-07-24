// lib/document-status.ts

// Promise cache for the document-status read.
//
// Why this exists rather than a useEffect + setState pair:
// fetching server state in an effect and mirroring it into useState creates a
// second source of truth that has to be manually invalidated, and it forces a
// synchronous setState in the effect's resolution path — which is exactly what
// React 19 warns about. Caching the promise instead lets the component read it
// with use() and suspend, so there is no "loading" state variable to manage
// and no setState in an effect body at all.
//
// In a codebase with TanStack Query this file would not exist — useQuery
// handles caching, invalidation, and revalidation properly. This is the
// minimum-dependency version of the same idea. If this app grows a second
// server-state read, install a query library rather than extending this.

export interface DocumentStatus {
  chunkCount: number;
  // Distinguishes "server said zero chunks" from "we could not reach the
  // status endpoint at all." Both render the upload panel, but only one is
  // an error worth surfacing.
  unavailable: boolean;
}

export class UnauthorizedError extends Error {
  constructor() {
    super('Unauthorized');
    this.name = 'UnauthorizedError';
  }
}

let cached: Promise<DocumentStatus> | null = null;

async function requestDocumentStatus(): Promise<DocumentStatus> {
  let res: Response;

  try {
    res = await fetch('/api/documents');
  } catch {
    // Network failure. Fail toward the upload panel — showing example prompts
    // for a document that may not exist is the worse failure mode.
    return { chunkCount: 0, unavailable: true };
  }

  // Thrown, not returned: the component needs to redirect, and an error
  // boundary / catch is the only way to distinguish this from "no document."
  if (res.status === 401) {
    throw new UnauthorizedError();
  }

  if (!res.ok) {
    return { chunkCount: 0, unavailable: true };
  }

  const data = (await res.json().catch(() => null)) as { chunkCount?: number } | null;

  return {
    chunkCount: typeof data?.chunkCount === 'number' ? data.chunkCount : 0,
    unavailable: false,
  };
}

export function getDocumentStatus(): Promise<DocumentStatus> {
  cached ??= requestDocumentStatus();
  return cached;
}

// Called after a successful upload. The upload response already tells us the
// new chunk count, so re-fetching would be a wasted round-trip.
export function primeDocumentStatus(chunkCount: number): void {
  cached = Promise.resolve({ chunkCount, unavailable: false });
}

export function invalidateDocumentStatus(): void {
  cached = null;
}
