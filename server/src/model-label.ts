// No imports: shared by the server and the web app (work cards).

/**
 * A short, exact name for the model on work cards: "Opus 5.5", "6.2 Sol", "Gemini 4 Neon". The provider
 * name is shown next to it, so a leading "Claude"/"GPT" is dropped.
 */
export function modelLabel(provider: string, id: string, label?: string | null): string {
  const raw = (label || id || '').trim();
  if (!raw) return '';
  if (provider === 'claude') {
    const fromId = /^claude-([a-z]+)-(\d+)-(\d+)/i.exec(raw);
    if (fromId) return `${fromId[1][0].toUpperCase()}${fromId[1].slice(1)} ${fromId[2]}.${fromId[3]}`;
    return raw.replace(/^claude\s+/i, '');
  }
  if (provider === 'codex') {
    const gpt = /^gpt-?(\d+(?:\.\d+)?)(?:[- ](.+))?$/i.exec(raw);
    if (gpt) return [gpt[1], ...(gpt[2] ?? '').split(/[- ]+/).filter(Boolean).map(word => word[0].toUpperCase() + word.slice(1))].join(' ');
    return raw;
  }
  if (provider === 'gemini' && /^gemini-/i.test(raw)) {
    return raw.split('-').map(word => word[0].toUpperCase() + word.slice(1)).join(' ');
  }
  return raw;
}
