/** Link safety for chat messages: only http(s) and mailto links are ever clickable. */
const SAFE = new Set(['http:', 'https:', 'mailto:']);

/** Returns the URL when it is safe to open, otherwise ''. Relative links (no scheme) are not allowed in agent messages. */
export function safeHref(url: string | undefined | null): string {
  if (!url) return '';
  const trimmed = url.trim();
  try {
    return SAFE.has(new URL(trimmed).protocol) ? trimmed : '';
  } catch {
    return '';
  }
}

/** react-markdown `urlTransform`: unsafe schemes (javascript:, data:, file:, vbscript:...) become empty. */
export const urlTransform = (url: string): string => safeHref(url);
