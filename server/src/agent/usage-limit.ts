// Only pass provider error frames/diagnostics here, not ordinary assistant messages.
const limitCode = /^(?:usageLimitExceeded|rateLimitExceeded|rate_limit_error|insufficient_quota)$/i;
const limitPattern = /\b(?:429|too many requests|resource[ _-]exhausted|insufficient[ _-]quota|usage[ _-]limit(?:[ _-]reached|[ _-]exceeded)?|rate[ _-]?limit(?:ed|ing|[ _-]exceeded)?|(?:daily|weekly|monthly|session|5[ -]hour) (?:usage )?limit|quota (?:has been )?(?:exceeded|exhausted|reached)|out of (?:credits|usage)|credit balance is too low|(?:hit|reached) (?:your |the )?(?:usage )?limit)\b/i;

export function isUsageLimitError(error: unknown): boolean {
  if (error instanceof UsageLimitError) return true;
  if (typeof error === 'string') {
    const diagnostic = error.trim();
    return !/^(?:Check|See|Try checking)\b/i.test(diagnostic) && (limitCode.test(diagnostic) || limitPattern.test(diagnostic));
  }
  if (!error || typeof error !== 'object') return false;
  const value = error as Record<string, unknown>;
  return [value.status, value.statusCode, value.httpStatusCode, value.code].some(code => (code === 429 || code === '429'))
    || ['message', 'error', 'errors', 'details', 'codexErrorInfo', 'reason', 'status', 'code', 'type', 'subtype'].some(key => {
      const entry = value[key];
      if (typeof entry === 'string') return isUsageLimitError(entry);
      if (Array.isArray(entry)) return entry.some(isUsageLimitError);
      return entry && typeof entry === 'object' && (Object.keys(entry).some(name => /^(?:usageLimitExceeded|rateLimitExceeded)$/i.test(name)) || isUsageLimitError(entry));
    });
}

export class UsageLimitError extends Error {
  constructor(detail = '') {
    super(detail ? `Usage limit reached: ${detail.slice(0, 600)}` : 'Usage limit reached.');
    this.name = 'UsageLimitError';
  }
}

export function checkUsageLimit(...evidence: unknown[]) {
  const matched = evidence.find(isUsageLimitError);
  if (matched !== undefined) {
    if (matched instanceof UsageLimitError) throw matched;
    throw new UsageLimitError(typeof matched === 'string' ? matched.trim() : typeof (matched as any)?.message === 'string' ? (matched as any).message : '');
  }
}
