/**
 * A cancellation, not a failure: the request's own signal was aborted (the owner stopped talking, the browser dropped
 * the request, a newer dictation pass replaced this one) or the error is an AbortError. These are expected and are
 * not logged as warnings. An AbortError caused by a timeout (`AbortSignal.timeout()` → cause TimeoutError) is a real
 * failure, not a cancellation.
 */
export function isExpectedAbort(error: unknown, signal?: AbortSignal): boolean {
  // A request cancelled by AbortSignal.timeout() timed out: a failure, not an expected cancellation.
  if (signal?.aborted) return (signal.reason as { name?: unknown } | undefined)?.name !== 'TimeoutError';
  const value = error as { name?: unknown; code?: unknown; cause?: { name?: unknown } | null } | null | undefined;
  if (value?.name === 'TimeoutError' || value?.cause?.name === 'TimeoutError') return false;
  return value?.name === 'AbortError' || value?.code === 'ABORT_ERR';
}
