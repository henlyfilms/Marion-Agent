import { TextDecoder } from 'node:util';
import { db } from './db.js';
import { newId } from './lib/ids.js';
import type { ChatAttachment } from './types.js';
import { MAX_ATTACHMENTS, TOO_MANY_ATTACHMENTS } from './attachment-limits.js';

export { MAX_ATTACHMENTS } from './attachment-limits.js';

const photoTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const textExtensions = /\.(?:txt|md|markdown|csv|tsv|json|xml|ya?ml|log|html?|css|[cm]?js|tsx?|py|sh|sql)$/i;
const videoExtensions = /\.(?:mov|mp4|m4v|webm)$/i;
export const maxPhoto = 4 * 1024 * 1024;
const maxText = 256 * 1024;
/**
 * A screen recording (QuickTime .mov, MP4, WebM). Models see sampled frames; the original stays in the chat.
 * A few minutes of macOS screen recording is well over 64 MB, so the limit is generous. One message may carry
 * up to two recordings of this size (the request limit below), plus photos and text files up to 30 files in all.
 */
export const maxVideo = 256 * 1024 * 1024;
export const attachmentBodyLimit = 2 * maxVideo + MAX_ATTACHMENTS * maxPhoto + MAX_ATTACHMENTS * maxText + 64 * 1024;

export type UploadedAttachment = ChatAttachment & { data: Buffer };

/** The image type from a file's first bytes (PNG, JPEG, WebP, GIF), or undefined when it is not one of those. */
export function imageType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
}

export const isVideoMime = (mime: string) => mime.startsWith('video/');

/** MP4/MOV have "ftyp" at byte 4 (QuickTime brand "qt  "); WebM/Matroska starts with the EBML header. */
function videoType(bytes: Buffer, name: string) {
  if (bytes.toString('ascii', 4, 8) === 'ftyp') return bytes.toString('ascii', 8, 10) === 'qt' || /\.mov$/i.test(name) ? 'video/quicktime' : 'video/mp4';
  if (bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return 'video/webm';
}

export async function readAttachments(files: (File | string)[]): Promise<UploadedAttachment[]> {
  if (files.length > MAX_ATTACHMENTS) throw new Error(TOO_MANY_ATTACHMENTS);
  return Promise.all(files.map(async file => {
    if (typeof file === 'string' || !file.size) throw new Error('Choose a file with content.');
    const name = (file.name.split(/[\\/]/).pop() || 'Attachment').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'Attachment';
    const video = file.type.startsWith('video/') || videoExtensions.test(name);
    const photo = !video && (photoTypes.has(file.type) || /\.(?:png|jpe?g|webp|gif)$/i.test(name));
    if (!photo && !video && !textExtensions.test(name) && !file.type.startsWith('text/')) {
      throw new Error('Choose a PNG, JPEG, WebP, GIF, MOV, MP4, WebM, or UTF-8 text file.');
    }
    if (file.size > (video ? maxVideo : photo ? maxPhoto : maxText)) {
      throw new Error(video ? 'Screen recordings must be 256 MB or smaller.' : photo ? 'Photos must be 4 MB or smaller.' : 'Text files must be 256 KB or smaller.');
    }
    const data = Buffer.from(await file.arrayBuffer());
    const mime = video ? videoType(data, name) : photo ? imageType(data) : 'text/plain';
    if (!mime) throw new Error(video ? 'The recording could not be read. Choose a MOV, MP4, or WebM file.' : 'The photo could not be read. Choose a PNG, JPEG, WebP, or GIF.');
    if (!photo && !video) {
      try {
        if (new TextDecoder('utf-8', { fatal: true }).decode(data).includes('\0')) throw new Error();
      } catch { throw new Error('Text files must use UTF-8 encoding.'); }
    }
    return { id: newId('att'), name, mime, size: data.length, data };
  }));
}

export function saveAttachments(botId: string, generation: number, seq: number, attachments: UploadedAttachment[]) {
  const insert = db.prepare('INSERT INTO message_attachments(id, bot_id, generation, seq, name, mime, data) VALUES (?,?,?,?,?,?,?)');
  for (const file of attachments) insert.run(file.id, botId, generation, seq, file.name, file.mime, file.data);
}

export function getAttachment(botId: string, generation: number, id: string) {
  return db.prepare('SELECT name, mime, data FROM message_attachments WHERE id=? AND bot_id=? AND generation=?')
    .get(id, botId, generation) as { name: string; mime: string; data: Buffer<ArrayBuffer> } | undefined;
}

/** Name, type and size of a saved file without loading its bytes (recordings can be hundreds of MB). */
export function getAttachmentInfo(botId: string, generation: number, id: string) {
  return db.prepare('SELECT name, mime, length(data) AS size FROM message_attachments WHERE id=? AND bot_id=? AND generation=?')
    .get(id, botId, generation) as { name: string; mime: string; size: number } | undefined;
}

/** `length` bytes of a saved file starting at byte `start` (a Range request: video seeking reads only what it needs). */
export function getAttachmentSlice(botId: string, generation: number, id: string, start: number, length: number) {
  const row = db.prepare('SELECT substr(data, ?, ?) AS data FROM message_attachments WHERE id=? AND bot_id=? AND generation=?')
    .get(start + 1, length, id, botId, generation) as { data: Buffer } | undefined;
  return row?.data;
}

/**
 * Read one `Range: bytes=…` header. `undefined` means serve the whole file; `'unsatisfiable'` means answer 416.
 * Multiple ranges are not supported and fall back to the whole file.
 */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header?.trim() ?? '');
  if (!match || (!match[1] && !match[2])) return undefined;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!suffix) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  return start >= size || end < start ? 'unsatisfiable' : { start, end };
}

export function attachmentText(text: string, attachments: UploadedAttachment[] = []) {
  const files = attachments.filter(file => file.mime === 'text/plain')
    .map(file => ({ filename: file.name, content: file.data.toString('utf8') }));
  return [text, files.length ? `Attached text files (JSON):\n${JSON.stringify(files)}` : ''].filter(Boolean).join('\n\n');
}

/** The newest user message in this chat that carries files, with their bytes (what a relayed agent should also see). */
export function latestUserAttachments(botId: string, generation: number): UploadedAttachment[] {
  const rows = db.prepare("SELECT body FROM rows WHERE bot_id=? AND generation=? AND kind='message' ORDER BY seq DESC LIMIT 6").all(botId, generation) as { body: string }[];
  for (const { body } of rows) {
    const message = JSON.parse(body);
    if (message.role !== 'user') continue;
    // Only the message that started this request: an older upload is not re-sent with an unrelated relay.
    const files = (message.attachments ?? []) as ChatAttachment[];
    return files.flatMap(file => {
      const saved = getAttachment(botId, generation, file.id);
      return saved ? [{ id: file.id, name: saved.name, mime: saved.mime, size: saved.data.length, data: saved.data }] : [];
    });
  }
  return [];
}

export function photos(attachments: UploadedAttachment[] = []) {
  return attachments.filter(file => photoTypes.has(file.mime));
}
