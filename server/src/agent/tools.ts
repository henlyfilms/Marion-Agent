import { createGitHubRepo } from '../features/github-repos.js';
import { launchCloudWork } from '../features/cloud-cards.js';
import { repoHint } from '../features/cloud-repo.js';
import { githubRepoArg, prepareRepoCheckout, type RepoCheckout } from './github-checkout.js';
import { isDesktop } from '../lib/desktop-access.js';
import { grok } from './models.js';
import { modelLabel, subscriptionModels, subscriptionReply, subscriptionSelection } from './subscriptions.js';
import { resolveRunSelection } from './provider-defaults.js';
import { env } from '../env.js';
import { db, now } from '../db.js';
import { newId, runId as relayRunId } from '../lib/ids.js';
import { hub } from '../lib/hub.js';
import { desktop, isDockerEngineDown } from '../desktop.js';
import { BOX_ROOT, screenFor } from '../computer.js';
import { appendRow, emitBot, getBotRow, getLive, listRoutines, toRoutine, describeCron } from '../store.js';
import { botMessageBlock, teamRoster } from '../features/coordination.js';
import { createBotRecord } from '../features/bots.js';
import { AVATAR_SHAPE_IDS, normalizeAvatarShape } from '../avatarShapes.js';
import { saveLearnedSkill } from '../features/improve.js';
import { addUniversalMemory, searchUniversalMemories } from '../features/universal-memory.js';
import { executeComposio, innerToolSlugs, isReadOnlySlug, toolkitInfo } from '../composio.js';
import { scheduleRoutine, unscheduleRoutine } from '../routines.js';
import { createEventRoutine, deleteEventTrigger, describeEvent, listTriggerTypes } from '../triggers.js';
import { setCheckins } from '../proactive.js';
import { createTask, TASK_STATES, updateTask } from './task-tools.js';
import { createSubagent, deleteSubagent, listSubagents } from './subagents.js';
import { createRoom, postToRoom, roomForPost } from './rooms.js';
import { orchestrationForBot, saveOrchestration, teamModels, validateTeamSettings } from './orchestration-settings.js';
import { teamDelegate, teamDiscuss } from './orchestration.js';
import { withFolder } from './folder-lock.js';
import { botFolders, hasFullAccess, folderForTask, listFolder, moveInFolder } from '../features/folders.js';
import { appControlTool, runAppControl } from '../features/app-control.js';
import { agentSettings } from '../features/agent-settings.js';
import { orchestrate } from './orchestrate.js';
import { ASK_OWNER_LINE, miniTitle, ownerRequest, showQuestionCard, WorkCard } from './work-feed.js';
import { leanLine, planRelaySession, recordRelayTurn, relayMedia } from './relay.js';
import { lifePlannerTools, lifeToolsEnabled, runLifePlannerTool, type LifePlannerTool } from '../features/life-link.js';
import type { ActivityKind } from '../types.js';
import { MAX_ATTACHMENTS, imageType, latestUserAttachments, maxPhoto, photos, type UploadedAttachment } from '../attachments.js';
import { posix } from 'node:path';
import { Cron } from 'croner';

export interface ToolCtx {
  userId: string;
  botId: string;
  enqueueBotMessage: (fromBotId: string, toBotId: string, text: string, depth: number, opts?: { autoReply?: boolean; attachments?: UploadedAttachment[] }) => void;
  /**
   * Files on the message that started this turn (a user message, a bot-to-bot message, or a group-chat dispatch, which is not
   * stored in this bot's own chat). When set, `attach: ["user_images"]` and relayed agents use these instead of the newest user
   * message in the bot's chat, which may be a later message than the one being handled.
   */
  triggerAttachments?: UploadedAttachment[];
  depth: number;
  /** Bots this turn already messaged (so the automatic reply isn't sent twice). */
  messaged?: Set<string>;
  /** The bot whose message started this turn, if any. Replies to it are always allowed. */
  replyTo?: string;
  signal?: AbortSignal;
  textScreen?: boolean;
  allowSubscriptionTeam?: boolean;
  /** A concurrent run answering another bot while the main turn is busy; it works on `sideHistory`, not the stored chat history. */
  side?: boolean;
  sideHistory?: any[];
  /** The chat turn this call belongs to (a subscription-backed bot makes several Claude calls per turn). */
  turn?: { id: string; startedAt: number; request: string; handoff?: boolean };
}

export interface ToolResult {
  /** Responses API function_call_output.output: string or content array (text + images). */
  output: string | any[];
  summary?: string;
  /** End the turn after this tool (e.g. a question was asked). */
  endTurn?: boolean;
}

type Impl = (args: any, ctx: ToolCtx) => Promise<ToolResult>;

interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: ActivityKind;
  label: string;
  impl: Impl;
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

// ---------- images a bot sends to another bot or a group ----------

/** What `attach` accepts, with the bot's own files folder spelled out (errors are read by the model). */
const attachHelp = (botId: string) => `Use "user_images", "screenshot", or an image path under ${BOX_ROOT}/files/${botId}/.`;

/**
 * Kept under 160 characters: subscription-backed bots see argument descriptions cut at 160 (compactTools), and the file
 * path option must survive that. The system prompts also name the bot's concrete /workspace/files/<bot-id>/ folder.
 */
export const ATTACH_DESCRIPTION = 'Images to send: "user_images" (on the message you are handling), "screenshot", or a path under /workspace/files/<bot-id>/ (PNG/JPEG/WebP/GIF, max 4 MB).';

const attachSchema = {
  type: 'array',
  items: { type: 'string' },
  description: ATTACH_DESCRIPTION,
};

function checkedImage(label: string, name: string, data: Buffer): UploadedAttachment {
  if (!data.length) throw new Error(`${label} is empty.`);
  if (data.length > maxPhoto) throw new Error(`${label} is larger than 4 MB. Images must be 4 MB or smaller.`);
  const mime = imageType(data);
  if (!mime) throw new Error(`${label} is not an image. Attach a PNG, JPEG, WebP, or GIF.`);
  return { id: newId('att'), name, mime, size: data.length, data };
}

/** One attach reference in canonical form, so "/workspace/files/x/a.png" and "/workspace/files/x/./a.png" count once. */
const attachKey = (ref: unknown) => {
  const value = typeof ref === 'string' ? ref.trim() : '';
  return value.startsWith('/') ? posix.normalize(value) : value;
};

/**
 * Why reading an attach path from the bot's computer failed, in words the model can act on. Only the copy script's own
 * failure (a non-zero exit with no Docker error) means the file is missing; an engine that is down (Colima / Docker
 * Desktop), a computer that would not start, or any other Docker error is reported as it is.
 */
export function attachDownloadError(error: unknown): string {
  const failure = error as { code?: unknown; stderr?: Buffer | string; message?: string } | undefined;
  const message = String(failure?.message ?? error ?? '').trim();
  if (/16 MiB/.test(message)) return 'it is larger than 4 MB';
  if (isDockerEngineDown(error)) return message;
  const stderr = failure?.stderr?.toString() ?? '';
  const dockerSide = /error response from daemon|docker daemon|docker api|\.sock|no such container|is not running|colima/i;
  if (typeof failure?.code === 'number' && !dockerSide.test(stderr)) return 'no such file';
  const detail = (stderr.trim() || message).split('\n').map(line => line.trim()).find(line => line && !/^Command failed:/.test(line)) ?? message;
  return `the computer could not read it (${(detail || 'unknown error').slice(0, 300)})`;
}

/**
 * The images a bot asked to send with `attach` (send_to_bot, post_to_group). Every file gets a fresh id, because saved
 * attachments are keyed by id and the copy will belong to another chat. Throws a short, model-readable error when any
 * reference is invalid, empty, too large or not an image, or when there would be more than MAX_ATTACHMENTS files.
 * Callers validate the recipient first: this may take a screenshot or start the bot's computer.
 */
