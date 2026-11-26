// Copy text that works everywhere the app runs: the Mac app, a browser tab, and the iPhone over
// the local network (where navigator.clipboard is missing on plain http). Falls back to the old
// hidden-textarea copy when the Clipboard API is unavailable or refuses.
export async function copyText(text: string): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return; }
  } catch { /* fall through to the legacy copy */ }
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  const active = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  area.select();
  area.setSelectionRange(0, text.length);
  const ok = document.execCommand('copy');
  area.remove();
  active?.focus?.({ preventScroll: true });
  if (!ok) throw new Error('The clipboard is not available here.');
}
