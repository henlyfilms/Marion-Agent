import { checkUsageLimit, isUsageLimitError } from './usage-limit.js';
import { getBotRow } from '../store.js';
import { tokenCounts, type TokenCounts } from './response-usage.js';
import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { db } from '../db.js';
import { beginAgentSession, finishAgentSession } from '../features/agent-sessions.js';
import { recordSessionEnd, type SessionFinish, type SessionTrack } from '../features/life-outbox.js';
import type { UploadedAttachment } from '../attachments.js';
import '../db-config.js';
import { isDesktop } from '../lib/desktop-access.js';
import type { ChatModel, ChatModelSelection, ChatProvider, WorkUsage } from '../types.js';
import { TaskUsageMeter } from './task-usage.js';
export { modelLabel } from '../model-label.js';

export type SubscriptionProvider = Exclude<ChatProvider, 'local'>;
const commands = { codex: 'codex', gemini: 'agy', claude: 'claude' };
const labels = { codex: 'Codex', gemini: 'Gemini', claude: 'Claude Code' };
const standardEfforts = ['low', 'medium', 'high'];
const extendedEfforts = [...standardEfforts, 'xhigh'];
const claudeEfforts = [...extendedEfforts, 'max'];
/**
 * The model each provider starts on when the owner hasn't picked one (relays, bot defaults, Settings, team and
 * orchestrate all resolve through here): Claude Opus 5.5, Codex 6.2 Sol and Gemini 4 Neon, all on high effort.
 */
export const DEFAULT_SUBSCRIPTION_MODELS = { claude: 'claude-opus-5-5', codex: 'gpt-6.2-sol', gemini: 'gemini-4-neon' } as const;
export const DEFAULT_SUBSCRIPTION_EFFORT = 'high';
/** High when the model offers it, else the closest step down (medium), else whatever it has. */
export function preferredEffort(efforts: readonly string[]): string | null {
  return efforts.includes(DEFAULT_SUBSCRIPTION_EFFORT) ? DEFAULT_SUBSCRIPTION_EFFORT : efforts.includes('medium') ? 'medium' : efforts[0] ?? null;
}
/** The default model first, so name matches ("codex", "gemini") and pickers land on it. */
const defaultFirst = <T>(models: T[], isDefault: (model: T) => boolean) => [...models].sort((a, b) => Number(isDefault(b)) - Number(isDefault(a)));
const claudeModels: ChatModel[] = [
  // Opus 5.5 on high effort is the default for every Claude run; the first entry feeds all fallbacks
  // (saved-preference fallback, picker default, "claude" name match, team defaults). Sonnet only when chosen explicitly.
  { provider: 'claude', id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: claudeEfforts, defaultEffort: 'high' },
  { provider: 'claude', id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', efforts: claudeEfforts, defaultEffort: 'high' },
];

export type SubscriptionSelection = ChatModelSelection & { provider: SubscriptionProvider };

export function subscriptionSelection(userId: string, provider: SubscriptionProvider): SubscriptionSelection {
  const saved = db.prepare('SELECT model, effort FROM subscription_model_preferences WHERE user_id=? AND provider=?')
    .get(userId, provider) as { model: string; effort: string | null } | undefined;
  return { provider, model: saved?.model ?? DEFAULT_SUBSCRIPTION_MODELS[provider], effort: saved ? saved.effort : DEFAULT_SUBSCRIPTION_EFFORT };
}


export function executable(provider: SubscriptionProvider) {
  const bundledCodex = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
  const folders = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(homedir(), '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin',
  ];
  const candidates = folders.filter(folder => folder.startsWith('/')).map(folder => join(folder, commands[provider]));
  if (provider === 'codex' && process.platform === 'darwin') {
    const standardPaths = ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex', '/bin/codex'];
    const standardPath = candidates.findIndex(path => standardPaths.includes(path));
    candidates.splice(standardPath < 0 ? candidates.length : standardPath, 0, bundledCodex);
  }
  for (const candidate of new Set(candidates)) {
    try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Try the next directory. */ }
  }
}

export function getChatProvider(userId: string): ChatProvider {
  if (!isDesktop) return 'local';
  const row = db.prepare('SELECT provider FROM chat_provider_preferences WHERE user_id=?').get(userId) as { provider: SubscriptionProvider } | undefined;
  return row?.provider ?? 'local';
}

export function saveChatProvider(userId: string, provider: ChatProvider) {
  if (provider === 'local') db.prepare('DELETE FROM chat_provider_preferences WHERE user_id=?').run(userId);
  else db.prepare('INSERT INTO chat_provider_preferences(user_id,provider) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider').run(userId, provider);
}

export function subscriptionAvailability() {
  return { codex: Boolean(executable('codex')), gemini: Boolean(executable('gemini')), claude: Boolean(executable('claude')) };
}

// Inherit only basic process settings. The vendor CLI owns its OAuth credentials. git and gh never stop to prompt
// (a private repository fails fast instead of hanging a headless run).
export function cliEnvironment(): Record<string, string | undefined> {
  const keys = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME'];
  return { ...Object.fromEntries(keys.map(key => [key, process.env[key]])), GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1' };
}

/**
 * Public GitHub, for builders on every provider (Claude, Codex, Gemini) working in a folder: git clone/fetch over HTTPS,
 * gh (repo/issue/PR view, api), the REST API, raw files and source archives. Only these hosts are opened where the CLI
 * can limit hosts (Claude's sandbox proxy, Antigravity's URL rules); nothing else about the sandbox changes.
 */
export const GITHUB_HOSTS = ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com',
  'objects.githubusercontent.com', 'gist.github.com', 'gist.githubusercontent.com'] as const;