export async function collectBotAttachments(ctx: ToolCtx, refs: unknown): Promise<UploadedAttachment[]> {
  if (refs === undefined || refs === null) return [];
  const help = attachHelp(ctx.botId);
  if (!Array.isArray(refs)) throw new Error(`attach must be a list. ${help}`);
  const wanted = [...new Set(refs.map(attachKey))];
  const out: UploadedAttachment[] = [];
  const add = (files: UploadedAttachment[]) => {
    out.push(...files);
    if (out.length > MAX_ATTACHMENTS) throw new Error(`Attach up to ${MAX_ATTACHMENTS} images per message.`);
  };
  const root = `${BOX_ROOT}/files/${ctx.botId}/`;
  // Check every reference before touching the computer, so a bad one never boots a container or takes a screenshot.
  for (const ref of wanted) {
    if (!ref) throw new Error(`An attach value is empty. ${help}`);
    if (ref.startsWith('/')) {
      if (!ref.startsWith(root) || ref.length === root.length) throw new Error(`"${ref}" is outside your files folder. Attach images saved under ${root}.`);
    } else if (ref !== 'user_images' && ref !== 'screenshot') throw new Error(`Unknown attach value "${ref}". ${help}`);
  }
  for (const ref of wanted) {
    if (ref === 'user_images') {
      const generation = getBotRow(ctx.botId)?.generation;
      const source = ctx.triggerAttachments ?? (generation === undefined ? [] : latestUserAttachments(ctx.botId, generation));
      const images = photos(source);
      if (!images.length) throw new Error('The message you are handling has no images to forward.');
      add(images.map(file => checkedImage(`"${file.name}"`, file.name, file.data)));
    } else if (ref === 'screenshot') {
      const shot = await desktop.screenshot(await screenFor(ctx.userId, ctx.botId));
      ctx.signal?.throwIfAborted();
      const data = Buffer.from(shot.image.replace(/^data:[^,]*,/, ''), 'base64');
      const ext = shot.mime_type === 'image/png' ? 'png' : 'jpg';
      add([checkedImage('The screenshot', `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, data)]);
    } else {
      const name = posix.basename(ref);
      let data: Buffer;
      try { data = await desktop.download(await screenFor(ctx.userId, ctx.botId), ref); }
      catch (e: any) { throw new Error(`Could not read "${ref}": ${attachDownloadError(e)}.`); }
      add([checkedImage(`"${name}"`, name, data)]);
    }
  }
  return out;
}

const imageCount = (files: UploadedAttachment[]) => files.length ? ` with ${files.length} image${files.length === 1 ? '' : 's'}` : '';

async function shot(ctx: ToolCtx, caption: string): Promise<ToolResult> {
  const desktopId = await screenFor(ctx.userId, ctx.botId);
  ctx.signal?.throwIfAborted();
  await new Promise((r) => setTimeout(r, 700));
  const s = await desktop.screenshot(desktopId);
  if (ctx.textScreen) {
    const words = await desktop.readScreen(desktopId).catch(() => '');
    return {
      output: `${caption} Screen is ${s.width}x${s.height}px. ${words ? 'Visible words (x,y): ' + words : 'No readable text was detected.'}`,
      summary: caption,
    };
  }
  const mime = s.mime_type ?? 'image/png';
  const url = s.image.startsWith('data:') ? s.image : `data:${mime};base64,${s.image}`;
  return {
    output: [
      { type: 'input_text', text: `${caption} Screen is ${s.width}x${s.height}px.` },
      { type: 'input_image', image_url: url, detail: 'high' },
    ],
    summary: caption,
  };
}

async function onScreen<T>(ctx: ToolCtx, fn: (desktopId: string) => Promise<T>) {
  const desktopId = await screenFor(ctx.userId, ctx.botId);
  ctx.signal?.throwIfAborted();
  return fn(desktopId);
}

function botByName(userId: string, name: string) {
  // Visible bots first, so a helper named like a teammate never shadows the teammate.
  return db.prepare('SELECT * FROM bots WHERE user_id=? AND lower(name)=lower(?) AND deleted_at IS NULL ORDER BY COALESCE(hidden,0), created_at').get(userId, String(name ?? '').trim().replace(/^@/, '')) as any;
}

/** Starts a command detached (own session, survives the shell and the turn) and prints its pid; log and exit code land in /workspace/.jobs. */
export const backgroundScript = (job: string, command: string) => {
  if (!/^job-[a-z0-9-]+$/.test(job)) throw new Error('Invalid job id');
  const quoted = `'${`trap '' HUP\n${command}`.replace(/'/g, `'\\''`)}'`;
  return `mkdir -p /workspace/.jobs && cd /workspace || exit 1\n( $(command -v setsid || true) bash -c ${quoted} > /workspace/.jobs/${job}.log 2>&1 < /dev/null; echo $? > /workspace/.jobs/${job}.exit ) > /dev/null 2>&1 & echo $!`;
};

export { githubRepoArg, repoScratch } from './github-checkout.js';

export const TOOLS: ToolDef[] = [
  {
    name: 'computer_screenshot',
    description: "Take a screenshot of your own computer screen (a Linux desktop that only you use). Use this before acting on the screen.",
    parameters: obj({}),
    activity: 'on_its_computer',
    label: 'Looking at the screen',
    impl: async (_a, ctx) => shot(ctx, 'Current screen.'),
  },
  {
    name: 'computer_click',
    description: 'Click at pixel coordinates on your screen. Returns a fresh screenshot.',
    parameters: obj({ x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right', 'middle'] }, double: { type: 'boolean' } }, ['x', 'y']),
    activity: 'on_its_computer',
    label: 'Clicking on screen',
    impl: async (a, ctx) => {
      await onScreen(ctx, (id) => desktop.click(id, { x: a.x, y: a.y, button: a.button ?? 'left', double: !!a.double }));
      return shot(ctx, `Clicked (${a.x}, ${a.y}).`);
    },
  },
  {
    name: 'computer_type',
    description: 'Type text into the focused element on your screen. Returns a fresh screenshot.',
    parameters: obj({ text: { type: 'string' } }, ['text']),
    activity: 'on_its_computer',
    label: 'Typing',
    impl: async (a, ctx) => {
      const text = String(a.text);
      for (let i = 0; i < text.length; i += 1500) await onScreen(ctx, (id) => desktop.type(id, text.slice(i, i + 1500)));
      return shot(ctx, `Typed ${text.length} characters.`);
    },
  },
  {
    name: 'computer_key',
    description: 'Press a key or key combination using X11 keysym names joined by "+", e.g. "Return", "ctrl+l", "ctrl+shift+t", "BackSpace", "Escape", "Page_Down".',
    parameters: obj({ keys: { type: 'string' } }, ['keys']),
    activity: 'on_its_computer',
    label: 'Pressing keys',
    impl: async (a, ctx) => {
      const keys = String(a.keys).split('+').map((k) => (k.length === 1 ? k.toLowerCase() : k)).join('+');
      await onScreen(ctx, (id) => desktop.key(id, keys));
      return shot(ctx, `Pressed ${keys}.`);
    },
  },
  {
    name: 'computer_scroll',
    description: 'Scroll the mouse wheel at a position on your screen.',
    parameters: obj({ x: { type: 'integer' }, y: { type: 'integer' }, direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'integer' } }, ['x', 'y', 'direction']),
    activity: 'on_its_computer',
    label: 'Scrolling',
    impl: async (a, ctx) => {
      await onScreen(ctx, (id) => desktop.scroll(id, { x: a.x, y: a.y, direction: a.direction, amount: a.amount ?? 3 }));
      return shot(ctx, `Scrolled ${a.direction}.`);
    },
  },
  {
    name: 'computer_drag',
    description: 'Drag with the left mouse button from one point to another on your screen.',
    parameters: obj({ start_x: { type: 'integer' }, start_y: { type: 'integer' }, end_x: { type: 'integer' }, end_y: { type: 'integer' } }, ['start_x', 'start_y', 'end_x', 'end_y']),
    activity: 'on_its_computer',
    label: 'Dragging',
    impl: async (a, ctx) => {
      await onScreen(ctx, (id) => desktop.drag(id, a));
      return shot(ctx, 'Dragged.');
    },
  },
  {
    name: 'open_browser',
    description: 'Open a URL in a Chrome window on your screen (your own logged-in browser profile persists between uses). Returns a screenshot.',
    parameters: obj({ url: { type: 'string' } }, ['url']),
    activity: 'browsing_web',
    label: 'Browsing a site',
    impl: async (a, ctx) => {
      const url = new URL(String(a.url));
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Enter an HTTP or HTTPS URL');
      const quoted = "'" + url.href.replace(/'/g, "'\\''") + "'";
      const profile = `${BOX_ROOT}/profiles/${ctx.botId}`;
      const result = await onScreen(ctx, (id) => desktop.bash(id,
        `mkdir -p ${profile} && (setsid nohup chromium --no-sandbox --no-first-run --disable-dev-shm-usage --password-store=basic ` +
        `--user-data-dir=${profile} --start-maximized ${quoted} >/tmp/marion-browser.log 2>&1 < /dev/null &)`, 15));
      if (result.exit_code !== 0) throw new Error(result.output || 'Could not launch Chromium');
      await new Promise(resolve => setTimeout(resolve, 1500));
      return shot(ctx, `Opened ${a.url}.`);
    },
  },
  {
    name: 'save_file',
    description: "Save a deliverable (report, notes, CSV, code, markdown) to your Library so the user can open and download it. Saved under /workspace/files/<your id>/ on your computer.",
    parameters: obj({ filename: { type: 'string', description: 'e.g. briefing-2026-11-09.md' }, content: { type: 'string' } }, ['filename', 'content']),
    activity: 'drafting_file',
    label: 'Saving notes',
    impl: async (a, ctx) => {
      const name = String(a.filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120).replace(/^\.+$/, '') || 'file.txt';
      const dir = `${BOX_ROOT}/files/${ctx.botId}`;
      const data = Buffer.from(String(a.content), 'utf8');
      await onScreen(ctx, async (id) => {
        const init = await desktop.bash(id, `mkdir -p ${dir}`, 30);
        if (init.exit_code !== 0) throw new Error(init.output);
        await desktop.save(id, `${dir}/${name}`, data);
      });
      return { output: JSON.stringify({ ok: true, path: `${dir}/${name}` }), summary: `Saved ${name}` };
    },
  },
  {
    name: 'shell',
    description: 'Run a bash command on your own Linux computer. Use for files, scripts, CLIs and quick data work. Output is truncated to 20k characters. Anything slow (installs, builds, long scripts, servers) should use background: true: it starts at once, keeps running on your computer after this turn, never gets cut off by a timeout, and you check it later with another shell call (the reply names the log and exit-code files).',
    parameters: obj({ command: { type: 'string' }, timeout_seconds: { type: 'integer' }, background: { type: 'boolean', description: 'Run detached and return immediately; output goes to a log file you can read later.' } }, ['command']),
    activity: 'running_commands',
    label: 'Running commands',
    impl: async (a, ctx) => {
      if (a.background) {
        const job = `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        const r = await onScreen(ctx, (id) => desktop.bash(id, backgroundScript(job, String(a.command)), 20));
        const log = `/workspace/.jobs/${job}.log`;
        return { output: JSON.stringify({ background: true, job, pid: r.output.trim() || undefined, log, exit_file: `/workspace/.jobs/${job}.exit`, note: `Running in the background on your computer. Check with: tail -n 50 ${log}; the exit code appears in ${`/workspace/.jobs/${job}.exit`} when it finishes.` }), summary: `Started ${job} in the background` };
      }
      const r = await onScreen(ctx, (id) => desktop.bash(id, String(a.command), Math.min(Math.max(a.timeout_seconds ?? 120, 1), 290)));
      const out = (r.output ?? '').slice(-20000);
      return { output: JSON.stringify({ exit_code: r.exit_code, output: out }), summary: `exit ${r.exit_code}` };
    },
  },
  {
    name: 'folder_list',
    description: 'List files in a folder on the owner\'s Mac that is shared with you (name, size, modified time). Folders end with /.',
    parameters: obj({
      folder: { type: 'string', description: 'Shared folder name or path' },
      path: { type: 'string', description: 'Subfolder inside it' },
      match: { type: 'string', description: 'Name filter with * wildcards, e.g. *.png' },
      limit: { type: 'integer' },
    }, ['folder']),
    activity: 'working',
    label: 'Looking in a folder',
    impl: async (args, ctx) => {
      const result = await listFolder(ctx.botId, args);
      return { output: JSON.stringify(result), summary: `${result.total} items in ${result.folder}` };
    },
  },
  {
    name: 'folder_move',
    description: 'Rename or move files inside a shared folder. Subfolders are created as needed; a "to" ending in / keeps the file name. Never overwrites.',
    parameters: obj({
      folder: { type: 'string', description: 'Shared folder name or path' },
      moves: { type: 'array', maxItems: 500, items: obj({ from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']) },
    }, ['folder', 'moves']),
    activity: 'working',
    label: 'Tidying a folder',
    impl: async (args, ctx) => {
      const result = await moveInFolder(ctx.botId, args);
      return { output: JSON.stringify(result), summary: `Moved ${result.moved} file${result.moved === 1 ? '' : 's'}${result.failed.length ? `, ${result.failed.length} failed` : ''}` };
    },
  },
  {
    name: 'github_create_repo',
    description: 'Create an empty GitHub repository on the Mac after the owner approves. Use the repository-creation form to publish an existing folder.',
    parameters: obj({ name: { type: 'string', description: 'Repository name or owner/name' },
      visibility: { type: 'string', enum: ['private', 'public'] }, description: { type: 'string' } }, ['name', 'visibility']),
    activity: 'thinking',
    label: 'Creating a GitHub repository',
    impl: async (args, ctx) => {
      if (!isDesktop || !ctx.allowSubscriptionTeam) throw new Error('Request repository creation from the Mac app.');
      const { url } = await createGitHubRepo({ name: args.name, description: args.description, visibility: args.visibility });
      return { output: `Created GitHub repository: ${url}`, summary: 'Created GitHub repository' };
    },
  },
  {
    name: 'start_cloud_session',
    description: 'Run work in Claude Cloud on a GitHub repository. Use it whenever the owner asks to work in the cloud (Claude Cloud, a cloud session, --cloud). Marion finds the repository on GitHub from owner/repo, a GitHub URL, or just its name, then starts the Cloud session; it never uses a folder or checkout on this Mac. If the repository is missing, ambiguous or not accessible, Marion shows the owner an in-app card with concrete fixes and continues in the Cloud once they approve.',
    parameters: obj({
      prompt: { type: 'string', description: 'The full task for Claude Cloud. It knows nothing else, so include every detail it needs' },
      repo: { type: 'string', description: 'The GitHub repository: owner/repo, a github.com URL, or the repository name as the owner said it (e.g. "Marion Agent"). Omit only when the owner did not name one' },
      title: { type: 'string', description: 'Optional: a mini title of 3-8 words' },
    }, ['prompt']),
    activity: 'working',
    label: 'Starting Claude Cloud',
    impl: async (args, ctx) => {
      const prompt = args.prompt;
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20_000) throw new Error('Enter a Cloud task of up to 20,000 characters.');
      const query = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim().slice(0, 300) : repoHint(prompt) ?? repoHint(ctx.turn?.request);
      let result: Awaited<ReturnType<typeof launchCloudWork>>;
      try {
        result = await launchCloudWork({ userId: ctx.userId, botId: ctx.botId, generation: getBotRow(ctx.botId)?.generation ?? 0,
          goal: prompt.trim(), title: miniTitle(prompt, args.title), query });
      } catch (error) {
        // The session did not start: a failed tool result, never a "started" message.
        const reason = String((error as Error)?.message ?? error).slice(0, 800);
        const card = (error as { cardShown?: boolean })?.cardShown ? ' An in-app card with the fix is already showing in the chat; the owner can approve it there.' : '';
        throw new Error(`Claude Cloud did NOT start: ${reason}${card} Tell the owner it failed and why; do not say a session started.`);
      }
      if (result.started) return {
        output: `Claude Cloud started on GitHub ${result.repo.nameWithOwner} (${result.repo.url}); Claude confirmed the session. Its live work card is in the chat and in Sessions; updates post here. Tell the owner in one line and end your turn.`,
        summary: `Started Claude Cloud on ${result.repo.nameWithOwner}`,
      };
      return {
        output: `Cloud work is waiting on the owner. Problem: ${result.problem} Fix: ${result.solution} An in-app card with these choices is already showing in the chat: ${result.options.map(o => `"${o.label}"`).join(', ')}. The owner picks or approves there and Marion continues in the Cloud automatically. Relay this in one or two lines and stop; do not say the session started.`,
        summary: `Cloud needs the owner: ${result.blocker}`,
        endTurn: true,
      };
    },
  },
  {
    name: 'ask_subscription',
    description: 'Send a specific request to Claude Code, Codex, or Gemini when the user asks to use that assistant. Returns its response to this chat.',
    parameters: obj({
      provider: { type: 'string', enum: ['claude', 'codex', 'gemini'] },
      prompt: { type: 'string', description: 'The full task. The provider knows nothing else, so include every detail it needs' },
      folder: { type: 'string', description: 'Optional: a folder on this Mac to work in, by name (e.g. "Marion Agent") or full path. It does not need to be shared with you; the owner approves it' },
      repo: { type: 'string', description: 'Optional: a GitHub repository to inspect or use (owner/repo or a github.com URL; public ones always work, on Claude, Codex and Gemini alike). Without a folder, Marion clones it into a scratch folder the assistant works in; nothing on this Mac needs sharing' },
      title: { type: 'string', description: 'Optional: a mini title of 3-8 words for the work card (e.g. "Fix login redirect"). Derived from the prompt if omitted' },
      model: { type: 'string', description: 'Optional: only when the owner names a model (e.g. "Sonnet", "6.2 Astra"). Omit it to use this provider\'s default model from Settings' },
      effort: { type: 'string', description: 'Optional: only when the owner names an effort level (e.g. "low", "high"). Omit it to use this provider\'s default effort from Settings' },
      new_session: { type: 'boolean', description: 'Optional: true to start this provider from a fresh session. Marion also does that by itself when the folder changes, the topic is clearly different, or the session has grown large' },
    }, ['provider', 'prompt']),
    activity: 'working',
    label: 'Asking another assistant',
    impl: async (args, ctx) => {
      const { provider, prompt } = args;
      if (provider !== 'codex' && provider !== 'claude' && provider !== 'gemini') throw new Error('Choose Codex, Claude Code, or Gemini.');
      if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20_000) throw new Error('Enter a request of up to 20,000 characters.');
      // The provider's default model and effort from Settings, unless the request names its own (validated against the catalog).
      const saved = subscriptionSelection(ctx.userId, provider);
      const named = (typeof args.model === 'string' && args.model.trim()) || (typeof args.effort === 'string' && args.effort.trim());
      const selection = named
        ? resolveRunSelection(provider, (await subscriptionModels(provider).catch(() => ({ models: [] }))).models, saved, { model: args.model, effort: args.effort })
        : saved;
      const repo = githubRepoArg(args.repo);
      // A named repository without a folder: Marion clones it into a fresh scratch folder (nothing of the owner's) that
      // the assistant works in, the same way for every provider.
      const checkout: RepoCheckout | undefined = !args.folder && repo ? await prepareRepoCheckout(repo, ctx.signal) : undefined;
      const folder = args.folder ? await folderForTask(ctx.botId, args.folder) : checkout?.folder;
      const name = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' }[provider as 'claude' | 'codex' | 'gemini'];
      const generation = getBotRow(ctx.botId)?.generation ?? 0;
      // Continue this chat's session with the provider, or start a fresh one (asked for, new folder, big, or a new topic).
      const plan = planRelaySession({ botId: ctx.botId, generation, provider, prompt, folder: folder?.path, newSession: args.new_session === true });
      // The user's screenshots and screen recordings (as frames) go along with the request.
      const media = await relayMedia(ctx.botId, ctx.triggerAttachments);
      const task = [
        plan.carried,
        prompt,
        media.note,
        checkout ? checkout.note : repo ? `GitHub repository: ${repo} (https://github.com/${repo}). Clone it into your working folder if you need its files (git clone --depth 1 is enough to read it).` : '',
        folder ? `Work only inside this folder: ${folder.path} (the owner calls it "${folder.label}"; use full paths). ${folder.write ? 'You can read, create, rename and move files there.' : 'You can only read there.'} Finish with a short summary of what you did.` : '',
        ASK_OWNER_LINE,
        leanLine(ctx.botId, Boolean(folder)),
      ].filter(Boolean).join('\n\n');
      // The card names the provider and the exact model it runs ("Claude · Opus 5.5"); the model is refreshed once the CLI resolves it.
      const card = new WorkCard(ctx.botId, ctx.userId, {
        title: miniTitle(prompt, args.title), detail: prompt.split('\n')[0], reporter: getBotRow(ctx.botId)?.name,
        agents: [{ id: 'worker-0', label: name, provider, model: selection.model, role: 'worker', modelLabel: modelLabel(provider, selection.model, selection.label), effort: selection.effort }],
      });
      const who = name;
      const askedAt = Date.now();
      if (plan.rotated) card.step(who, 'note', `Fresh session: ${plan.rotated}`);
      if (checkout) card.step(who, 'note', checkout.checkout ? `Cloned GitHub ${checkout.repo}` : `Could not clone GitHub ${checkout.repo} ahead; ${name} clones it`);
      if (media.images.length) card.step(who, 'note', `Sent ${media.images.length} image${media.images.length === 1 ? '' : 's'} from your message`);
      try {
        let used: number | undefined;
        // No waiting: any number of relayed sessions run at once, even in the same folder; the card just says it shares it.
        const text = await withFolder(folder, ctx.signal, others => card.step(who, 'note', `Running alongside ${others} other session${others === 1 ? '' : 's'} in ${folder?.label}`), () => subscriptionReply(selection, task, ctx.signal ?? new AbortController().signal, media.images, {
          folder, handoffProgress: plan.carried ? [plan.carried] : [], handoffContinuation: ctx.turn?.handoff, onStep: card.feed(who), onModel: model => card.setModel('worker-0', model), onTaskUsage: card.usage('worker-0'), onUsage: counts => { used = (counts.input ?? 0) + (counts.output ?? 0) || undefined; },
          session: {
            id: `ask:${ctx.botId}:${generation}:${askedAt}:${relayRunId()}`, kind: 'ask_subscription', userId: ctx.userId, botId: ctx.botId,
            request: prompt, title: miniTitle(prompt, args.title), folder: checkout ? { path: `https://github.com/${checkout.repo}`, label: checkout.repo } : folder && { path: folder.path, label: folder.label },
            groupId: `${ctx.botId}:${generation}:${provider}:${plan.session.startedAt}`, rotated: plan.rotated,
          },
        }));
        recordRelayTurn(plan.session, prompt, text, used);
        // Needs the owner (approval, a choice, a missing detail): an action card goes up right away.
        const request = ownerRequest(text);
        if (request) {
          card.step(who, 'question', request.question);
          showQuestionCard(ctx.botId, ctx.userId, request.question, request.options);
        }
        card.finish(request ? 'needs-input' : 'done', request?.question, request?.options);
        return {
          output: request ? `${text}\n\n${name} is asking the owner something. An action card with that question${request.options.length ? ` and the options ${request.options.map(o => `"${o}"`).join(', ')}` : ''} is already showing: relay the reply in a line or two and stop. Do not call ask_user again; the owner's answer arrives as their next message.` : text,
          summary: folder ? `${provider} worked in ${folder.label}` : `Received a reply from ${provider}`,
        };
      } catch (error) {
        card.step(who, 'error', String((error as Error).message ?? error));
        card.finish(ctx.signal?.aborted ? 'stopped' : 'failed');
        throw error;
      } finally {
        await checkout?.cleanup();
      }
    },
  },
  {
    name: 'orchestrate',
    description: 'Run a model team when the owner names an orchestrator and subagents (e.g. "use 6.2 Astra as the orchestrator and run Gemini 4 Neon subagents"). The orchestrator plans phases, subagents do the work, the orchestrator reviews it; progress shows live in the chat. You only relay and report: never do the work yourself.',
    parameters: obj({
      goal: { type: 'string', description: 'The owner\'s full request, with every detail' },
      orchestrator: { type: 'string', description: 'Model name as the owner said it' },
      workers: { type: 'array', items: { type: 'string' }, description: 'Subagent model names as the owner said them' },
      worker_count: { type: 'integer', description: 'How many subagents to run (default: one per name)' },
      folder: { type: 'string', description: 'Optional folder on this Mac to work in (name or full path); it does not need to be shared with you' },
      repo: { type: 'string', description: 'Optional: a GitHub repository the team works on (owner/repo or a github.com URL; public ones always work). Without a folder, Marion clones it into a scratch folder every subagent shares, whatever its provider' },
      title: { type: 'string', description: 'A short title for the work' },
    }, ['goal', 'orchestrator', 'workers']),
    activity: 'messaging_named',
    label: 'Orchestrating a team',
    impl: async (args, ctx) => {
      const repo = githubRepoArg(args.repo);
      const checkout = !args.folder && repo ? await prepareRepoCheckout(repo, ctx.signal) : undefined;
      try {
        const folder = args.folder ? await folderForTask(ctx.botId, args.folder) : checkout?.folder;
        const repoLine = checkout ? checkout.note : repo ? `GitHub repository: ${repo} (https://github.com/${repo}).` : '';
        const goal = repoLine ? `${String(args.goal ?? '').trim().slice(0, 18_000)}\n\n${repoLine}` : args.goal;
        // Never waits for other sessions in the folder: the team starts right away, alongside anything else running there.
        return await withFolder(folder, ctx.signal, others => appendRow(ctx.botId, 'notice', { type: 'notice', tone: 'info', text: `Running alongside ${others} other session${others === 1 ? '' : 's'} in ${folder?.label}.` }), () => orchestrate(ctx, { ...args, goal }, folder));
      } finally {
        await checkout?.cleanup();
      }
    },
  },
  {
    ...appControlTool,
    activity: 'working',
    label: 'Changing Marion Agent',
    impl: async (args, ctx) => runAppControl(ctx, args),
  },
  {
    name: 'team_models',
    description: 'List available Team mode models with provider, exact model ID, and supported reasoning efforts. Check this before creating a team.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking team models',
    impl: async (_args, ctx) => ({
      output: JSON.stringify({ models: await teamModels(Boolean(ctx.allowSubscriptionTeam)), team: orchestrationForBot(ctx.botId) }),
      summary: 'Checked available team models',
    }),
  },
  {
    name: 'team_setup',
    description: 'Set up or change this chat’s named model team when the user explicitly requests it. The current chat model leads. List available models first. Use team_delegate or team_discuss after setup if the user asked you to run the work.',
    parameters: obj({
      members: {
        type: 'array', minItems: 1, maxItems: 6,
        items: obj({
          provider: { type: 'string', enum: ['local', 'codex', 'gemini', 'claude'] },
          model: { type: 'string' },
          label: { type: 'string' },
          role: { type: 'string' },
        }, ['provider', 'model', 'label', 'role']),
      },
    }, ['members']),
    activity: 'working',
    label: 'Setting up the team',
    impl: async (args, ctx) => {
      const previous = orchestrationForBot(ctx.botId);
      const settings = await validateTeamSettings({
        enabled: true, members: args.members, balanceUsage: previous.balanceUsage,
      }, Boolean(ctx.allowSubscriptionTeam));
      if (!settings.enabled) throw new Error('Choose at least one team member.');
      ctx.signal?.throwIfAborted();
      saveOrchestration(ctx.botId, settings);
      emitBot(ctx.botId);
      const names = settings.members.map(member => member.label);
      return { output: `Team mode enabled with ${names.join(', ')}.`, summary: 'Set up the model team' };
    },
  },
  {
    name: 'team_delegate',
    description: 'Team mode: hand pieces of work to the models on your team and get their results back. mode "parallel" runs independent pieces at the same time; mode "chain" runs them in order and each member sees what the previous one wrote (e.g. draft → review → fix). member is a team member\'s name, a provider (codex, gemini, claude, local), or "auto" to pick whoever has the most plan usage left.',
    parameters: obj({
      assignments: {
        type: 'array', minItems: 1,
        items: obj({ member: { type: 'string', description: 'Team member name, provider, or "auto"' }, task: { type: 'string', description: 'A complete, self-contained task with everything the member needs' } }, ['member', 'task']),
      },
      mode: { type: 'string', enum: ['parallel', 'chain'] },
      repo: { type: 'string', description: 'Optional: a GitHub repository the members work on (owner/repo or a github.com URL; public ones always work). Marion clones it into a scratch folder Claude, Codex and Gemini members share' },
    }, ['assignments', 'mode']),
    activity: 'messaging_named',
    label: 'Working with the team',
    impl: async (args, ctx) => teamDelegate(ctx.botId, args, ctx.signal ?? new AbortController().signal, ctx.triggerAttachments),
  },
  {
    name: 'team_discuss',
    description: 'Team mode: have team members talk a problem through together, taking turns and responding to each other for 1–3 rounds, ending with a shared recommendation. Use for plans, designs, reviews and hard decisions.',
    parameters: obj({
      topic: { type: 'string', description: 'What the team should discuss, with all needed context' },
      members: { type: 'array', items: { type: 'string' }, description: 'Member names to include (default: the whole team)' },
      rounds: { type: 'integer', minimum: 1, maximum: 3 },
    }, ['topic']),
    activity: 'messaging_named',
    label: 'Team discussion',
    impl: async (args, ctx) => teamDiscuss(ctx.botId, args, ctx.signal ?? new AbortController().signal, ctx.triggerAttachments),
  },
  {
    name: 'remember',
    description: 'Save a durable memory about the user, their preferences, or your job, so you remember it in future conversations. Set universal: true only for a fact every Bot on the team should know (it is shared with all Bots).',
    parameters: obj({ text: { type: 'string' }, universal: { type: 'boolean', description: 'Optional. true = remember for every Bot on the team' } }, ['text']),
    activity: 'remembering',
    label: 'Saving notes',
    impl: async (a, ctx) => {
      if (a.universal === true) {
        const r = addUniversalMemory(ctx.userId, a.text);
        return r.ok
          ? { output: r.created ? 'Saved to universal memory (every Bot will remember it).' : 'Already in universal memory.', summary: 'Saved a universal memory' }
          : { output: r.message };
      }
      db.prepare('INSERT INTO memories(id,bot_id,text,created_at) VALUES (?,?,?,?)').run(newId('mem'), ctx.botId, String(a.text), now());
      return { output: 'Saved to memory.', summary: 'Saved a memory' };
    },
  },
  {
    name: 'recall',
    description: 'Search your saved memories and the universal memories shared by every Bot.',
    parameters: obj({ query: { type: 'string' } }, ['query']),
    activity: 'remembering',
    label: 'Searching memory',
    impl: async (a, ctx) => {
      const words = String(a.query).toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const all = db.prepare('SELECT text, created_at FROM memories WHERE bot_id=? ORDER BY created_at DESC').all(ctx.botId) as any[];
      const hits = all.filter((m) => !words.length || words.some((w) => m.text.toLowerCase().includes(w))).slice(0, 20);
      return { output: JSON.stringify([...searchUniversalMemories(ctx.userId, words), ...hits.map((h) => h.text)]) };
    },
  },
  {
    name: 'create_routine',
    description: 'Create a recurring routine you will run on a schedule. `schedule` is a 5-field cron expression (minute hour day-of-month month day-of-week), e.g. "0 8 * * 1-5" for weekdays at 8:00. `prompt` is the instruction you will follow each time it runs.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string', description: 'IANA timezone, e.g. America/New_York' } }, ['name', 'prompt', 'schedule']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      try { new Cron(a.schedule, { paused: true, timezone: a.timezone || 'UTC' }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      const id = newId('rt');
      db.prepare('INSERT INTO routines(id,bot_id,name,prompt,schedule,timezone,enabled,created_at) VALUES (?,?,?,?,?,?,1,?)').run(id, ctx.botId, a.name, a.prompt, a.schedule, a.timezone || 'UTC', now());
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(id));
      scheduleRoutine(r);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${a.name} · ${describeCron(a.schedule)}`, ref: id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }), summary: `Created routine ${a.name}` };
    },
  },
  {
    name: 'list_event_triggers',
    description: 'List the event triggers a connected app offers (e.g. new email, new Slack message, new GitHub PR), with each trigger\'s config fields. Use before create_event_routine.',
    parameters: obj({ toolkit: { type: 'string', description: 'Composio toolkit slug, e.g. gmail, slack, github, googlecalendar' } }, ['toolkit']),
    activity: 'connecting_service',
    label: 'Using a connected app',
    impl: async (a) => ({ output: JSON.stringify(await listTriggerTypes(String(a.toolkit).toLowerCase())) }),
  },
  {
    name: 'create_event_routine',
    description: 'Create a routine that runs whenever an event happens in a connected app (instead of on a schedule). `trigger_slug` comes from list_event_triggers; `config_json` is a JSON object string with that trigger\'s config fields (use "{}" if none). `prompt` is what you will do each time, given the event payload.',
    parameters: obj({ name: { type: 'string' }, prompt: { type: 'string' }, trigger_slug: { type: 'string' }, config_json: { type: 'string' } }, ['name', 'prompt', 'trigger_slug']),
    activity: 'working',
    label: 'Setting up a routine',
    impl: async (a, ctx) => {
      let config: Record<string, unknown> = {};
      try { config = a.config_json ? JSON.parse(a.config_json) : {}; } catch { return { output: 'config_json must be a JSON object string.' }; }
      try {
        const r = await createEventRoutine(ctx.userId, ctx.botId, { name: a.name, prompt: a.prompt, trigger_slug: a.trigger_slug, config });
        appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-created', text: `Routine created: ${a.name} · ${describeEvent(`event:${String(a.trigger_slug).toUpperCase()}`)}`, ref: r.id });
        hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
        return { output: JSON.stringify({ ok: true, routine_id: r.id }), summary: `Created event routine ${a.name}` };
      } catch (e: any) {
        return { output: `Could not create the trigger: ${e?.message ?? e}. If the app isn't connected, call request_app_connection first.` };
      }
    },
  },
  {
    name: 'stay_silent',
    description: 'End this turn without sending the user anything. Use during check-ins, routines or bot-to-bot exchanges when there is nothing worth telling the user.',
    parameters: obj({ reason: { type: 'string' } }),
    activity: 'working',
    label: 'Finishing up',
    impl: async () => ({ output: 'OK, staying silent. End your turn now without writing a reply.', endTurn: true, summary: 'Stayed silent' }),
  },
  {
    name: 'set_checkins',
    description: "Turn proactive check-ins on or off and set when they happen (only the primary Bot does check-ins). times are local 24h 'HH:MM' strings; timezone is IANA (e.g. America/Los_Angeles). Ask the user for their timezone if you don't know it.",
    parameters: obj({ enabled: { type: 'boolean' }, times: { type: 'array', items: { type: 'string' } }, timezone: { type: 'string' } }, ['enabled']),
    activity: 'working',
    label: 'Updating check-ins',
    impl: async (a, ctx) => {
      try {
        const r = setCheckins(ctx.userId, { enabled: !!a.enabled, times: a.times, timezone: a.timezone });
        return { output: JSON.stringify({ ok: true, ...r }), summary: r.enabled ? `Check-ins at ${r.times.join(', ')} ${r.timezone}` : 'Check-ins off' };
      } catch (e: any) {
        return { output: `Could not update check-ins: ${e?.message ?? e}` };
      }
    },
  },
  {
    name: 'list_routines',
    description: 'List your routines.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking routines',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listRoutines(ctx.botId)) }),
  },
  {
    name: 'update_routine',
    description: 'Change or pause one of your routines.',
    parameters: obj({ routine_id: { type: 'string' }, name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string' }, timezone: { type: 'string' }, enabled: { type: 'boolean' } }, ['routine_id']),
    activity: 'working',
    label: 'Updating a routine',
    impl: async (a, ctx) => {
      const cur = db.prepare('SELECT * FROM routines WHERE id=? AND bot_id=?').get(a.routine_id, ctx.botId) as any;
      if (!cur) return { output: 'No such routine.' };
      const next = { ...cur, name: a.name ?? cur.name, prompt: a.prompt ?? cur.prompt, schedule: a.schedule ?? cur.schedule, timezone: a.timezone ?? cur.timezone, enabled: a.enabled === undefined ? cur.enabled : a.enabled ? 1 : 0 };
      try { new Cron(next.schedule, { paused: true, timezone: next.timezone }); } catch (e: any) { return { output: `Invalid schedule: ${e.message}` }; }
      db.prepare('UPDATE routines SET name=?,prompt=?,schedule=?,timezone=?,enabled=? WHERE id=?').run(next.name, next.prompt, next.schedule, next.timezone, next.enabled, cur.id);
      const r = toRoutine(db.prepare('SELECT * FROM routines WHERE id=?').get(cur.id));
      r.enabled ? scheduleRoutine(r) : unscheduleRoutine(r.id);
      appendRow(ctx.botId, 'event', { type: 'event', event: 'routine-updated', text: `Routine updated: ${r.name} · ${r.enabled ? r.description : 'Paused'}`, ref: r.id });
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: JSON.stringify({ ok: true, routine: r }) };
    },
  },
  {
    name: 'delete_routine',
    description: 'Delete one of your routines.',
    parameters: obj({ routine_id: { type: 'string' } }, ['routine_id']),
    activity: 'working',
    label: 'Removing a routine',
    impl: async (a, ctx) => {
      unscheduleRoutine(a.routine_id);
      await deleteEventTrigger(a.routine_id);
      db.prepare('DELETE FROM routines WHERE id=? AND bot_id=?').run(a.routine_id, ctx.botId);
      hub.emit(ctx.userId, { type: 'routines', botId: ctx.botId });
      return { output: 'Deleted.' };
    },
  },
  {
    name: 'create_task',
    description: 'Track a piece of work the user asked for as a task (use one per request when asked for several things at once). The task is yours unless bot_name names another active Bot on the team. If that Bot already has an open task with the same title, no duplicate is made and the existing task_id is returned (created: false); done tasks never block a new one.',
    parameters: obj({
      title: { type: 'string' },
      bot_name: { type: 'string', description: 'Optional: the name of another active Bot on the team to assign the task to. Leave out to assign it to yourself.' },
    }, ['title']),
    activity: 'working',
    label: 'Making a task',
    impl: async (a, ctx) => {
      const r = createTask(db, { userId: ctx.userId, callerBotId: ctx.botId, title: a.title, botName: a.bot_name, newId: () => newId('task'), now });
      if (!r.ok) return { output: JSON.stringify({ ok: false, error: r.error, message: r.message }) };
      if (r.created) hub.emit(ctx.userId, { type: 'tasks', botId: r.botId });
      return {
        output: JSON.stringify(r.created
          ? { ok: true, created: true, task_id: r.taskId, bot: r.botName }
          : { ok: true, created: false, duplicate: true, task_id: r.taskId, bot: r.botName, state: r.state, message: `${r.botId === ctx.botId ? 'You already have' : `${r.botName} already has`} an open task "${r.title}" (${r.state}); no new task was made.` }),
        summary: r.created ? (r.botId === ctx.botId ? undefined : `Task for ${r.botName}`) : 'Task already open',
      };
    },
  },
  {
    name: 'update_task',
    description: 'Update a task assigned to you, or one you assigned to another Bot: state is working, needs_input, or done. Returns ok: true with the new and previous state only when the task really changed; fails (ok: false, with error not_found, not_owner or invalid_state) if the task_id does not exist, belongs to an unrelated Bot, or the state is invalid. Never report a task as updated unless ok is true.',
    parameters: obj({ task_id: { type: 'string' }, state: { type: 'string', enum: [...TASK_STATES] }, note: { type: 'string' } }, ['task_id', 'state']),
    activity: 'working',
    label: 'Updating a task',
    impl: async (a, ctx) => {
      const r = updateTask(db, { userId: ctx.userId, callerBotId: ctx.botId, taskId: a.task_id, state: a.state, note: a.note, now });
      if (!r.ok) return { output: JSON.stringify({ ok: false, error: r.error, message: r.message }) };
      hub.emit(ctx.userId, { type: 'tasks', botId: r.botId });
      return { output: JSON.stringify({ ok: true, task_id: r.taskId, state: r.state, previous_state: r.previousState }) };
    },
  },
  {
    name: 'list_team',
    description: "List every Bot on the user's team with its live status (idle, working or waiting for the user) and routing fields: name (for send_to_bot), job, role, model, last active time. No message text by default; to read a Bot's latest message, name it in messages_from. Use before delegating.",
    parameters: obj({
      messages_from: { type: 'array', items: { type: 'string' }, description: 'Optional: names of the Bots whose latest message (first 200 characters) to include. Leave out for none.' },
    }),
    activity: 'working',
    label: 'Checking the team',
    impl: async (a, ctx) => ({ output: JSON.stringify(teamRoster(ctx.userId, ctx.botId, getLive, { messagesFrom: a.messages_from })), summary: 'Checked the team' }),
  },
  {
    name: 'create_bot',
    description: 'Create a new Bot on the user\'s team (only when the user asked for one). Give it one clear job, concrete instructions with anti-jobs, only the integrations it needs, 1-3 skills, and routines only for scheduled jobs (paused unless the user asked to start them).',
    parameters: obj({
      name: { type: 'string' },
      job: { type: 'string', description: 'One line: what the Bot does' },
      description: { type: 'string', description: '2-4 sentences shown on its profile' },
      instructions: { type: 'string' },
      avatar_color: { type: 'string', enum: ['brown', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'gray', 'black'] },
      avatar_shape: { type: 'string', enum: [...AVATAR_SHAPE_IDS], description: `The Bot's icon, pick one that suits its job: ${AVATAR_SHAPE_IDS.join(', ')}` },
      executive: { type: 'boolean', description: 'True only for a Bot whose job is coordinating other Bots' },
      integrations: { type: 'array', items: { type: 'string' }, description: 'Composio toolkit slugs, e.g. gmail, slack, notion' },
      memories: { type: 'array', items: { type: 'string' } },
      skills: { type: 'array', items: obj({ name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string' } }, ['name', 'description', 'body']) },
      routines: { type: 'array', items: obj({ name: { type: 'string' }, prompt: { type: 'string' }, schedule: { type: 'string', description: '5-field cron' }, timezone: { type: 'string' }, enabled: { type: 'boolean' } }, ['name', 'prompt', 'schedule', 'timezone', 'enabled']) },
    }, ['name', 'job', 'description', 'instructions', 'avatar_color', 'avatar_shape', 'executive', 'integrations', 'memories', 'skills', 'routines']),
    activity: 'working',
    label: 'Creating a Bot',
    impl: async (a, ctx) => {
      const name = String(a.name ?? '').trim();
      if (!name) return { output: 'Give the Bot a name.' };
      if (a.avatar_shape && !normalizeAvatarShape(a.avatar_shape)) return { output: `Pick a Bot icon: ${AVATAR_SHAPE_IDS.join(', ')}.` };
      if (botByName(ctx.userId, name)) return { output: `A Bot named "${name}" already exists. Pick another name.` };
      const recent = (db.prepare('SELECT COUNT(*) n FROM bots WHERE user_id=? AND created_at>?').get(ctx.userId, now() - 3600_000) as any).n;
      if (recent >= 10) return { output: 'Too many Bots were created in the last hour. Ask the user before creating more.' };
      const bot = createBotRecord(ctx.userId, {
        name, label: a.job, description: a.description, instructions: a.instructions,
        avatarColor: a.avatar_color, avatarShape: normalizeAvatarShape(a.avatar_shape) ?? undefined, role: a.executive ? 'executive' : null,
        integrations: Array.isArray(a.integrations) ? a.integrations : [], memories: Array.isArray(a.memories) ? a.memories : [],
        // Routines start paused: the user turns them on, so nothing runs (or spends usage) unapproved.
        skills: Array.isArray(a.skills) ? a.skills : [], routines: Array.isArray(a.routines) ? a.routines.map((r: any) => ({ ...r, enabled: false })) : [], templateId: 'bot-builder',
      });
      appendRow(ctx.botId, 'event', { type: 'event', event: 'bot-message', text: `Created ${bot.name}` });
      return { output: JSON.stringify({ ok: true, name: bot.name, id: bot.id, note: 'It now appears in the user\'s chat list.' }), summary: `Created ${bot.name}` };
    },
  },
  {
    name: 'save_skill',
    description: 'Save or update one of your own skills: a short step-by-step playbook for a task you will do again. Use it when the user teaches you a process (including by screen recording), corrects how you did something, or you find a better way. Same name = update. If the name matches a universal skill (shared by every Bot, like Token optimizer), that universal skill is updated for the whole team. Set universal: true to save a new skill for every Bot instead of only yourself.',
    parameters: obj({ name: { type: 'string' }, description: { type: 'string' }, body: { type: 'string', description: 'Numbered steps, 3-15 lines' }, universal: { type: 'boolean', description: 'Optional. true = apply to every Bot on the team' } }, ['name', 'description', 'body']),
    activity: 'working',
    label: 'Saving a skill',
    impl: async (a, ctx) => {
      const result = saveLearnedSkill(ctx.botId, String(a.name ?? ''), String(a.description ?? ''), String(a.body ?? ''), { universal: typeof a.universal === 'boolean' ? a.universal : undefined });
      return { output: result.message, summary: result.message };
    },
  },
  {
    name: 'send_to_bot',
    description: "Send a message to another Bot on the user's team (by name) to delegate work or ask a question. Their reply will arrive later as a new message to you.",
    parameters: obj({ bot_name: { type: 'string' }, message: { type: 'string' }, attach: attachSchema }, ['bot_name', 'message']),
    activity: 'messaging_named',
    label: 'Messaging a Bot',
    impl: async (a, ctx) => {
      const target = botByName(ctx.userId, a.bot_name);
      if (!target) return { output: `No bot named "${a.bot_name}". Team: ${(db.prepare('SELECT name FROM bots WHERE user_id=? AND COALESCE(hidden,0)=0').all(ctx.userId) as any[]).map((b) => b.name).join(', ')}` };
      if (target.id === ctx.botId) return { output: 'That is you.' };
      if (target.kind === 'room') return { output: `"${target.name}" is a group chat; use post_to_group instead.` };
      if (target.hidden && target.parent_bot_id !== ctx.botId && target.id !== ctx.replyTo) return { output: `"${target.name}" is another Bot's helper. Message its parent instead.` };
      const replying = target.id === ctx.replyTo;
      // Refuse before collecting images: a screenshot or file path would otherwise start the computer for nothing.
      const blocked = botMessageBlock(ctx.botId, target.id, ctx.depth + 1);
      if (blocked) return { output: `Not sent: ${blocked}. Answer the user directly instead.` };
      let attachments: UploadedAttachment[];
      try { attachments = await collectBotAttachments(ctx, a.attach); }
      catch (e: any) { return { output: `Not sent: ${e?.message ?? e}` }; }
      try {
        ctx.enqueueBotMessage(ctx.botId, target.id, String(a.message), ctx.depth + 1, { autoReply: replying, attachments });
      } catch (e: any) {
        return { output: `Not sent: ${e?.message ?? e}. Answer the user directly instead.` };
      }
      ctx.messaged?.add(target.id);
      return { output: replying ? `Replied to ${target.name}${imageCount(attachments)}.` : `Sent to ${target.name}${imageCount(attachments)}. Their reply will come back to you as a message; end your turn now unless you have other work.`, summary: `Messaged ${target.name}` };
    },
  },
  {
    name: 'spawn_subagent',
    description: 'Start a subagent: a helper copy of you with its own context and its own computer screen, to work on one goal in parallel (e.g. research one company each). It reports back to you as a message when done. There is no limit: start as many as the work needs, all working at the same time, and remove each once you have its result.',
    parameters: obj({ goal: { type: 'string', description: 'Self-contained task with everything the subagent needs to know' }, label: { type: 'string', description: 'Short name, e.g. "Acme research"' } }, ['goal']),
    activity: 'messaging_named',
    label: 'Starting a helper',
    impl: async (a, ctx) => {
      if (ctx.depth >= 2) return { output: 'Subagents cannot start more subagents. Do the work yourself.' };
      try {
        const sub = createSubagent(ctx.botId, String(a.goal), a.label);
        ctx.enqueueBotMessage(ctx.botId, sub.id, String(a.goal), ctx.depth + 1);
        return { output: JSON.stringify({ ok: true, subagent_id: sub.id, name: sub.name, note: 'It will report back to you as a message. Continue with other work or end your turn.' }), summary: `Started ${sub.name}` };
      } catch (e: any) {
        return { output: String(e?.message ?? e) };
      }
    },
  },
  {
    name: 'list_subagents',
    description: 'List your subagents with their status and latest message.',
    parameters: obj({}),
    activity: 'working',
    label: 'Checking on helpers',
    impl: async (_a, ctx) => ({ output: JSON.stringify(listSubagents(ctx.botId)) }),
  },
  {
    name: 'message_subagent',
    description: 'Send a follow-up instruction to one of your subagents.',
    parameters: obj({ subagent_id: { type: 'string' }, message: { type: 'string' } }, ['subagent_id', 'message']),
    activity: 'messaging_named',
    label: 'Checking with a helper',
    impl: async (a, ctx) => {
      const sub = db.prepare('SELECT id FROM bots WHERE id=? AND parent_bot_id=?').get(a.subagent_id, ctx.botId) as any;
      if (!sub) return { output: 'No such subagent.' };
      try { ctx.enqueueBotMessage(ctx.botId, sub.id, String(a.message), ctx.depth + 1); }
      catch (e: any) { return { output: `Not sent: ${e?.message ?? e}` }; }
      ctx.messaged?.add(sub.id);
      return { output: 'Sent.' };
    },
  },
  {
    name: 'stop_subagent',
    description: 'Stop and remove one of your subagents (do this once you have its result).',
    parameters: obj({ subagent_id: { type: 'string' } }, ['subagent_id']),
    activity: 'working',
    label: 'Wrapping up a helper',
    impl: async (a, ctx) => {
      const { interrupt } = await import('./loop.js');
      interrupt(String(a.subagent_id));
      return { output: await deleteSubagent(ctx.botId, String(a.subagent_id)) ? 'Stopped and removed.' : 'No such subagent.' };
    },
  },
  {
    name: 'create_group',
    description: "Create a group chat between the user and several Bots on the team (by name). It appears in the user's sidebar; when the user posts there, the relevant Bots answer.",
    parameters: obj({ name: { type: 'string' }, bot_names: { type: 'array', items: { type: 'string' } } }, ['name', 'bot_names']),
    activity: 'working',
    label: 'Setting up a group',
    impl: async (a, ctx) => {
      const ids: string[] = [];
      const missing: string[] = [];
      for (const n of (a.bot_names ?? []) as string[]) {
        const b = botByName(ctx.userId, n);
        if (b && b.kind !== 'room') ids.push(b.id); else missing.push(n);
      }
      if (ids.length < 2) return { output: `A group needs at least 2 Bots. Not found: ${missing.join(', ') || 'none'}.` };
      const id = createRoom(ctx.userId, String(a.name), [...new Set(ids)]);
      appendRow(id, 'event', { type: 'event', event: 'bot-message', text: `Group created with ${(a.bot_names as string[]).filter((n) => !missing.includes(n)).join(', ')}` });
      return { output: JSON.stringify({ ok: true, group_id: id, missing }), summary: `Created group ${a.name}` };
    },
  },
  {
    name: 'post_to_group',
    description: 'Post a message into a group chat you are a member of.',
    parameters: obj({ group_name: { type: 'string' }, text: { type: 'string' }, attach: attachSchema }, ['group_name', 'text']),
    activity: 'messaging_named',
    label: 'Posting to the group',
    impl: async (a, ctx) => {
      // Unknown group or not a member: refuse before collecting images (no screenshot, no computer start-up).
      const room = roomForPost(ctx.botId, String(a.group_name));
      if (typeof room === 'string') return { output: room };
      let attachments: UploadedAttachment[];
      try { attachments = await collectBotAttachments(ctx, a.attach); }
      catch (e: any) { return { output: `Not posted: ${e?.message ?? e}` }; }
      const out = postToRoom(ctx.botId, String(a.group_name), String(a.text), attachments);
      return { output: out, summary: `Posted to ${a.group_name}`, endTurn: out === 'Posted to the group.' };
    },
  },
  {
    name: 'ask_user',
    description: 'Ask the user a multiple-choice question when you need a decision before continuing. Ends your turn; their answer arrives as their next message.',
    parameters: obj({ question: { type: 'string' }, options: { type: 'array', items: { type: 'string' } } }, ['question', 'options']),
    activity: 'waiting_for_you',
    label: 'Waiting on you',
    impl: async (a, ctx) => {
      showQuestionCard(ctx.botId, ctx.userId, String(a.question ?? ''), Array.isArray(a.options) ? a.options.map(String) : []);
      return { output: 'Question shown to the user. Stop here and wait for their answer.', endTurn: true };
    },
  },
  {
    name: 'request_app_connection',
    description: 'Ask the user to connect an app (e.g. gmail, googlecalendar, slack, github, notion, linear) so you can use it. Use the Composio toolkit slug.',
    parameters: obj({ toolkit: { type: 'string' }, reason: { type: 'string' } }, ['toolkit', 'reason']),
    activity: 'connecting_service',
    label: 'Using a connected app',
    impl: async (a, ctx) => {
      const info = await toolkitInfo(String(a.toolkit).toLowerCase());
      if (!info) return { output: `Unknown toolkit "${a.toolkit}". Use COMPOSIO_SEARCH_TOOLS to find the right toolkit slug.` };
      appendRow(ctx.botId, 'card', { type: 'card', card: 'connect', toolkit: info.slug, toolkitName: info.name, logo: info.logo, reason: a.reason, status: 'pending' });
      return { output: `Asked the user to connect ${info.name}. Stop here; you'll be told when it's connected.`, endTurn: true };
    },
  },
];

if (grok) {
  const client = grok;
  TOOLS.push({
    name: 'ask_grok',
    description: 'Ask the optional hosted Grok model a standalone question. After approval, the exact prompt goes to xAI. Submit only the information needed for the question.',
    parameters: obj({ prompt: { type: 'string' } }, ['prompt']),
    activity: 'working',
    label: 'Asking Grok',
    impl: async (args) => {
      const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
      if (!prompt || prompt.length > 6000) throw new Error('Enter a prompt of 1–6,000 characters');
      const reply = await client.responses.create({ model: env.xaiModel, input: prompt, store: false, max_output_tokens: 2000 });
      return { output: reply.output_text || 'Grok returned no text.', summary: 'Received a Grok response' };
    },
  });
}

// Marion Life planner tools: every bot gets them while the Life connection is on (Settings → Marion Life),
// unless that bot's access is switched off there. They use the saved key; it never reaches a model.
const lifeTools = new Set<string>();
for (const name of Object.keys(lifePlannerTools) as LifePlannerTool[]) {
  const tool = lifePlannerTools[name];
  const toolName = `marion_life_${name}`;
  lifeTools.add(toolName);
  TOOLS.push({
    name: toolName,
    description: `Marion Life: ${tool.description}`,
    parameters: obj(
      Object.fromEntries(('fields' in tool ? Object.entries(tool.fields) : []).map(([key, type]) => [key, { type }])),
      'required' in tool ? tool.required : [],
    ),
    activity: 'connecting_service',
    label: 'Using Marion Life',
    impl: async (args, ctx) => ({
      output: await runLifePlannerTool(ctx.userId, ctx.botId, name, args, ctx.signal),
      summary: 'write' in tool ? 'Marion Life saved it' : 'Marion Life responded',
    }),
  });
}

export const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

/** Tool schemas for a bot. Marion Life tools appear only when that bot may use the Life connection. */
export function functionSchemas(userId?: string, botId?: string) {
  const life = userId ? lifeToolsEnabled(userId, botId) : false;
  const folders = botId ? botFolders(botId).length > 0 : false;
  const appControl = userId ? agentSettings(userId).appControl : true;
  return TOOLS.filter(t => (life || !lifeTools.has(t.name)) && (folders || !t.name.startsWith('folder_')) && (appControl || t.name !== 'marion_app') && (isDesktop || t.name !== 'github_create_repo'))
    .map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters }));
}

// ---------- approvals policy ----------

export type Decision = 'allow' | 'ask' | 'block';

/** Composio meta tools that only discover tools. Others (remote workbench/bash, proxy calls) can run any action. */
const DISCOVERY_META_TOOLS = new Set(['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS']);

export function policyFor(userId: string, toolName: string, args: any, botId?: string): { decision: Decision; key: string; toolkit?: string; title: string } {
  // A bot with full access (confirmed twice by the owner) hands work to the CLIs without asking each time.
  if (botId && (toolName === 'ask_subscription' || toolName === 'orchestrate' || toolName === 'start_cloud_session') && hasFullAccess(botId)) return { decision: 'allow', key: toolName, title: toolName };
  if (toolName === 'orchestrate') {
    const p = db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, 'orchestrate') as any;
    return { decision: p?.mode === 'always_allow' ? 'allow' : p?.mode === 'blocked' ? 'block' : 'ask', key: 'orchestrate', title: 'Run a model team (orchestrator and subagents)' };
  }
  // Approval is required for every prompt sent to the optional hosted connector.
  // A task inside a folder the owner already shared with this bot can be set to "Always allow".
  if (toolName === 'ask_subscription' && args?.folder) {
    const p = db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, 'ask_subscription_folder') as any;
    const who = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini' }[String(args.provider) as 'claude'] ?? 'an assistant';
    return { decision: p?.mode === 'always_allow' ? 'allow' : p?.mode === 'blocked' ? 'block' : 'ask', key: 'ask_subscription_folder', title: `Assistant: have ${who} work in “${String(args.folder).slice(0, 80)}”` };
  }
  if (toolName === 'ask_subscription') return { decision: 'ask', key: toolName, title: 'Assistant: send this request to another provider' };
  if (toolName === 'github_create_repo') return { decision: 'ask', key: toolName, title: 'create a GitHub repository' };
  // One in-app approval covers the GitHub lookup (gh, read-only) and starting the Cloud session; nothing runs on local files.
  if (toolName === 'start_cloud_session') {
    const p = db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, toolName) as any;
    return { decision: p?.mode === 'always_allow' ? 'allow' : p?.mode === 'blocked' ? 'block' : 'ask', key: toolName,
      title: `Claude Cloud: find ${args?.repo ? `“${String(args.repo).slice(0, 80)}”` : 'the repository'} on GitHub and start Cloud work` };
  }
  if (toolName === 'ask_grok') return grok
    ? { decision: 'ask', key: toolName, title: 'send this prompt to Grok' }
    : { decision: 'block', key: toolName, title: 'Grok connector is disabled' };
  if (toolMap.has(toolName) || DISCOVERY_META_TOOLS.has(toolName)) return { decision: 'allow', key: toolName, title: toolName };
  let slugs = innerToolSlugs(toolName, args);
  // Fail closed: a meta tool we can't see inside (or a batch we can't parse) is gated under its own name.
  if (!slugs.length) slugs = [toolName];
  let decision: Decision = 'allow';
  let key = slugs[0];
  for (const slug of slugs) {
    const p = db.prepare('SELECT mode FROM policies WHERE user_id=? AND tool=?').get(userId, slug) as any;
    const mode = p?.mode ?? (isReadOnlySlug(slug) ? 'always_allow' : 'needs_approval');
    if (mode === 'blocked') return { decision: 'block', key: slug, title: humanizeSlug(slug) };
    if (mode === 'needs_approval') { decision = 'ask'; key = slug; }
  }
  return { decision, key, toolkit: key.split('_')[0].toLowerCase(), title: humanizeSlug(key) };
}

export function humanizeSlug(slug: string) {
  const parts = slug.split('_');
  const app = parts.shift() ?? '';
  return `${app.charAt(0) + app.slice(1).toLowerCase()}: ${parts.join(' ').toLowerCase()}`;
}

export async function runComposioTool(ctx: ToolCtx, name: string, args: any): Promise<ToolResult> {
  const r = await executeComposio(ctx.userId, name, args);
  const ok = r.resultType ? r.resultType === 'completed' : !r.error;
  const payload = ok ? r.data : { error: r.error, logId: r.logId };
  let out = JSON.stringify(payload ?? null);
  if (out.length > 60000) out = out.slice(0, 60000) + '…(truncated)';
  return { output: out, summary: ok ? 'done' : 'failed' };
}

export function activityFor(name: string): { kind: ActivityKind; label: string } {
  const t = toolMap.get(name);
  if (t) return { kind: t.activity, label: t.label };
  if (name === 'COMPOSIO_SEARCH_TOOLS' || name === 'COMPOSIO_GET_TOOL_SCHEMAS') return { kind: 'connecting_service', label: 'Using a connected app' };
  return { kind: 'connecting_service', label: 'Using a connected app' };
}

