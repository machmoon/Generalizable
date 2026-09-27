// Transport helpers for the resumable chunked upload.
//
// Two failure modes that used to lose a whole scan:
//
// 1. A single dropped chunk threw straight out of the upload loop, which marked
//    the run Failed and deleted its IndexedDB copy - so a momentary network
//    blip was *worse* than closing the tab (which at least resumes).
//    `postWithRetry` absorbs the transient cases.
// 2. A resumed upload trusted its own persisted cursor. If the server had lost
//    the earlier chunks (24h sweep, or the staging disk went away) it would
//    finalize over gaps. `resolveResumeStart` asks the server what it actually
//    holds and re-sends from there - from 0 if nothing survived.

// Transient: worth another go. Anything else 4xx (413 too large, 400 bad
// params) is a verdict, not a blip, and retrying just delays the error.
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export type RetryOptions = {
  retries?: number;       // extra attempts after the first
  baseDelayMs?: number;   // doubled per attempt
};

/**
 * POST with bounded retries on transient failures.
 *
 * Returns the Response as soon as one arrives that isn't retryable - including
 * error responses, so callers keep their existing status handling. Throws the
 * last network error if every attempt failed. A caller abort (user cancel) is
 * never retried and propagates immediately.
 */
export async function postWithRetry(
  url: string,
  init: RequestInit,
  { retries = 2, baseDelayMs = 400 }: RetryOptions = {},
): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    try {
      const res = await fetch(url, init);
      if (attempt === retries || !RETRYABLE_STATUS.has(res.status)) return res;
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      // A cancel surfaces here as an AbortError - that's a decision, not a blip.
      if (init.signal?.aborted) throw err;
      lastError = err;
      if (attempt === retries) throw err;
    }

    await sleep(baseDelayMs * 2 ** attempt);
  }

  throw lastError instanceof Error ? lastError : new Error("Upload request failed");
}

/**
 * The chunk index a resuming upload should start from.
 *
 * The server is the authority: it reports the length of the contiguous run of
 * chunks it still has. That can be ahead of `localNextChunk` (the cursor is
 * only persisted every 16 chunks) or behind it (chunks were swept), and both
 * are handled by just believing it. Falls back to the local cursor if the
 * endpoint is unreachable or unrecognised, so an older backend still resumes
 * the way it used to.
 */
export async function resolveResumeStart(
  apiBase: string,
  sessionId: string,
  localNextChunk: number,
): Promise<number> {
  try {
    const res = await fetch(`${apiBase}/api/upload-status/${sessionId}`, {
      credentials: "include",
    });
    if (!res.ok) return localNextChunk;
    const data = await res.json();
    const next = data?.next_chunk;
    return typeof next === "number" && next >= 0 ? next : localNextChunk;
  } catch {
    return localNextChunk;
  }
}