/** Told to every builder that has a folder, so it knows public repositories are reachable and how to use them. */
export const GITHUB_ACCESS_LINE = 'Public GitHub repositories are reachable from here: use git clone/fetch over HTTPS, gh (repo view, issue and pr view/list, api) or HTTPS requests to github.com, api.github.com and raw.githubusercontent.com to read public repositories, files, issues and pull requests (an owner/repo or a GitHub URL is enough). Clone into your working folder only, use the network only for GitHub, and never push unless the owner asked for it.';
const claudeGitHubFetch = GITHUB_HOSTS.map(host => `WebFetch(domain:${host})`);

export const codexArgs = [
  'app-server', '--listen', 'stdio://',
  '-c', 'forced_login_method="chatgpt"', '-c', 'features.shell_tool=false',
  '-c', 'features.hooks=false', '-c', 'features.multi_agent=false',
  '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.goals=false',
  '-c', 'web_search="disabled"', '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0',
];
const googleDeny = ['command(*)', 'unsandboxed(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'];
export const googleSettings = JSON.stringify({
  modelProvider: '',
  allowNonWorkspaceAccess: false,
  permissions: { allow: [], deny: googleDeny },
});
/**
 * With photos attached, Antigravity may read files, but only inside its own fresh temporary
 * working folder, which holds nothing except those photos (non-workspace access stays off).
 */
const googleSettingsWithPhotos = JSON.stringify({
  modelProvider: '',
  allowNonWorkspaceAccess: false,
  permissions: { allow: [], deny: googleDeny.filter(rule => rule !== 'read_file(*)') },
});
const agyArgs = [
  '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--settings', googleSettings,
  '--input-format', 'stream-json', '--output-format', 'stream-json',
];
/**
 * Auto mode for Gemini (Antigravity `agy --mode auto`): in a folder it may change, it runs shell commands and edits
 * files on its own instead of stopping for approvals (still inside its --sandbox and the folder's allow rules).
 */
export const GEMINI_AUTO_MODE = 'auto';
/**
 * Auto mode for Codex, the app-server form of `codex --approve-for-me`: workspace-write sandbox, the model asks
 * when it needs more (network, a path outside the folder) and Codex's own auto reviewer answers instead of
 * blocking on the owner. Read-only folders and plain chat stay read-only with no approvals.
 */
export function codexThreadPolicy(folder?: { write: boolean }) {
  return folder?.write
    ? { sandbox: 'workspace-write', approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' } as const
    : { sandbox: 'read-only', approvalPolicy: 'never' } as const;
}
/**
 * Turn sandbox for a Codex builder in a folder: the same file access as its thread (workspace-write or read-only) with
 * network on, so git/gh/curl reach public GitHub (Codex's sandbox can't limit hosts; the instructions keep it to GitHub).
 * Plain chat (no folder) has no shell tool and keeps the thread's offline sandbox.
 */
export function codexTurnSandbox(folder?: { path: string; write: boolean }) {
  if (!folder) return undefined;
  return folder.write
    ? { type: 'workspaceWrite', writableRoots: [folder.path], networkAccess: true } as const
    : { type: 'readOnly', networkAccess: true } as const;
}
/** Claude Code always launches in auto mode (never dontAsk) unless a caller passes an explicit override. */
export const CLAUDE_PERMISSION_MODE = 'auto';
export const claudePermissionArgs = (mode: string = CLAUDE_PERMISSION_MODE) => ['--permission-mode', mode];
export const claudeIsolation = ['--restricted', '--safe-mode', '--setting-sources', '', '--settings', '{"disableAllHooks":true}'];
export const claudeArgs = [
  ...claudeIsolation, '--print', '--output-format', 'stream-json', '--verbose',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--tools', '', ...claudePermissionArgs(), '--no-session-persistence', '--disable-slash-commands',
  // Replaces Claude Code's own coding prompt (about 1,600 tokens per call); Marion's instructions are in the message.
  '--system-prompt', 'You are the chat model inside Marion Agent. Follow the instructions in the user message.',
];
const providerArgs = { codex: codexArgs, gemini: agyArgs, claude: claudeArgs };

/**
 * Arguments for a task inside a folder the bot shares. The CLI still starts in Marion's empty temp folder
 * and gets the shared folder as its only extra directory. Writes are confined by each CLI's own sandbox.
 */
export function folderArgs(provider: 'claude' | 'gemini', folder: { path: string; write: boolean }, photosFolder?: string[]) {
  if (provider === 'claude') {
    const settings = folder.write
      // Sandboxed shell commands reach public GitHub (git clone, gh) through the sandbox proxy, and only GitHub.
      ? { disableAllHooks: true, sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false, network: { allowedDomains: [...GITHUB_HOSTS] } } }
      : { disableAllHooks: true };
    return [
      ...(folder.write ? [] : ['--restricted']), '--safe-mode', '--setting-sources', '', '--settings', JSON.stringify(settings),
      '--print', '--output-format', 'stream-json', '--verbose', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      // WebFetch reads public repositories, issues and PRs; it is pre-approved for GitHub hosts only (others stay with auto mode).
      '--tools', folder.write ? 'Read,Glob,Grep,Edit,Write,Bash,WebFetch' : 'Read,Glob,Grep,WebFetch',
      '--allowedTools', ...(folder.write ? ['Read', 'Glob', 'Grep', 'Edit', 'Write'] : ['Read', 'Glob', 'Grep']), ...claudeGitHubFetch,
      ...claudePermissionArgs(), '--no-session-persistence', '--disable-slash-commands', '--add-dir', folder.path,
    ];
  }
  // File tools are allowed only under the shared folder (Antigravity's write_file otherwise reaches any path);
  // shell commands run in its sandbox, which blocks writes outside the workspace.
  const inFolder = (tool: string) => `${tool}(${folder.path}/**)`;
  // The user's screenshots and recording frames sit in Marion's own temp folder: reading there is allowed too.
  const photos = (photosFolder ?? []).map(path => `read_file(${path}/**)`);
  // Public GitHub: URL reads are allowed for GitHub hosts only; read_url(*) leaves the deny list so these rules can apply.
  const github = GITHUB_HOSTS.map(host => `read_url(${host})`);
  const allowed = folder.write ? [inFolder('read_file'), inFolder('write_file'), 'command(*)', ...github, ...photos] : [inFolder('read_file'), ...github, ...photos];
  const open = folder.write ? ['read_file(*)', 'write_file(*)', 'command(*)', 'read_url(*)'] : ['read_file(*)', 'read_url(*)'];
  const settings = JSON.stringify({
    modelProvider: '', allowNonWorkspaceAccess: false,
    // A folder it may change: its sandboxed terminal may reach the network too (git clone/fetch, gh), still confined to the workspace.
    ...(folder.write ? { sandboxAllowNetwork: true } : {}),
    permissions: { allow: allowed, deny: googleDeny.filter(rule => !open.includes(rule)) },
  });
  return [
    '--mode', folder.write ? GEMINI_AUTO_MODE : 'plan', '--sandbox', '--disable-slash-commands', '--settings', settings,
    '--add-dir', folder.path, '--input-format', 'stream-json', '--output-format', 'stream-json',
  ];
}
const runFile = promisify(execFile);
const claudeLoginMessage = 'Run claude auth login --claudeai in Terminal and sign in with your Claude subscription.';
const claudePlans = new Set(['free', 'pro', 'max', 'ultra', 'team', 'enterprise']);

