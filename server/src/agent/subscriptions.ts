import { execFile, spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { db } from '../db.js';
import type { UploadedAttachment } from '../attachments.js';
import '../db-config.js';
import { isDesktop } from '../lib/desktop-access.js';
import type { ChatModel, ChatModelSelection, ChatProvider } from '../types.js';

export type SubscriptionProvider = Exclude<ChatProvider, 'local'>;
const commands = { codex: 'codex', gemini: 'agy', claude: 'claude' };
const labels = { codex: 'Codex', gemini: 'Gemini', claude: 'Claude Code' };
const standardEfforts = ['low', 'medium', 'high'];
const extendedEfforts = [...standardEfforts, 'xhigh'];
const claudeEfforts = [...extendedEfforts, 'max'];
const defaultGemini = 'gemini-3.8-flash';
const claudeModels: ChatModel[] = [
  { provider: 'claude', id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', efforts: claudeEfforts, defaultEffort: 'high' },
  { provider: 'claude', id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: claudeEfforts, defaultEffort: 'medium' },
];

export type SubscriptionSelection = ChatModelSelection & { provider: SubscriptionProvider };

export function subscriptionSelection(userId: string, provider: SubscriptionProvider): SubscriptionSelection {
  const saved = db.prepare('SELECT model, effort FROM subscription_model_preferences WHERE user_id=? AND provider=?')
    .get(userId, provider) as { model: string; effort: string | null } | undefined;
  const fallback = provider === 'claude' ? claudeModels[0]
    : provider === 'gemini' ? { id: defaultGemini, defaultEffort: 'medium' } : undefined;
  return { provider, model: saved?.model ?? fallback?.id ?? '', effort: saved ? saved.effort : fallback?.defaultEffort ?? null };
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

// Inherit only basic process settings. The vendor CLI owns its OAuth credentials.
export function cliEnvironment() {
  const keys = ['HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME'];
  return Object.fromEntries(keys.map(key => [key, process.env[key]]));
}

export const codexArgs = [
  'app-server', '--listen', 'stdio://',
  '-c', 'forced_login_method="chatgpt"', '-c', 'features.shell_tool=false',
  '-c', 'features.hooks=false', '-c', 'features.multi_agent=false',
  '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'features.goals=false',
  '-c', 'web_search="disabled"', '-c', 'mcp_servers={}', '-c', 'project_doc_max_bytes=0',
];
export const googleSettings = JSON.stringify({
  modelProvider: '',
  allowNonWorkspaceAccess: false,
  permissions: {
    allow: [],
    deny: ['command(*)', 'unsandboxed(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)', 'mcp(*)'],
  },
});
const agyArgs = [
  '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--settings', googleSettings,
  '--input-format', 'stream-json', '--output-format', 'stream-json',
];
export const claudeIsolation = ['--restricted', '--safe-mode', '--setting-sources', '', '--settings', '{"disableAllHooks":true}'];
const claudeArgs = [
  ...claudeIsolation, '--print', '--output-format', 'stream-json', '--verbose',
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--tools', '', '--permission-mode', 'dontAsk', '--no-session-persistence', '--disable-slash-commands',
];
const providerArgs = { codex: codexArgs, gemini: agyArgs, claude: claudeArgs };
const runFile = promisify(execFile);
const claudeLoginMessage = 'Run claude auth login --claudeai in Terminal and sign in with your Claude subscription.';
const claudePlans = new Set(['free', 'pro', 'max', 'ultra', 'team', 'enterprise']);

type ClaudeAccount = { loggedIn?: boolean; authMethod?: string; apiProvider?: string; subscriptionType?: string };
type ClaudeResult = { type?: string; subtype?: string; is_error?: boolean; result?: string };

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
const defaultCodexModel = (models: CodexModel[]) => models.find(m => m.isDefault) ?? models[0];

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
      return { models, defaultModel: models.find(model => model.id === defaultGemini)?.id ?? models[0]?.id };
    } catch (error) { geminiCatalog = undefined; throw error; }
  }
  if (!codexCatalog || codexCatalog.expires < Date.now()) {
    codexCatalog = { expires: Date.now() + 60_000, models: discoverCodexModels(program) };
  }
  let models;
  try { models = await codexCatalog.models; }
  catch (error) { codexCatalog = undefined; throw error; }
  if (!models.length) throw new Error('No Codex models are available for this ChatGPT account.');
  return {
    models: models.map((model): ChatModel => ({
      provider, id: model.model, label: model.displayName || model.model,
      efforts: model.supportedReasoningEfforts?.map(item => item.reasoningEffort) ?? [],
      defaultEffort: model.defaultReasoningEffort ?? null,
    })),
    defaultModel: defaultCodexModel(models)?.model,
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
    return [...byId.values()].map(model => {
      const efforts = claudeEfforts.filter(effort => model.efforts.includes(effort));
      return { ...model, efforts, defaultEffort: efforts.includes('medium') ? 'medium' : efforts[0] ?? null };
    });
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

export async function subscriptionReply(selection: SubscriptionSelection, prompt: string, signal: AbortSignal, images: UploadedAttachment[] = []): Promise<string> {
  const { provider, model, effort } = selection;
  if (!isDesktop) throw new Error('Subscription chat is available in the Mac app.');
  const program = executable(provider);
  if (!program) throw new Error(`Install ${labels[provider]} and check Settings → Models.`);
  const cwd = await mkdtemp(join(tmpdir(), 'marion-provider-'));
  const deadline = AbortSignal.timeout(180_000);
  const stop = AbortSignal.any([signal, deadline]);
  try {
    if (provider === 'claude') await requireClaudeSubscription(program, cwd, stop);
    const args = [...providerArgs[provider]];
    if (provider !== 'codex') {
      args.push('--model', model);
      if (effort) args.push('--effort', effort);
      if (provider === 'claude' && images.length) args.push('--input-format', 'stream-json');
    }
    const codexImages = provider === 'codex' ? await Promise.all(images.map(async (image, index) => {
      const extension = image.mime === 'image/jpeg' ? 'jpg' : image.mime.slice('image/'.length);
      const path = join(cwd, `image-${index + 1}.${extension}`);
      await writeFile(path, image.data, { mode: 0o600 });
      return { type: 'localImage', path };
    })) : [];
    const child = spawn(program, args, {
      cwd, env: cliEnvironment(), signal: stop, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let diagnostic = '';
    child.stderr.setEncoding('utf8').on('data', chunk => {
      diagnostic = (diagnostic + chunk).slice(-4096);
    });
    // stdin can close first when the executable exits or the user stops a reply.
    child.stdin.on('error', () => {});
    let processError = false;
    child.on('error', () => { processError = true; });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const write = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');

    try {
      if (provider === 'codex') {
        return await codexReply(lines, write, cwd, prompt, selection, codexImages);
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
        if (provider === 'claude') {
          const message = parseLine<ClaudeResult>(line);
          if (message?.type !== 'result') continue;
          if (message.subtype === 'success' && !message.is_error && typeof message.result === 'string' && message.result.trim()) return message.result;
          if (/model.+(not found|unavailable|access)|access.+model/i.test(message.result ?? '')) {
            throw new Error(`Claude Code could not use ${model} with this account. Choose another model.`);
          }
          throw new Error('Claude Code did not return a reply. Check your Claude sign-in and plan usage in Terminal.');
        }
        const message = parseLine(line);
        if (message?.event !== 'result') continue;
        const result = message.result;
        if (result?.status === 'SUCCESS' && typeof result.response === 'string' && result.response.trim()) return result.response;
        diagnostic += ` ${typeof result?.error === 'string' ? result.error : ''}`;
        break;
      }
    } finally {
      lines.close();
      child.stdin.destroy();
      child.kill();
    }
    if (signal.aborted) throw signal.reason;
    if (deadline.aborted) throw new Error(`${labels[provider]} took too long to respond. Try again.`);
    if (processError) throw new Error(`Could not start ${labels[provider]} on this Mac.`);
    if (provider === 'gemini' && /authenticat|sign.in|log.in/i.test(diagnostic)) {
      throw new Error('Sign in with your personal Google account using agy acp --login in Terminal.');
    }
    throw new Error(`${labels[provider]} did not return a reply. Check sign-in and usage in its own app.`);
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    if (deadline.aborted) throw new Error(`${labels[provider]} took too long to respond. Try again.`);
    throw error;
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export function parseLine<T = ProviderMessage>(line: string): T | undefined {
  try { return JSON.parse(line); } catch { return undefined; }
}

async function codexReply(
  lines: AsyncIterable<string>, write: (value: unknown) => void, cwd: string, prompt: string, selection: SubscriptionSelection, images: { type: string; path: string }[],
): Promise<string> {
  let threadId: string | undefined;
  let reply = '';
  write(initializeCodex);
  for await (const line of lines) {
    const message = parseLine(line);
    if (!message) continue;
    const { id, method, params, result, error } = message;
    if (typeof id !== 'undefined' && method) {
      write({ id, error: { code: -32601, message: 'Unavailable in Marion subscription chat' } });
      continue;
    }
    if (error) {
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
        write(listCodexModels);
        break;
      case 5: {
        const models = ((result?.data ?? []) as CodexModel[]).filter(model => !model.hidden);
        const model = selection.model ? models.find(model => model.model === selection.model) : defaultCodexModel(models);
        if (!model && selection.model) throw new Error(`Codex model ${selection.model} is unavailable for this account. Choose another model.`);
        if (!model?.model) throw new Error('No Codex model is available for this ChatGPT account.');
        if (selection.effort && !model.supportedReasoningEfforts?.some(item => item.reasoningEffort === selection.effort)) {
          throw new Error(`Choose a supported reasoning effort for ${model.model}.`);
        }
        write({ id: 3, method: 'thread/start', params: {
          cwd, model: model.model, modelProvider: 'openai', sandbox: 'read-only', approvalPolicy: 'never', ephemeral: true, serviceTier: 'default',
          baseInstructions: 'Answer as a chat assistant using the messages and attachments the user provides. Use the response format requested by Marion. Do not use native CLI tools.',
        } });
        break;
      }
      case 3:
        threadId = result?.thread?.id;
        if (!threadId) throw new Error('Codex returned no thread.');
        write({ id: 4, method: 'turn/start', params: {
          threadId, input: [{ type: 'text', text: prompt, textElements: [] }, ...images],
          ...(selection.effort ? { effort: selection.effort } : {}),
        } });
        break;
    }
    if (!threadId || params?.threadId !== threadId) continue;
    if (method === 'item/completed' && params.item?.type === 'agentMessage' && typeof params.item.text === 'string') {
      if (params.item.phase !== 'commentary') reply = params.item.text;
    }
    if (method === 'turn/completed') {
      if (params.turn?.status === 'completed' && reply.trim()) return reply;
      throw new Error('Codex did not return a reply. Check your ChatGPT plan usage in Codex.');
    }
  }
  throw new Error('Codex closed before returning a reply. Update the Codex CLI and check codex login status.');
}
