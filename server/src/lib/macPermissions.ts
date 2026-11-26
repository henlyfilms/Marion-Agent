/**
 * Recognises when macOS (privacy / TCC) stops Marion Agent from doing something on this Mac, and says plainly
 * what it was trying to do and what got blocked. Used wherever the app touches native macOS features
 * (Accessibility / Apple events via osascript, Speech Recognition, Microphone, Screen Recording, protected folders).
 */
export interface MacBlock {
  /** What Marion Agent was trying to do, e.g. "Choose a folder to share with a bot". */
  doing: string;
  /** What macOS blocked, e.g. "the Automation permission". */
  blocked: string;
  /** Where to allow it. */
  fix: string;
}

const RULES: { test: RegExp; blocked: string; fix: string }[] = [
  {
    test: /assistive access|not allowed to send (?:key|mouse)|-25211|-25204|-1719|AXIsProcessTrusted|accessibility (?:access|permission)|not trusted/i,
    blocked: 'the Accessibility permission (controlling the keyboard, mouse or other apps)',
    fix: 'System Settings → Privacy & Security → Accessibility → turn on Marion Agent',
  },
  {
    test: /-1743|not authori[sz]ed to send apple events|errAEEventNotPermitted|apple events? .*(?:denied|not permitted)/i,
    blocked: 'the Automation permission (sending Apple events to another app)',
    fix: 'System Settings → Privacy & Security → Automation → allow Marion Agent',
  },
  {
    test: /screen ?recording|could not create image from display|not permitted to (?:capture|record) the screen|-3801/i,
    blocked: 'the Screen Recording permission',
    fix: 'System Settings → Privacy & Security → Screen & System Audio Recording → turn on Marion Agent',
  },
  {
    test: /speech ?recogni[a-z]*[^\n]*(?:denied|not authori[sz]ed|restricted|not allowed)|SFSpeechRecognizer[^\n]*(?:denied|not authori[sz]ed)|(?:denied|not authori[sz]ed)[^\n]*speech ?recogni/i,
    blocked: 'the Speech Recognition permission',
    fix: 'System Settings → Privacy & Security → Speech Recognition → turn on Marion Agent',
  },
  {
    test: /microphone[^\n]*(?:denied|not authori[sz]ed|restricted|not allowed)|(?:denied|not authori[sz]ed)[^\n]*microphone/i,
    blocked: 'the Microphone permission',
    fix: 'System Settings → Privacy & Security → Microphone → turn on Marion Agent',
  },
  {
    test: /\bEPERM\b|\bEACCES\b|operation not permitted|permission denied|not permitted to (?:read|open|list)/i,
    blocked: 'access to a protected folder (Files & Folders / Full Disk Access)',
    fix: 'System Settings → Privacy & Security → Files & Folders (or Full Disk Access) → allow Marion Agent',
  },
];

function messageOf(error: unknown) {
  if (typeof error === 'string') return error;
  const e = error as { message?: string; stderr?: string; stdout?: string; code?: string | number } | undefined;
  return [e?.stderr, e?.message, typeof e?.code === 'string' ? e.code : ''].filter(Boolean).join('\n');
}

/** The macOS block behind `error`, or undefined when it is not a permission problem. Only meaningful on a Mac. */
export function macBlock(error: unknown, doing: string): MacBlock | undefined {
  if (process.platform !== 'darwin') return undefined;
  const text = messageOf(error);
  const rule = RULES.find(entry => entry.test.test(text));
  return rule ? { doing, blocked: rule.blocked, fix: rule.fix } : undefined;
}

/** One clear paragraph: what it was doing, what macOS blocked, how to allow it. */
export const describeMacBlock = (block: MacBlock) =>
  `Marion Agent was trying to: ${block.doing}. macOS blocked ${block.blocked}. To allow it: ${block.fix}.`;

/** An error that carries its macOS block, so routes can return it and the app can show it. */
export class MacPermissionError extends Error {
  constructor(readonly block: MacBlock) {
    super(describeMacBlock(block));
    this.name = 'MacPermissionError';
  }
}

/** Throws a MacPermissionError when `error` is a macOS permission block; otherwise returns so the caller handles it. */
export function rethrowIfMacBlocked(error: unknown, doing: string): void {
  const block = macBlock(error, doing);
  if (block) throw new MacPermissionError(block);
}