type ClaudeAccount = { loggedIn?: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string };
type ClaudeResult = { type?: string; subtype?: string; is_error?: boolean; result?: string; usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number } };

export async function requireClaudeSubscription(program: string, cwd: string, signal: AbortSignal) {
  const status = await runFile(program, [...claudeIsolation, 'auth', 'status', '--json'], {
    cwd, env: cliEnvironment(), signal, timeout: 12_000, maxBuffer: 32_768,
  }).catch(() => { throw new Error(claudeLoginMessage); });
  const account = parseLine<ClaudeAccount>(status.stdout);
  if (!account?.loggedIn || account.authMethod !== 'claude.ai' || account.apiProvider !== 'firstParty'
    || !claudePlans.has(account.subscriptionType ?? '')) {
    throw new Error(claudeLoginMessage);
  }
  return account.subscriptionType!;
}

type ProviderMessage = {
  id?: number | string;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  event?: string;
  error?: unknown;
};

type CodexModel = {
  model: string;
  displayName?: string;
  hidden?: boolean;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: { reasoningEffort: string }[];
};

export const initializeCodex = { id: 1, method: 'initialize', params: { clientInfo: { name: 'marion_agent', title: 'Marion Agent', version: '1.0.0' } } };
const listCodexModels = { id: 5, method: 'model/list', params: { includeHidden: false, limit: 100 } };
const defaultCodexModel = (models: CodexModel[]) =>
  models.find(m => m.model === DEFAULT_SUBSCRIPTION_MODELS.codex) ?? models.find(m => m.isDefault) ?? models[0];

let codexCatalog: { expires: number; models: Promise<CodexModel[]> } | undefined;
let geminiCatalog: { expires: number; models: Promise<ChatModel[]> } | undefined;
let claudeStatus: { expires: number; ready: Promise<string> } | undefined;

export async function subscriptionModels(provider: SubscriptionProvider): Promise<{ models: ChatModel[]; defaultModel?: string }> {
  const program = executable(provider);
  if (!isDesktop || !program) throw new Error(`Install ${labels[provider]} on the Marion Agent host.`);
  if (provider === 'claude') {
    if (!claudeStatus || claudeStatus.expires < Date.now()) {
      claudeStatus = { expires: Date.now() + 60_000, ready: requireClaudeSubscription(program, tmpdir(), AbortSignal.timeout(6000)) };
    }
    try { await claudeStatus.ready; }
    catch (error) { claudeStatus = undefined; throw error; }
    return { models: claudeModels, defaultModel: claudeModels[0].id };
  }
  if (provider === 'gemini') {
    if (!geminiCatalog || geminiCatalog.expires < Date.now()) {
      geminiCatalog = { expires: Date.now() + 60_000, models: discoverGeminiModels(program) };
    }
    try {
      const models = await geminiCatalog.models;
      return { models, defaultModel: models[0]?.id };
    } catch (error) { geminiCatalog = undefined; throw error; }
  }
  if (!codexCatalog || codexCatalog.expires < Date.now()) {
    codexCatalog = { expires: Date.now() + 60_000, models: discoverCodexModels(program) };
  }
  let models;
  try { models = await codexCatalog.models; }
  catch (error) { codexCatalog = undefined; throw error; }
  if (!models.length) throw new Error('No Codex models are available for this ChatGPT account.');
  const defaultModel = defaultCodexModel(models)?.model;
  return {
    models: defaultFirst(models, model => model.model === defaultModel).map((model): ChatModel => {
      const efforts = model.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? [];
      return { provider, id: model.model, label: model.displayName || model.model, efforts, defaultEffort: preferredEffort(efforts) ?? model.defaultReasoningEffort ?? null };
    }),
    defaultModel,
  };
}

