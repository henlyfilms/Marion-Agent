/**
 * Markdown -> plain text for notifications (desktop banners, in-app banners, phone push). Bots write Markdown;
 * a notification is not rendered, so `**done**` must read as `done`.
 * Shared by the server (server/src/features/notify.ts) and the web app (@shared/lib/plainText).
 */
export function stripMarkdown(input: string): string {
  // Backslash escapes (\* \_ \# ...) are hidden first so they are not mistaken for Markdown, and restored at the end.
  let text = String(input ?? '').replace(/\r\n?/g, '\n')
    .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, (_all, char: string) => '\uE000' + String.fromCharCode(0xE100 + char.charCodeAt(0)));
  // Fenced code blocks: keep the code, drop the fences and the language tag.
  text = text.replace(/(^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)(?:\n[ \t]*\2[`~]*[ \t]*(?=\n|$)|$)/g, (_all, lead: string, _fence: string, code: string) => `${lead}${code}`);
  // Stray fence lines left over (unterminated or empty blocks).
  text = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*$/gm, '');
  // Images and links: keep the label (or alt text), drop the address.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\((?:[^()\s]|\([^()]*\))*(?:\s+"[^"]*")?\)/g, '$1');
  text = text.replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1');
  text = text.replace(/^[ \t]*\[[^\]]+\]:\s*\S+.*$/gm, '');
  text = text.replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1');
  // Raw HTML tags.
  text = text.replace(/<\/?[a-zA-Z][^>\n]*>/g, '');
  // Line-level markers: headings, blockquotes, horizontal rules, list bullets, task boxes.
  text = text.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gm, '$1');
  text = text.replace(/^[ \t]*(?:>[ \t]?)+/gm, '');
  text = text.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, '');
  text = text.replace(/^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]+/gm, '$1• ');
  text = text.replace(/^([ \t]*)[-*+][ \t]+/gm, '$1• ');
  text = text.replace(/^[ \t]*={2,}[ \t]*$|^[ \t]*-{2,}[ \t]*$/gm, '');
  // Inline code, then emphasis (longest markers first). Underscores only count at word edges so snake_case survives.
  text = text.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, '$2');
  text = text.replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '$1');
  text = text.replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1');
  text = text.replace(/(^|[^\w_])___(?=\S)([\s\S]*?\S)___(?![\w_])/g, '$1$2');
  text = text.replace(/(^|[^\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/g, '$1$2');
  text = text.replace(/(^|[^\w*])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, '$1$2');
  text = text.replace(/(^|[^\w_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w_])/g, '$1$2');
  text = text.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1');
  text = text.replace(/\uE000([\uE100-\uE1FF])/g, (_all, char: string) => String.fromCharCode(char.charCodeAt(0) - 0xE100));
  // Tidy the blank lines the removals left behind.
  return text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

/** One line of plain text, for banner titles and previews. */
export const plainLine = (input: string) => stripMarkdown(input).replace(/\s+/g, ' ').trim();
