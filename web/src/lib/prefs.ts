const PREFIX = 'marion-agent.';

export function prefGet(name: string): string | null {
  try { return localStorage.getItem(PREFIX + name); } catch { return null; }
}

export function prefSet(name: string, value: string) {
  try { localStorage.setItem(PREFIX + name, value); } catch { /* storage unavailable */ }
}