async function discoverGeminiModels(program: string): Promise<ChatModel[]> {
  const cwd = await mkdtemp(join(tmpdir(), 'marion-models-'));
  try {
    const { stdout } = await runFile(program, ['models'], {
      cwd, env: cliEnvironment(), timeout: 6000, maxBuffer: 128_000,
    }).catch(() => { throw new Error('Sign in to Antigravity in Terminal, then refresh the model list.'); });
    const byId = new Map<string, ChatModel>();
    for (const line of stdout.split(/\r?\n/)) {
      const [slug, name] = line.trim().split(/\t+/);
      if (!name || !/^gemini-[a-z0-9.-]{1,120}$/.test(slug)) continue;
      const level = /-(low|medium|high|xhigh|max)$/.exec(slug);
      const id = level ? slug.slice(0, -level[0].length) : slug;
      const model: ChatModel = byId.get(id) ?? {
        provider: 'gemini', id, label: level ? name.replace(/ \((?:Low|Medium|High|XHigh|Max)\)$/i, '') : name,
        efforts: [], defaultEffort: null,
      };
      if (level && !model.efforts.includes(level[1])) model.efforts.push(level[1]);
      byId.set(id, model);
    }
    if (!byId.size) throw new Error('No Gemini models were listed for this Antigravity account.');
    const models = [...byId.values()].map(model => {
      const efforts = claudeEfforts.filter(effort => model.efforts.includes(effort));
      return { ...model, efforts, defaultEffort: preferredEffort(efforts) };
    });
    return defaultFirst(models, model => model.id === DEFAULT_SUBSCRIPTION_MODELS.gemini);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

async function discoverCodexModels(program: string): Promise<CodexModel[]> {
  const cwd = await mkdtemp(join(tmpdir(), 'marion-models-'));
  try {
    const child = spawn(program, codexArgs, {
      cwd, env: cliEnvironment(), signal: AbortSignal.timeout(5000), stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.on('error', () => {});
    child.stdin.on('error', () => {});
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const write = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
    try {
      write(initializeCodex);
      for await (const line of lines) {
        const message = parseLine(line);
        if (message?.error) break;
        if (message?.id === 1) {
          write({ method: 'initialized' });
          write({ id: 2, method: 'account/read', params: { refreshToken: false } });
        }
        if (message?.id === 2 && message.result?.account?.type === 'chatgpt') write(listCodexModels);
        else if (message?.id === 2) break;
        if (message?.id === 5) {
          const models: CodexModel[] = message.result?.data ?? [];
          return models.filter(model => model.model && !model.hidden);
        }
      }
      throw new Error('Sign in with ChatGPT using codex login, then refresh the model list.');
    } finally {
      lines.close();
      child.stdin.destroy();
      child.kill();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

interface ReplyOptions {
  fast?: boolean;
  handoffProgress?: string[];
  handoffContinuation?: boolean;
  /** A folder on this Mac the bot shares: the CLI may work inside it (and only there). */
  folder?: { path: string; label: string; write: boolean };
  onUsage?: (counts: TokenCounts) => void;
  onModel?: (model: SubscriptionSelection) => void;
  /** Each step the CLI takes (a command, an edit, a file read…), for the live work feed. Costs nothing extra. */
  onStep?: (kind: StepKind, text: string) => void;
  /** This run's task usage and session context as the CLI reports them (live, then final), for the work card. */
  onTaskUsage?: (usage: WorkUsage) => void;
  /** When set, this run is kept in Marion Agent's Sessions (any provider); for Claude a short summary also goes to Marion Life. */
  session?: SessionTrack;
}

type StepKind = 'command' | 'edit' | 'read' | 'search' | 'note' | 'error';
const short = (value: unknown, max = 160) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const baseName = (path: unknown) => short(path).split('/').filter(Boolean).slice(-2).join('/');

/** Turn one tool call from any CLI into a feed line ("Ran npm test", "Edited src/app.ts"). */
export function describeToolStep(name: string, input: Record<string, any> = {}): [StepKind, string] | undefined {
  const tool = name.toLowerCase();
  const command = input.command ?? input.CommandLine ?? input.cmd ?? input.commandLine;
  const path = input.file_path ?? input.path ?? input.AbsolutePath ?? input.TargetFile ?? input.filePath;
  if (command && /bash|shell|command|exec|run/.test(tool)) return ['command', `Ran ${short(Array.isArray(command) ? command.join(' ') : command, 140)}`];
  if (/write|edit|replace|create_file|apply_patch|multi_edit/.test(tool)) return ['edit', path ? `Edited ${baseName(path)}` : 'Edited files'];
  if (/read|view_file|open_file/.test(tool)) return ['read', path ? `Read ${baseName(path)}` : 'Read a file'];
  if (/grep|glob|search|find|list_dir|ls/.test(tool)) return ['search', `Searched ${short(input.pattern ?? input.query ?? input.Query ?? path ?? 'the files', 80)}`];
  if (/browser|web|fetch/.test(tool)) return ['search', `Looked up ${short(input.url ?? input.query ?? 'the web', 90)}`];
  if (/todo|plan/.test(tool)) return ['note', 'Updated its plan'];
  return ['note', `Used ${short(name, 40)}`];
}

function claudeSteps(line: string, onStep: NonNullable<ReplyOptions['onStep']>) {
  const message = parseLine<any>(line);
  if (message?.type !== 'assistant' || !Array.isArray(message.message?.content)) return;
  for (const part of message.message.content) {
    if (part?.type === 'tool_use') { const step = describeToolStep(String(part.name ?? ''), part.input ?? {}); if (step) onStep(...step); }
    else if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 12) onStep('note', short(part.text.split('\n')[0], 140));
  }
}

function geminiSteps(line: string, onStep: NonNullable<ReplyOptions['onStep']>) {
  const update = parseLine<any>(line)?.step_update;
  if (!update || update.step_type !== 'tool') return;
  const info = update.tool_info ?? {};
  if (update.state === 'ACTIVE') { const step = describeToolStep(String(update.tool_name ?? info.name ?? ''), info.parameters ?? {}); if (step) onStep(...step); }
  else if (update.state === 'ERROR') onStep('error', `${short(update.tool_name, 40)} failed: ${short(info.error?.message, 100)}`);
}

export async function subscriptionReply(
  selection: SubscriptionSelection, prompt: string, signal: AbortSignal, images: UploadedAttachment[] = [], options: ReplyOptions = {},
): Promise<string> {
  const track = options.session;
  if (!track) return runSubscriptionReply(selection, prompt, signal, images, options);
  // Every relayed run (Claude, Codex or Gemini, any outcome) is kept for Marion Agent's Sessions views, and a finished
  // Claude run is also summarised for Marion Life. This never changes what the caller gets back.
  const startedAt = Date.now();
  const provider = selection.provider;
  const finished = (finish: SessionFinish) => {
    finishAgentSession(track, provider, finish);
    if (provider === 'claude') recordSessionEnd(track, finish);
  };
  const generation = getBotRow(track.botId)?.generation;
  const progress = [...(options.handoffProgress ?? [])];
  beginAgentSession(track, provider, startedAt);
  let actual: SubscriptionSelection = selection;
  let tokens: { input?: number; output?: number } | undefined;
  const watched: ReplyOptions = {
    ...options,
    onStep: (kind, line) => {
      progress.push(`${kind}: ${line}`);
      if (progress.length > 40) progress.shift();
      options.onStep?.(kind, line);
    },
    onModel: value => { actual = value; options.onModel?.(value); },
    onUsage: counts => { tokens = { input: counts.input, output: counts.output }; options.onUsage?.(counts); },
  };
  const model = () => ({ id: actual.model, label: actual.label, effort: actual.effort });
  try {
    const reply = await runSubscriptionReply(selection, prompt, signal, images, watched);
    finished({ status: 'completed', reply, startedAt, endedAt: Date.now(), model: model(), tokens });
    return reply;
  } catch (error) {
    finished({ status: signal.aborted ? 'stopped' : 'failed', error: String((error as Error)?.message ?? error), startedAt, endedAt: Date.now(), model: model(), tokens });
    if (!signal.aborted && generation !== undefined && isUsageLimitError(error)) {
      const { offerHandoff, reportHandoffError } = await import('../features/handoffs.js');
      await offerHandoff({ track, generation, selection: actual, progress, folder: options.folder, error,
        images, signal, continuation: options.handoffContinuation }).catch(failure => reportHandoffError(track.botId, generation, failure));
    }
    throw error;
  }
}

/** Claude/Codex/Gemini runs in progress: they are children of this server, so it must not be replaced while any runs. */
let activeRuns = 0;
export const activeProviderRuns = () => activeRuns;

async function runSubscriptionReply(
  selection: SubscriptionSelection, prompt: string, signal: AbortSignal, images: UploadedAttachment[], options: ReplyOptions,
): Promise<string> {
  activeRuns++;
  try { return await spawnSubscriptionReply(selection, prompt, signal, images, options); }
  finally { activeRuns--; }
}

async function spawnSubscriptionReply(
  selection: SubscriptionSelection, prompt: string, signal: AbortSignal, images: UploadedAttachment[], options: ReplyOptions,
): Promise<string> {
  const { provider, model, effort } = selection;
  if (!isDesktop) throw new Error('Subscription chat is available in the Mac app.');
  const program = executable(provider);
  if (!program) throw new Error(`Install ${labels[provider]} and check Settings → Models.`);
  const cwd = await mkdtemp(join(tmpdir(), 'marion-provider-'));
  const folder = options.folder;
  // Usage for the work card, read from the same JSON lines (no extra calls).
  const meter = options.onTaskUsage ? new TaskUsageMeter(provider, model) : undefined;
  const measure = (message: unknown) => { if (meter?.feed(message)) { const usage = meter.value(); if (usage) options.onTaskUsage?.(usage); } };
  // Claude and Gemini builders learn about public GitHub access from the task (Codex gets it in its base instructions).
  if (folder && provider !== 'codex') prompt += `\n\n${GITHUB_ACCESS_LINE}`;
  // No time limit of any kind (wall-clock, silence or idle): a relayed session runs until it finishes, fails or the
  // owner stops it. `signal` is the owner's cancel.
  const stop = signal;
  try {
    if (provider === 'claude') await requireClaudeSubscription(program, cwd, stop);
    const args = folder && provider !== 'codex' ? folderArgs(provider, folder, provider === 'gemini' && images.length ? [...new Set([cwd, await realpath(cwd).catch(() => cwd)])] : undefined)
      : provider === 'gemini' && images.length
        ? agyArgs.map(arg => arg === googleSettings ? googleSettingsWithPhotos : arg)
        : [...providerArgs[provider]];
    if (provider !== 'codex') {
      const catalog = provider === 'claude' ? claudeModels
        : geminiCatalog && geminiCatalog.expires > Date.now() ? await geminiCatalog.models.catch(() => []) : [];
      // The built-in default (Gemini 4 Neon) falls back to the account's best model if this account doesn't list it.
      const chosen = catalog.find(option => option.id === model)
        ?? (model === DEFAULT_SUBSCRIPTION_MODELS[provider] ? catalog[0] : undefined);
      const runModel = chosen?.id ?? model;
      if (meter) meter.model = runModel;
      args.push('--model', runModel);
      // No saved effort (older bots, first run): high, like everywhere else.
      const baseEffort = effort ?? (chosen ? preferredEffort(chosen.efforts) : DEFAULT_SUBSCRIPTION_EFFORT);
      const fastEffort = chosen?.efforts.includes('low') ? 'low' : baseEffort;
      const selectedEffort = options.fast ? fastEffort : baseEffort;
      if (selectedEffort) args.push('--effort', selectedEffort);
      options.onModel?.({ ...selection, model: runModel, label: chosen?.label ?? (runModel === model ? selection.label : undefined) ?? runModel, effort: selectedEffort });
      if (provider === 'claude' && images.length) args.push('--input-format', 'stream-json');
    }
    const codexImages = provider === 'codex' ? await Promise.all(images.map(async (image, index) => {
      const extension = image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice('image/'.length);
      const path = join(cwd, `image-${index + 1}.${extension}`);
      await writeFile(path, image.data, { mode: 0o600 });
      return { type: 'localImage', path };
    })) : [];
    // Antigravity's chat protocol takes text only: hand it the photos as files in its working folder.
    if (provider === 'gemini' && images.length) {
      const names = await Promise.all(images.map(async (image, index) => {
        const name = `attached-image-${index + 1}.${image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice('image/'.length)}`;
        await writeFile(join(cwd, name), image.data, { mode: 0o600 });
        return name;
      }));
      prompt += `\n\nThe user's images are saved as: ${names.map(name => join(cwd, name)).join(', ')}. Open and look at them before answering.`;
    }
    const child = spawn(program, provider === 'codex' && folder ? codexArgs.filter((arg, index) => arg !== 'features.shell_tool=false' && codexArgs[index + 1] !== 'features.shell_tool=false') : args, {
      cwd, env: cliEnvironment(), signal: stop, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let diagnostic = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4096); });
    let exitCode: number | null = null;
    let exitSignal: string | null = null;
    const closed = new Promise<void>(done => child.once('close', (code, sig) => { exitCode = code; exitSignal = sig; done(); }));
    // stdin can close first when the executable exits or the user stops a reply.
    child.stdin.on('error', () => {});
    let processError = '';
    child.on('error', error => { processError = error.message || 'failed to start'; });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const write = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');

    try {
      if (provider === 'codex') {
        try { return await codexReply(lines, write, folder?.path ?? cwd, prompt, selection, codexImages, options, measure); }
        catch (error) { checkUsageLimit(error, diagnostic); throw error; }
      }
      if (provider === 'claude' && images.length) {
        child.stdin.end(JSON.stringify({
          type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [
            { type: 'text', text: prompt },
            ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mime, data: image.data.toString('base64') } })),
          ] },
        }) + '\n');
      } else {
        child.stdin.end(provider === 'claude' ? prompt : JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n');
      }
      for await (const line of lines) {
        if (options.onStep) (provider === 'claude' ? claudeSteps : geminiSteps)(line, options.onStep);
        if (meter) measure(parseLine(line));
        if (provider === 'claude') {
          const message = parseLine<ClaudeResult>(line);
          if (message?.type !== 'result') continue;
          if (message.is_error || message.subtype !== 'success') checkUsageLimit(message.result, message, diagnostic);
          // Some CLI versions wrap the subscription refusal in a successful result.
          if (/^(?:you.ve hit|you have reached|usage limit|rate limit|credit balance)/i.test(message.result ?? '')) checkUsageLimit(message.result);
          if (message.subtype === 'success' && !message.is_error && typeof message.result === 'string' && message.result.trim()) {
            const usage = message.usage;
            const counts = usage && tokenCounts(
              typeof usage.input_tokens === 'number'
                ? usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) : undefined,
              usage.output_tokens,
            );
            if (counts) options.onUsage?.(counts);
            return message.result;
          }
          if (/model.+(not found|unavailable|access)|access.+model/i.test(message.result ?? '')) {
            throw new Error(`Claude Code could not use ${model} with this account. Choose another model.`);
          }
          const reported = short(message.result ?? '', 400);
          throw new Error(reported
            ? `Claude Code reported an error: ${reported}`
            : `Claude Code did not return a reply (${message.subtype ?? 'no result'}). Check your Claude sign-in and plan usage in Terminal.`);
        }
        const message = parseLine(line);
        if (message?.event === 'error') checkUsageLimit(message, message.error, message.params, message.result);
        if (message?.event !== 'result') continue;
        const result = message.result;
        if (result?.status === 'SUCCESS' && typeof result.response === 'string' && result.response.trim()) {
          if (/^(?:you.ve hit|you have reached|usage limit|rate limit|credit balance)/i.test(result.response)) checkUsageLimit(result.response);
          return result.response;
        }
        checkUsageLimit(result, diagnostic);
        diagnostic += ` ${typeof result?.error === 'string' ? result.error : ''}`;
        break;
      }
      // The CLI ended without a reply: give it a moment to report its exit code before blaming it.
      await Promise.race([closed, new Promise(done => setTimeout(done, 1000).unref())]);
    } finally {
      lines.close();
      child.stdin.destroy();
      child.kill();
    }
    if (signal.aborted) throw signal.reason;
    if (processError) throw new Error(`Could not start ${labels[provider]} on this Mac: ${processError}`);
    if (provider === 'gemini' && /authenticat|sign.in|log.in/i.test(diagnostic)) {
      throw new Error('Sign in with your personal Google account using agy acp --login in Terminal.');
    }
    // The real reason: how the CLI ended and its own last words (stderr).
    const ended = exitSignal ? `was stopped by ${exitSignal}` : exitCode !== null && exitCode !== 0 ? `exited with code ${exitCode}` : 'ended without a reply';
    const said = short(diagnostic, 400);
    if (isUsageLimitError(diagnostic)) checkUsageLimit(`${labels[provider]} ${ended}: ${diagnostic.trim().slice(0, 450)}`, diagnostic);
    throw new Error(`${labels[provider]} ${ended}${said ? `: ${said}` : '. Check sign-in and usage in its own app.'}`);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    throw error;
  } finally {
    if (provider === 'gemini') await forgetAntigravityConversation(cwd);
    await rm(cwd, { recursive: true, force: true });
  }
}

