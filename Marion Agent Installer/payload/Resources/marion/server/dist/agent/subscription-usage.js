import { execFile, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { claudeIsolation, cliEnvironment, codexArgs, executable, googleSettings, initializeCodex, parseLine, requireClaudeSubscription, } from './subscriptions.js';
const run = promisify(execFile);
export const usageProviders = ['codex', 'claude', 'gemini'];
const maxAge = 60_000;
const cache = new Map();
const pending = new Map();
function usageWindow(id, label, usedPercent, resetsAt) {
    if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent))
        return [];
    const reset = typeof resetsAt === 'number' && resetsAt > 0 && resetsAt < 8.64e15 ? resetsAt : undefined;
    return [{ id, label, usedPercent: Math.min(100, Math.max(0, usedPercent)), resetsAt: reset }];
}
function windowLabel(minutes) {
    if (!minutes)
        return 'Usage limit';
    if (minutes === 10_080)
        return 'Weekly limit';
    if (minutes % 1440 === 0)
        return `${minutes / 1440}-day limit`;
    if (minutes % 60 === 0)
        return `${minutes / 60}-hour limit`;
    return `${minutes}-minute limit`;
}
async function codexUsage(program, cwd) {
    const child = spawn(program, codexArgs, { cwd, env: cliEnvironment(), signal: AbortSignal.timeout(10_000), stdio: ['pipe', 'pipe', 'ignore'] });
    child.on('error', () => { });
    child.stdin.on('error', () => { });
    const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
    const send = (value) => child.stdin.write(JSON.stringify(value) + '\n');
    let plan;
    try {
        send(initializeCodex);
        for await (const line of output) {
            const message = parseLine(line);
            if (!message || message.method)
                continue;
            if (message.error)
                break;
            if (message.id === 1) {
                send({ method: 'initialized' });
                send({ id: 2, method: 'account/read', params: { refreshToken: false } });
            }
            if (message.id === 2) {
                const account = message.result?.account;
                if (account?.type !== 'chatgpt')
                    return { windows: [], signedOut: true };
                plan = typeof account.planType === 'string' && account.planType ? account.planType : undefined;
                send({ id: 6, method: 'account/rateLimits/read' });
            }
            if (message.id === 6) {
                const main = message.result?.rateLimits;
                const byId = message.result?.rateLimitsByLimitId;
                const limits = Object.entries(byId ?? {}).filter(([, limit]) => limit);
                if (main && !limits.some(([id]) => id === (main.limitId || 'codex')))
                    limits.unshift([main.limitId || 'codex', main]);
                const windows = limits.flatMap(([id, limit]) => [limit.primary, limit.secondary].flatMap((window, index) => {
                    if (!window)
                        return [];
                    const label = windowLabel(window.windowDurationMins);
                    const title = id === 'codex' ? label : `${limit.limitName || id.replaceAll('_', ' ')} · ${label}`;
                    return usageWindow(`${id}-${index}`, title, window.usedPercent, window.resetsAt && window.resetsAt * 1000);
                }));
                return { plan: plan && `ChatGPT ${plan[0].toUpperCase()}${plan.slice(1)}`, windows };
            }
        }
    }
    finally {
        output.close();
        child.stdin.destroy();
        child.kill();
    }
    return { windows: [] };
}
async function geminiUsage(program, cwd) {
    try {
        const { stdout } = await run(program, ['--mode', 'plan', '--sandbox', '--settings', googleSettings, '--print', '/usage', '--output-format', 'json'], {
            cwd, env: cliEnvironment(), timeout: 12_000, maxBuffer: 128_000,
        });
        const report = parseLine(stdout);
        const group = report?.command?.data?.groups?.find(group => /^gemini\b/i.test(group.name ?? ''));
        const buckets = [...(group?.buckets ?? [])].sort((a, b) => Number(b.window === '5h') - Number(a.window === '5h'));
        const windows = buckets.flatMap(bucket => {
            if (!bucket.id || bucket.disabled || typeof bucket.remaining_fraction !== 'number')
                return [];
            const title = bucket.window === 'weekly' ? 'Weekly limit' : bucket.window === '5h' ? '5-hour limit' : bucket.name?.replace(/ remaining$/i, '') ?? 'Usage limit';
            return usageWindow(bucket.id, title, (1 - bucket.remaining_fraction) * 100, Date.parse(bucket.reset_time ?? ''));
        });
        return { windows };
    }
    catch (error) {
        const failure = error;
        return { windows: [], signedOut: /not authenticated|authentication required|no valid authentication|sign in to antigravity/i.test(`${failure.stderr} ${failure.stdout}`) };
    }
}
async function claudeUsage(program, cwd) {
    const plan = await requireClaudeSubscription(program, cwd, AbortSignal.timeout(6_000)).catch(() => null);
    if (!plan)
        return { windows: [], signedOut: true };
    return { windows: await claudeUsageWindows(program, cwd), plan: `Claude ${plan[0].toUpperCase()}${plan.slice(1)}` };
}
async function claudeUsageWindows(program, cwd) {
    return run(program, [
        ...claudeIsolation, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '',
        '--permission-mode', 'dontAsk', '--no-session-persistence', '--print', '/usage', '--output-format', 'json',
    ], {
        cwd, env: { ...cliEnvironment(), DISABLE_AUTOUPDATER: '1' }, timeout: 12_000, maxBuffer: 128_000,
    }).then(({ stdout }) => {
        const report = parseLine(stdout);
        if (report?.subtype !== 'success' || report.num_turns !== 0 || typeof report.result !== 'string')
            return [];
        return report.result.split(/\r?\n/).flatMap(line => {
            const match = /^(Current session|Current week(?: \([^)]+\))?):\s*(\d{1,3}(?:\.\d+)?)% used(?:\s*·\s*resets\s+(.{1,100}))?$/i.exec(line.trim());
            if (!match)
                return [];
            const [, name, percent, resetLabel] = match;
            const session = name.toLowerCase() === 'current session';
            const scope = /\(([^)]+)\)/.exec(name)?.[1];
            const title = session ? '5-hour limit' : scope && scope.toLowerCase() !== 'all models' ? `Weekly · ${scope}` : 'Weekly limit';
            return usageWindow(name.toLowerCase(), title, Number(percent)).map(window => ({ ...window, resetLabel }));
        });
    }).catch(() => []);
}
const readers = { codex: codexUsage, gemini: geminiUsage, claude: claudeUsage };
const details = {
    codex: 'Check account usage in Codex.',
    claude: 'Open /usage in Claude Code or view your Claude plan.',
    gemini: 'Open /usage in Antigravity to check your Google AI plan.',
};
const login = {
    codex: 'Run codex login and sign in with ChatGPT.',
    claude: 'Run claude auth login --claudeai.',
    gemini: 'Run agy acp --login and sign in with Google.',
};
export function readProvider(provider, desktop, refresh) {
    const empty = { provider, windows: [] };
    if (!desktop)
        return Promise.resolve({ ...empty, status: 'unavailable', detail: 'Open the Mac app to read its signed-in CLI.' });
    const previous = cache.get(provider);
    const inFlight = pending.get(provider);
    if (inFlight)
        return inFlight;
    if (!refresh && previous && previous.expires > Date.now())
        return Promise.resolve(previous.saved);
    const program = executable(provider);
    if (!program) {
        cache.delete(provider);
        return Promise.resolve({ ...empty, status: 'missing', detail: 'Install this CLI on the Marion Agent Mac.' });
    }
    const collect = async () => {
        const cwd = await mkdtemp(join(tmpdir(), 'marion-usage-'));
        let reading = { windows: [] };
        try {
            reading = await readers[provider](program, cwd);
        }
        catch { /* Provider failures are independent and never expose raw CLI output. */ }
        finally {
            await rm(cwd, { recursive: true, force: true });
        }
        if (reading.signedOut)
            return { ...empty, status: 'sign-in', detail: login[provider] };
        if (reading.windows.length)
            return { provider, status: 'ready', plan: reading.plan, windows: reading.windows, checkedAt: Date.now() };
        if (previous?.saved.windows.length)
            return { ...previous.saved, status: 'stale' };
        return { ...empty, status: 'unavailable', plan: reading.plan, detail: details[provider] };
    };
    const task = collect().catch(() => ({ ...empty, status: 'unavailable', detail: details[provider] }))
        .then(saved => { cache.set(provider, { saved, expires: Date.now() + (saved.status === 'ready' ? maxAge : 15_000) }); return saved; })
        .finally(() => pending.delete(provider));
    pending.set(provider, task);
    return task;
}
export function subscriptionUsage(desktop, refresh) {
    return Promise.all(usageProviders.map(provider => readProvider(provider, desktop, refresh)));
}
//# sourceMappingURL=subscription-usage.js.map