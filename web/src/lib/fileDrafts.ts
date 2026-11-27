import { MAX_ATTACHMENTS, TOO_MANY_ATTACHMENTS } from '@shared/attachment-limits';

/**
 * Unsent attachments for each bot's chat box, kept outside the Composer so files can be added to any chat —
 * also one that is not open (dropping screenshots onto a bot in the sidebar) — and are still there after a switch.
 * Kept in memory only: File objects cannot be stored, and a reload starts with an empty tray.
 */

export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const VIDEO_TYPES = ['video/quicktime', 'video/mp4', 'video/webm'];
export const TEXT_FILES = '.txt,.md,.markdown,.csv,.tsv,.json,.xml,.yaml,.yml,.log,.html,.htm,.css,.js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx,.py,.sh,.sql';
export const ACCEPT = [...PHOTO_TYPES, ...VIDEO_TYPES, '.mov,.mp4,.m4v,.webm', TEXT_FILES].join(',');
export const isPhoto = (file: File) => PHOTO_TYPES.includes(file.type) || /\.(?:png|jpe?g|webp|gif)$/i.test(file.name);
export const isTextFile = (file: File) => file.type.startsWith('text/') || TEXT_FILES.split(',').some(ext => file.name.toLowerCase().endsWith(ext));
/** Screen recordings (macOS saves .mov); the server turns them into frames for Claude, Codex and Gemini. */
export const isVideo = (file: File) => file.type.startsWith('video/') || /\.(?:mov|mp4|m4v|webm)$/i.test(file.name);
/** Matches the server: a few minutes of retina screen recording is far over 64 MB. */
const MAX_VIDEO = 256 * 1024 * 1024;
/** One message carries at most two recordings (the server's request size limit is two of them). */
export const MAX_VIDEOS = 2;
const MAX_PHOTO = 4 * 1024 * 1024;
const MAX_TEXT = 256 * 1024;

/** Why `added` cannot join a draft that already holds `current`, or null when it can. */
export function attachmentProblem(current: readonly File[], added: readonly File[]): string | null {
  if (current.length + added.length > MAX_ATTACHMENTS) return TOO_MANY_ATTACHMENTS;
  if ([...current, ...added].filter(isVideo).length > MAX_VIDEOS) return `Add up to ${MAX_VIDEOS} screen recordings per message.`;
  const unsupported = added.find(file => !isPhoto(file) && !isVideo(file) && !isTextFile(file));
  if (unsupported) {
    return /\.pdf$/i.test(unsupported.name)
      ? 'PDFs can’t be read yet. Copy the text into a .txt file, or take a screenshot of the page.'
      : `${unsupported.name} isn’t supported. Add screenshots (PNG, JPEG, WebP, GIF), screen recordings (MOV, MP4, WebM) or text files.`;
  }
  const limit = (file: File) => isVideo(file) ? MAX_VIDEO : isPhoto(file) ? MAX_PHOTO : MAX_TEXT;
  const invalid = added.find(file => !file.size || file.size > limit(file));
  if (!invalid) return null;
  return !invalid.size ? 'Choose a file with content.'
    : isVideo(invalid) ? 'Screen recordings must be 256 MB or smaller.'
    : isPhoto(invalid) ? 'Photos must be 4 MB or smaller.' : 'Text files must be 256 KB or smaller.';
}

const NONE: readonly File[] = Object.freeze([]);
const drafts = new Map<string, readonly File[]>();
/** A problem from adding files to a chat whose box was not showing yet; that box shows it once. */
const problems = new Map<string, string>();
const listeners = new Set<() => void>();
const changed = () => { for (const listener of listeners) listener(); };

/** Same array until the draft changes (safe for useSyncExternalStore). */
export const getFileDraft = (botId: string): readonly File[] => drafts.get(botId) ?? NONE;
export const subscribeFileDrafts = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

export function setFileDraft(botId: string, files: readonly File[]) {
  if (files === getFileDraft(botId) || (!files.length && !drafts.has(botId))) return;
  if (files.length) drafts.set(botId, Object.freeze([...files]));
  else drafts.delete(botId);
  changed();
}

/** Adds files to one bot's draft. Returns the problem (and adds nothing) if they do not fit. */
export function addDraftFiles(botId: string, added: readonly File[]): string | null {
  const current = getFileDraft(botId);
  const problem = attachmentProblem(current, added);
  if (!problem && added.length) setFileDraft(botId, [...current, ...added]);
  return problem;
}

export function reportFileDraftProblem(botId: string, problem: string) {
  problems.set(botId, problem);
  changed();
}
export function takeFileDraftProblem(botId: string) {
  const problem = problems.get(botId);
  problems.delete(botId);
  return problem;
}

/** True while a drag carries files from Finder, the Desktop or a screenshot thumbnail (not text or links). */
export const carriesFiles = (transfer: Pick<DataTransfer, 'types'> | null | undefined) =>
  !!transfer && Array.from(transfer.types ?? []).includes('Files');

/**
 * Files dropped on a chat in the sidebar: they go into *that* bot's draft first, then its chat opens, so they
 * can never land in the chat that was open before. A problem (31st file, unsupported type) shows in its chat box.
 */
export function dropFilesOnChat(botId: string, files: readonly File[], openChat: (botId: string) => void) {
  if (!files.length) return false;
  const problem = addDraftFiles(botId, files);
  if (problem) reportFileDraftProblem(botId, problem);
  openChat(botId);
  return !problem;
}
