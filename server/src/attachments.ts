import { TextDecoder } from 'node:util';
import { db } from './db.js';
import { newId } from './lib/ids.js';
import type { ChatAttachment } from './types.js';

const photoTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const textExtensions = /\.(?:txt|md|markdown|csv|tsv|json|xml|ya?ml|log|html?|css|[cm]?js|tsx?|py|sh|sql)$/i;
const maxPhoto = 4 * 1024 * 1024;
const maxText = 32 * 1024;
export const attachmentBodyLimit = 4 * maxPhoto + 64 * 1024;

export type UploadedAttachment = ChatAttachment & { data: Buffer };

function imageType(bytes: Buffer) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return 'image/gif';
}

export async function readAttachments(files: (File | string)[]): Promise<UploadedAttachment[]> {
  if (files.length > 4) throw new Error('Add up to four attachments per message.');
  return Promise.all(files.map(async file => {
    if (typeof file === 'string' || !file.size) throw new Error('Choose a file with content.');
    const name = (file.name.split(/[\\/]/).pop() || 'Attachment').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 180) || 'Attachment';
    const photo = photoTypes.has(file.type) || /\.(?:png|jpe?g|webp|gif)$/i.test(name);
    if (!photo && !textExtensions.test(name) && !file.type.startsWith('text/')) {
      throw new Error('Choose a PNG, JPEG, WebP, GIF, or UTF-8 text file.');
    }
    if (file.size > (photo ? maxPhoto : maxText)) throw new Error(photo ? 'Photos must be 4 MB or smaller.' : 'Text files must be 32 KB or smaller.');
    const data = Buffer.from(await file.arrayBuffer());
    const mime = photo ? imageType(data) : 'text/plain';
    if (!mime) throw new Error('The photo could not be read. Choose a PNG, JPEG, WebP, or GIF.');
    if (!photo) {
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

export function attachmentText(text: string, attachments: UploadedAttachment[] = []) {
  const files = attachments.filter(file => file.mime === 'text/plain')
    .map(file => ({ filename: file.name, content: file.data.toString('utf8') }));
  return [text, files.length ? `Attached text files (JSON):\n${JSON.stringify(files)}` : ''].filter(Boolean).join('\n\n');
}

export function photos(attachments: UploadedAttachment[] = []) {
  return attachments.filter(file => photoTypes.has(file.mime));
}