// Antigravity has no "don't save" switch: every chat it answers is kept under
// ~/.gemini/antigravity-cli (transcript, brain notes and a preview). Marion's chats already live in
// Marion, so after each reply it removes the copy Antigravity made for that one temporary folder.
// Only conversations whose working folder is Marion's own temp folder are touched.
let forgetting = Promise.resolve();
export function forgetAntigravityConversation(cwd: string) {
  const job = forgetting.then(async () => {
    const root = join(homedir(), '.gemini', 'antigravity-cli');
    const folder = await realpath(cwd).catch(() => cwd);
    if (!/[\/]marion-(provider|models|usage)-[^\/]+$/.test(folder)) return;
    const lastPath = join(root, 'cache', 'last_conversations.json');
    const last = await readFile(lastPath, 'utf8').then(text => JSON.parse(text) as Record<string, string>).catch(() => null);
    const ids = new Set<string>();
    for (const key of [folder, cwd]) if (typeof last?.[key] === 'string') ids.add(last[key]);
    for (const id of ids) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
      for (const suffix of ['.db', '.db-wal', '.db-shm', '.db-journal']) await rm(join(root, 'conversations', `${id}${suffix}`), { force: true });
      await rm(join(root, 'brain', id), { recursive: true, force: true });
    }
    const rewrite = async (path: string, edit: (data: any) => boolean) => {
      const data = await readFile(path, 'utf8').then(text => JSON.parse(text)).catch(() => null);
      if (!data || !edit(data)) return;
      const temp = `${path}.marion-${process.pid}`;
      await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
      await rename(temp, path);
    };
    await rewrite(lastPath, data => { let changed = false; for (const key of [folder, cwd]) if (key in data) { delete data[key]; changed = true; } return changed; });
    if (ids.size) {
      await rewrite(join(root, 'cache', 'conversation_metadata.json'), data => {
        let changed = false;
        for (const id of ids) if (data?.conversations && id in data.conversations) { delete data.conversations[id]; changed = true; }
        return changed;
      });
    }
  }).catch(error => console.warn('[subscriptions] could not remove the Antigravity copy', (error as Error).message));
  forgetting = job;
  return job;
}

