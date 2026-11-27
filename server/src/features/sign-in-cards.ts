import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { appendRow, getBotRow, getRow, updateRow } from '../store.js';
import { executable, forgetGeminiCatalog, subscriptionModels } from '../agent/subscriptions.js';
import { notify } from './notify.js';
import type { SignInCardBody } from '../types.js';

const run = promisify(execFile);
const GEMINI_LOGIN = 'agy acp --login';

/** Opens the sign-in command in Terminal on this Mac (tests swap it: nothing may open a window there). */
type Opener = (command: string) => Promise<void>;
const openInTerminal: Opener = async command => {
  if (process.platform !== 'darwin') throw new Error(`Run ${command} in a terminal on this computer, then press "I've signed in".`);
  const script = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  await run('/usr/bin/osascript', ['-e', `tell application "Terminal" to do script "${script}"`, '-e', 'tell application "Terminal" to activate'], { timeout: 10_000 });
};
let opener: Opener = openInTerminal;
/** Tests: replace how the sign-in command is opened, and how a finished sign-in is checked. */
let checker: () => Promise<void> = async () => { forgetGeminiCatalog(); await subscriptionModels('gemini'); };
export function setSignInDeps(deps: { open?: Opener; check?: () => Promise<void> } = {}) {
  opener = deps.open ?? openInTerminal;
  checker = deps.check ?? (async () => { forgetGeminiCatalog(); await subscriptionModels('gemini'); });
}

/**
 * The full sign-in command: the absolute agy path when Marion found one (Terminal's PATH may not include it). Shown on
 * the card and copied by "Copy command", the same command "Sign in with Google" runs.
 */
export const loginCommand = () => {
  const program = executable('gemini');
  return program ? `${/\s/.test(program) ? `'${program.replace(/'/g, `'\\''`)}'` : program} acp --login` : GEMINI_LOGIN;
};

/**
 * Shows the in-app Google sign-in card for Gemini in this chat (once: a pending card is reused, not repeated).
 * Returns the card's row seq, or null when the chat is gone.
 */
export function showSignInCard(userId: string, botId: string, generation: number, provider: 'gemini') {
  const bot = getBotRow(botId);
  if (!bot || bot.deleted_at || bot.generation !== generation) return null;
  const open = db.prepare(`SELECT seq FROM rows WHERE bot_id=? AND generation=? AND kind='card' AND json_extract(body,'$.card')='sign-in'
    AND json_extract(body,'$.provider')=? AND json_extract(body,'$.status') IN ('pending','working') ORDER BY seq DESC LIMIT 1`).get(botId, generation, provider) as { seq: number } | undefined;
  if (open) return open.seq;
  const card: SignInCardBody = {
    type: 'card', card: 'sign-in', id: randomUUID(), provider, providerName: 'Google (Gemini)',
    reason: 'Gemini needs you to sign in with your personal Google account before it can answer. Sign in once on this Mac and Marion carries on.',
    command: loginCommand(), status: 'pending',
  };
  const seq = appendRow(botId, 'card', card).seq as number;
  if (!bot.hidden) notify(userId, { kind: 'approval', botId, title: `${bot.name} needs you to sign in`, body: 'Gemini needs a Google sign-in.' });
  return seq;
}

/**
 * The card's buttons. 'open': start the Google sign-in in Terminal (Mac only). 'check': confirm the sign-in worked
 * (the CLI lists the account's models) and let the bot carry on. 'dismiss': close the card.
 * `resume` re-queues the chat's last request once signed in.
 */
export async function actOnSignInCard(botId: string, seq: number, action: string, options: { local: boolean; resume?: () => void }) {
  const row = getRow(botId, seq);
  const body = row?.body as SignInCardBody | undefined;
  if (!body || body.type !== 'card' || body.card !== 'sign-in') throw new Error('Not a sign-in card.');
  if (body.status === 'signed-in' || body.status === 'dismissed') throw new Error('This sign-in card is already done.');
  const save = (patch: Partial<SignInCardBody>) => updateRow(botId, seq, { ...body, ...patch });
  if (action === 'dismiss') { save({ status: 'dismissed', note: undefined }); return body.status; }
  if (action === 'open') {
    if (!options.local) throw new Error('Sign in on the Mac running Marion Agent.');
    const command = loginCommand();
    await opener(command);
    save({ status: 'working', command, note: 'Finish the Google sign-in in the Terminal window (and browser) that opened, then press "I\'ve signed in".' });
    return 'working';
  }
  if (action === 'check') {
    try { await checker(); }
    catch {
      // Still not signed in: "I've signed in" stays available (status unchanged), so the owner can finish and retry the
      // check without opening the sign-in again.
      save({ note: 'Gemini is still not signed in. Finish the Google sign-in, then press "I\'ve signed in" again.' });
      throw new Error('Gemini is still not signed in.');
    }
    save({ status: 'signed-in', note: undefined });
    options.resume?.();
    return 'signed-in';
  }
  throw new Error('Unknown sign-in action.');
}