export function parseLine<T = ProviderMessage>(line: string): T | undefined {
  try { return JSON.parse(line); } catch { return undefined; }
}

async function codexReply(
  lines: AsyncIterable<string>, write: (value: unknown) => void, cwd: string, prompt: string, selection: SubscriptionSelection, images: { type: string; path: string }[], options: ReplyOptions,
  measure: (message: unknown) => void = () => {},
): Promise<string> {
  let threadId: string | undefined;
  let actualEffort = selection.effort;
  let counts: TokenCounts | undefined;
  let reply = '';
  let limit: unknown;
  const startThread = (models: CodexModel[]) => {
    // The built-in default (6.2 Sol) falls back to the account's own default if this account doesn't list it.
    const model = models.find(entry => entry.model === selection.model)
      ?? (!selection.model || selection.model === DEFAULT_SUBSCRIPTION_MODELS.codex ? defaultCodexModel(models) : undefined);
    if (!model?.model) throw new Error(selection.model
      ? `Codex model ${selection.model} is unavailable for this account. Choose another model.`
      : 'No Codex model is available for this ChatGPT account.');
    const supports = (effort: string) => model.supportedReasoningEfforts?.some(item => item.reasoningEffort === effort);
    actualEffort ??= preferredEffort(model.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? []);
    if (options.fast) actualEffort = supports('low') ? 'low' : supports('none') ? 'none' : actualEffort;
    if (actualEffort && !supports(actualEffort)) throw new Error(`Choose a supported reasoning effort for ${model.model}.`);
    options.onModel?.({ ...selection, model: model.model, label: model.displayName || selection.label, effort: actualEffort });
    write({ id: 3, method: 'thread/start', params: {
      cwd, model: model.model, modelProvider: 'openai', ...codexThreadPolicy(options.folder), ephemeral: true, serviceTier: 'default',
      baseInstructions: options.folder
        ? `You are working inside the user's folder "${options.folder.label}" (${options.folder.path}), your working directory, with ${options.folder.write ? 'read and write' : 'read-only'} access. Do the task there, never touch anything outside it, and finish with a short summary of what you did. ${GITHUB_ACCESS_LINE}`
        : 'Answer as a chat assistant using the messages and attachments the user provides. Use the response format requested by Marion. Do not use native CLI tools.',
    } });
  };
  write(initializeCodex);
  for await (const line of lines) {
    const message = parseLine(line);
    if (!message) continue;
    // Token usage carries the thread id; plan limits are account-wide (one ephemeral thread per process).
    measure(message);
    const { id, method, params, result, error } = message;
    if (typeof id !== 'undefined' && method) {
      write({ id, error: { code: -32601, message: 'Unavailable in Marion subscription chat' } });
      continue;
    }
    if (error) {
      checkUsageLimit(error);
      if (id === 2) throw new Error('Run codex login and use your ChatGPT account.');
      throw new Error('Codex could not start a ChatGPT session. Check sign-in and usage in Codex.');
    }
    switch (id) {
      case 1:
        write({ method: 'initialized' });
        write({ id: 2, method: 'account/read', params: { refreshToken: false } });
        break;
      case 2:
        if (result?.account?.type !== 'chatgpt') throw new Error('Run codex login and use your ChatGPT account.');
        // The app server still checks the account and opens a fresh restricted thread.
        const cached = codexCatalog && codexCatalog.expires > Date.now() ? await codexCatalog.models.catch(() => []) : [];
        if (cached.length && (!selection.model || selection.model === DEFAULT_SUBSCRIPTION_MODELS.codex || cached.some(model => model.model === selection.model))) startThread(cached);
        else write(listCodexModels);
        break;
      case 5: {
        const models = ((result?.data ?? []) as CodexModel[]).filter(model => model.model && !model.hidden);
        if (models.length) codexCatalog = { expires: Date.now() + 60_000, models: Promise.resolve(models) };
        startThread(models);
        break;
      }
      case 3:
        threadId = result?.thread?.id;
        if (!threadId) throw new Error('Codex returned no thread.');
        write({ id: 4, method: 'turn/start', params: {
          threadId, input: [{ type: 'text', text: prompt, textElements: [] }, ...images],
          ...(actualEffort ? { effort: actualEffort } : {}),
          ...(options.folder ? { sandboxPolicy: codexTurnSandbox(options.folder) } : {}),
        } });
        break;
    }
    if (!threadId || params?.threadId !== threadId) continue;
    if (method === 'error' && isUsageLimitError(params?.error)) {
      if (params?.willRetry === false) checkUsageLimit(params.error);
      limit = params?.error;
    }
    if (options.onStep && method === 'item/started') {
      const item = params.item ?? {};
      if (item.type === 'commandExecution') options.onStep('command', `Ran ${short(Array.isArray(item.command) ? item.command.join(' ') : item.command, 140)}`);
      else if (item.type === 'fileChange') options.onStep('edit', `Edited ${(item.changes ?? []).map((change: any) => baseName(change.path)).filter(Boolean).slice(0, 3).join(', ') || 'files'}`);
      else if (item.type === 'webSearch') options.onStep('search', `Searched the web for ${short(item.query, 80)}`);
      else if (item.type === 'mcpToolCall') options.onStep('note', `Used ${short(item.tool, 40)}`);
    }
    if (options.onStep && method === 'item/completed' && params.item?.type === 'agentMessage' && params.item.phase === 'commentary' && typeof params.item.text === 'string') {
      options.onStep('note', short(params.item.text.split('\n')[0], 140));
    }
    if (method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
      if (params.item.phase !== 'commentary') reply = params.item.text;
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage?.total;
      counts = tokenCounts(usage?.inputTokens, usage?.outputTokens) ?? counts;
    }
    if (method === 'turn/completed') {
      if (counts) options.onUsage?.(counts);
      if (params.turn?.status === 'completed' && reply.trim()) return reply;
      if (reply.trim()) options.onStep?.('note', reply.slice(0, 2000));
      checkUsageLimit(params.turn?.error, limit);
      throw new Error('Codex did not return a reply. Check your ChatGPT plan usage in Codex.');
    }
  }
  checkUsageLimit(limit);
  throw new Error('Codex closed before returning a reply. Update the Codex CLI and check codex login status.');
}
