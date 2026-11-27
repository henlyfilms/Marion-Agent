// Gemini GoogleSignInRequired matcher regression (QA: "logging" was read as "log in").
// The old matcher /authenticat|sign.in|log.in/i turned any agy failure containing "logging", "blog index", "design in"…
// into a Google sign-in card, hiding the real startup / log-write / sandbox / loopback error from the owner.
//  - isGoogleSignInFailure: genuine agy sign-in wording matches (positive); startup, logging, sandbox and loopback
//    failures do not (negative), including look-alikes ("logging in progress" is not "log in").
//  - End to end through subscriptionReply with a fake agy: a sign-in stderr throws GoogleSignInRequired; a logging /
//    sandbox / loopback stderr throws a plain Error that carries agy's own words.
//  - Proxy-auth look-alikes (HTTP 407, "Proxy Authentication Required", Proxy-Authenticate, proxy credentials) and
//    unrelated `--login` errors (unknown option '--login', bash --login, Go/clap flag errors) are not Google sign-in;
//    the genuine GoogleSignInRequired signal (its own message / name) and Google-specific wording still are, even
//    alongside a proxy or flag failure.
//  - QA follow-up: proxy authentication (HTTP 407, proxy credentials) and unrelated --login CLI/shell flag errors are
//    not Google sign-in (negative), while genuine Google/OAuth sign-in still matches even beside them (regression).
// No network, no listener, no model calls.
// Usage: npm run build && node tests/gemini-sign-in.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const bin = mkdtempSync(join(tmpdir(), 'marion-gemini-sign-in-'));
const said = join(bin, 'stderr.txt');
const resultFile = join(bin, 'result-error.txt');
process.env.DB_PATH = ':memory:';
process.env.MARION_DESKTOP_TOKEN = 'test-token';
process.env.MARION_NO_SCHEDULER = '1';
process.env.HOST = '127.0.0.1';
process.env.PATH = bin + delimiter + process.env.PATH;
writeFileSync(join(bin, 'agy'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'models') { console.log('gemini-4-neon-high\\tGemini 4 Neon (High)'); process.exit(0); }
try { fs.readFileSync(0, 'utf8'); } catch {}
let reported = null;
try { reported = fs.readFileSync(${JSON.stringify(resultFile)}, 'utf8'); } catch {}
if (reported === null) {
  process.stderr.write(fs.readFileSync(${JSON.stringify(said)}, 'utf8') + '\\n');
  process.exit(1);
}
// Caller-level mode: stderr with NO trailing newline, then (after stderr is surely read) a stdout result carrying result.error.
process.stderr.write(fs.readFileSync(${JSON.stringify(said)}, 'utf8'));
setTimeout(() => {
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: reported } }) + '\\n');
  setTimeout(() => process.exit(1), 50);
}, 200);
`, { mode: 0o700 });

const SIGN_IN = [
  'Error: not authenticated. Please sign in.',
  'Error: You are not authenticated. Please sign in with Google.',
  'Unauthenticated: run `agy acp --login` to continue',
  'Authentication required',
  'authentication failed: token expired',
  'Login required. Please log in with your personal Google account.',
  'You are not signed in.',
  'Please re-login to continue',
  'Sign-in required',
  'Error: you must log in first',
  'Google OAuth token expired; run `agy acp --login`',
  'error: invalid_grant: Token has been expired or revoked.',
  'Your Google account credentials are invalid, please sign in again',
  'Please sign in with your personal Google account',
];
// QA blocker: proxy authentication is the network's sign-in, not Google's.
const PROXY_AUTH = [
  'HTTP 407 Proxy Authentication Required',
  'Error: request failed with status code 407',
  'HTTP/1.1 407 Proxy Authentication Required\nProxy-Authenticate: Basic realm="corp"',
  'proxy authentication failed: authentication required',
  'Proxy auth failed for http://proxy.corp:8080 — please log in to the proxy',
  'Error: invalid proxy credentials (not authenticated)',
  'proxy: 127.0.0.1:3128 says unauthenticated; sign-in required',
  'tunneling socket could not be established, statusCode=407; proxy authorization required',
];
// QA blocker: a CLI or shell rejecting --login is not agy asking for Google sign-in.
const LOGIN_FLAG = [
  "error: unknown option '--login'",
  'agy: unrecognized option --login',
  "Error: Unknown argument: login (did you mean --login?)\nerror: unknown option '--login'",
  'flag provided but not defined: -login',
  'bash --login: /Users/x/.bash_profile: line 3: syntax error',
  'zsh --login exited with code 1',
  '--login is not supported by this version; upgrade agy',
  'invalid flag --login: expected a value',
];
// Genuine sign-in that also mentions a proxy or a --login flag error elsewhere still shows the card.
const MIXED_SIGN_IN = [
  'HTTP 407 Proxy Authentication Required (retrying direct)\nYou need to sign in with your personal Google account: run `agy acp --login`',
  "warning: unknown option '--login' ignored\nError: not authenticated. Please sign in.",
  // The genuine GoogleSignInRequired signal and Google-specific wording.
  'GoogleSignInRequired: Gemini needs you to sign in',
  'Gemini needs you to sign in with your personal Google account (agy acp --login).',
  'Error: Google OAuth token has expired',
  'oauth2: "invalid_grant" "Token has been expired or revoked."',
  'Your Google account credentials are invalid',
  'Proxy Authentication Required; also: please sign in with Google',
  "error: unknown option '--login'. Unauthenticated: run `agy acp --login` to continue",
];
// More proxy-auth look-alikes (extra regression cases).
const PROXY_AUTH_MORE = [
  'HTTP/1.1 407 Proxy Authentication Required',
  'Error: 407 Proxy Authentication Required. Please sign in.',
  'proxyconnect tcp: Proxy-Authenticate: Basic realm="corp"; authentication required',
  'proxy authentication failed: not authenticated',
  'request failed with status code 407',
  'Proxy credentials required. Login required.',
  'error: proxy auth required — you must log in to the proxy',
  'tunneling socket could not be established, statusCode=407; please sign in',
  'Corporate proxy says: authentication is required',
];
// More unrelated --login errors, some with generic login wording in the same clause.
const LOGIN_FLAG_MORE = [
  "error: unknown option '--login'",
  "error: unknown option '--login' (authentication required for subcommand)",
  'bash --login: line 3: nvm: command not found (not authenticated to npm registry)',
  'zsh --login -c agy: please log in',
  'flag provided but not defined: -login',
  "error: unexpected argument '--login' found, login required flag missing",
  'Error: --login is not supported by this command, must log in via token',
  'unrecognized arguments: --login (authentication required)',
  'invalid option --login, please sign in using --token',
];
const NOT_SIGN_IN = [
  'Error: failed to start: could not open logging directory /Users/x/.gemini/logs: EACCES',
  'logging: write /Users/x/.gemini/antigravity-cli/log/agy.log: no space left on device',
  'fatal: logging init failed (blog index locked)',
  'startup failed: sandbox-exec: sandbox_apply: Operation not permitted',
  'listen tcp 127.0.0.1:0: bind: operation not permitted (loopback)',
  'dial tcp [::1]:443: connect: connection refused',
  'Error: design in progress; catalog in use',
  'panic: runtime error: index out of range [log index 3]',
  'logging in progress… startup timed out after 30s',
  'warning: telemetry login-shell detection skipped; exit code 2',
];

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`ok - ${name}`); };

try {
  await import('../server/dist/db.js');
  await import('../server/dist/features/schema.js');
  const S = await import('../server/dist/agent/subscriptions.js');

  await test('genuine Google sign-in wording matches (regression: still shows the sign-in card)', () => {
    for (const text of SIGN_IN) assert.equal(S.isGoogleSignInFailure(text), true, text);
  });

  await test('startup / logging / sandbox / loopback failures do not match (negative)', () => {
    for (const text of NOT_SIGN_IN) assert.equal(S.isGoogleSignInFailure(text), false, text);
    assert.equal(S.isGoogleSignInFailure(''), false);
  });

  await test('proxy authentication errors (HTTP 407 / proxy credentials) do not match (negative)', () => {
    for (const text of PROXY_AUTH) assert.equal(S.isGoogleSignInFailure(text), false, text);
  });

  await test('unrelated --login CLI / shell flag errors do not match (negative)', () => {
    for (const text of LOGIN_FLAG) assert.equal(S.isGoogleSignInFailure(text), false, text);
  });

  await test('genuine Google sign-in beside a proxy or flag error still matches (regression)', () => {
    for (const text of MIXED_SIGN_IN) assert.equal(S.isGoogleSignInFailure(text), true, text);
  });

  await test('the previous matcher really did misfire on proxy and --login errors (guards the test itself)', () => {
    const previous = [/\b(?:not|un)[\s-]?authenticated\b/i, /\bauthentication (?:is )?(?:required|needed|failed|expired)\b/i,
      /\b(?:please|must|need to|needs you to|required to)\s+(?:re-?)?(?:sign|log)[\s-]?in\b/i, /\b(?:sign|log)[\s-]?in (?:is )?(?:required|needed|expired)\b/i, /--login\b/];
    const misfires = (list) => list.filter((t) => previous.some((p) => p.test(t))).length;
    assert.ok(misfires(PROXY_AUTH) >= 4, 'the proxy set includes the reported false positives');
    assert.ok(misfires(LOGIN_FLAG) >= 4, 'the --login set includes the reported false positives');
  });

  await test('the genuine GoogleSignInRequired signal matches (its own message and name)', () => {
    const signal = new S.GoogleSignInRequired();
    assert.equal(S.isGoogleSignInFailure(signal.message), true, signal.message);
    assert.equal(S.isGoogleSignInFailure(`${signal.name}: ${signal.message}`), true);
    assert.equal(S.isGoogleSignInFailure('GoogleSignInRequired'), true);
  });

  await test('proxy-auth failures (HTTP 407 / Proxy Authentication Required) are not Google sign-in (negative, more cases)', () => {
    for (const text of PROXY_AUTH_MORE) assert.equal(S.isGoogleSignInFailure(text), false, text);
  });

  await test('unrelated --login errors (unknown option, bash --login, flag errors) are not Google sign-in (negative, more cases)', () => {
    for (const text of LOGIN_FLAG_MORE) assert.equal(S.isGoogleSignInFailure(text), false, text);
  });

  await test('the old loose matcher really did misfire on these (guards the test itself)', () => {
    const old = /authenticat|sign.in|log.in/i;
    assert.ok(NOT_SIGN_IN.filter((t) => old.test(t)).length >= 4, 'the negative set includes the reported false positives');
  });

  const selection = { provider: 'gemini', model: 'gemini-4-neon', effort: null };
  await test('end to end: agy sign-in stderr → GoogleSignInRequired', async () => {
    writeFileSync(said, 'Error: You are not authenticated. Please sign in with Google.');
    await assert.rejects(S.subscriptionReply(selection, 'hi', new AbortController().signal),
      (e) => e instanceof S.GoogleSignInRequired && e.name === 'GoogleSignInRequired');
  });

  await test('end to end: logging / sandbox / loopback stderr → plain error with agy\'s own words (negative)', async () => {
    for (const text of [NOT_SIGN_IN[0], NOT_SIGN_IN[1], NOT_SIGN_IN[3], NOT_SIGN_IN[4]]) {
      writeFileSync(said, text);
      await assert.rejects(S.subscriptionReply(selection, 'hi', new AbortController().signal), (e) => {
        assert.ok(!(e instanceof S.GoogleSignInRequired), `not a sign-in card: ${text}`);
        assert.notEqual(e.name, 'GoogleSignInRequired');
        assert.match(e.message, /exited with code 1/);
        assert.ok(e.message.includes(text.slice(0, 30)), `owner sees agy's own words: ${e.message}`);
        return true;
      });
    }
  });

  await test('end to end: proxy 407 / --login flag stderr → plain error with agy\'s own words (negative)', async () => {
    for (const text of [PROXY_AUTH[0], PROXY_AUTH[3], LOGIN_FLAG[0], LOGIN_FLAG[4]]) {
      writeFileSync(said, text);
      await assert.rejects(S.subscriptionReply(selection, 'hi', new AbortController().signal), (e) => {
        assert.ok(!(e instanceof S.GoogleSignInRequired), `not a sign-in card: ${text}`);
        assert.match(e.message, /exited with code 1/);
        assert.ok(e.message.includes(text.slice(0, 20)), `owner sees agy's own words: ${e.message}`);
        return true;
      });
    }
  });

  await test('end to end: proxy 407 / unknown --login stderr → plain error, not a sign-in card (negative)', async () => {
    for (const text of [PROXY_AUTH_MORE[1], LOGIN_FLAG_MORE[1]]) {
      writeFileSync(said, text);
      await assert.rejects(S.subscriptionReply(selection, 'hi', new AbortController().signal), (e) => {
        assert.ok(!(e instanceof S.GoogleSignInRequired), `not a sign-in card: ${text}`);
        assert.match(e.message, /exited with code 1/);
        return true;
      });
    }
  });

  // QA (Jensen) follow-up: 7 misclassifications.
  const sep = (stderr, error) => `${stderr}\n${error}`; // how the caller now joins stderr and result.error
  await test('QA case 1: proxy 407 stderr + Google OAuth expiry in result.error (newline-joined) → sign-in', () => {
    assert.equal(S.isGoogleSignInFailure(sep('HTTP 407 Proxy Authentication Required', 'Google OAuth token expired')), true);
    // The old space join really did hide it (guards the test itself).
    assert.equal(S.isGoogleSignInFailure('HTTP 407 Proxy Authentication Required Google OAuth token expired'), false);
  });
  await test("QA case 2: unknown option '--login' stderr + agy's own hint in result.error (newline-joined) → sign-in", () => {
    assert.equal(S.isGoogleSignInFailure(sep("unknown option '--login'", 'run agy acp --login to sign in with Google')), true);
    assert.equal(S.isGoogleSignInFailure("unknown option '--login' run agy acp --login to sign in with Google"), false);
  });
  await test('QA case 3: a harmless "Connecting via proxy …" clause does not suppress a later sign-in error', () => {
    for (const text of [
      'Connecting via proxy http://proxy.corp:8080\nError: not authenticated. Please sign in.',
      'Connecting via proxy proxy.corp:8080; not authenticated. Please sign in.',
      'Connecting via proxy http://proxy.corp:8080. Authentication required',
      'Connecting via proxy 10.0.0.1:3128 … You are not signed in.',
    ]) assert.equal(S.isGoogleSignInFailure(text), true, text);
  });
  await test("QA case 4: curl's CONNECT tunnel failed, response 407 is proxy auth, not Google (negative)", () => {
    for (const text of [
      'curl: (56) CONNECT tunnel failed, response 407; authentication required',
      'curl: (56) CONNECT tunnel failed, response 407. Please sign in.',
      'CONNECT tunnel failed, response 407 — not authenticated',
    ]) assert.equal(S.isGoogleSignInFailure(text), false, text);
  });
  await test("QA case 5: undici's Proxy response (407) is proxy auth, not Google (negative)", () => {
    for (const text of [
      'Proxy response (407) !== 200 when HTTP Tunneling; authentication required',
      'TypeError: fetch failed. Proxy response (407) !== 200 when HTTP Tunneling. Please sign in.',
      'Error: Proxy response (407) — not authenticated',
    ]) assert.equal(S.isGoogleSignInFailure(text), false, text);
  });
  await test('QA case 6: HTTPS_PROXY … returned (407) is proxy auth, not Google (negative)', () => {
    for (const text of [
      'HTTPS_PROXY http://proxy.corp:8080 returned (407); authentication required',
      'HTTPS_PROXY=http://proxy.corp:8080 returned (407). Please sign in.',
      'error: HTTPS_PROXY proxy.corp returned (407) not authenticated',
    ]) assert.equal(S.isGoogleSignInFailure(text), false, text);
  });
  await test("QA case 7: 'Run agy acp --login (token invalid)' is agy's own hint, not a flag error → sign-in", () => {
    for (const text of ['Run agy acp --login (token invalid)', 'Error: run `agy acp --login` (token invalid)', 'agy acp --login: token invalid'])
      assert.equal(S.isGoogleSignInFailure(text), true, text);
    // Genuine flag errors are still dismissed.
    for (const text of ['--login: unknown option', "'--login' is not a valid option", '--login is not supported by this version'])
      assert.equal(S.isGoogleSignInFailure(text), false, text);
  });

  const viaResult = async (stderr, error) => {
    writeFileSync(said, stderr);
    writeFileSync(resultFile, error);
    try { return await S.subscriptionReply(selection, 'hi', new AbortController().signal).then(() => 'resolved', (e) => e); }
    finally { unlinkSync(resultFile); }
  };
  await test('caller: stderr (no trailing newline) "HTTP 407 Proxy Authentication Required" + result.error "Google OAuth token expired" → GoogleSignInRequired', async () => {
    const e = await viaResult('HTTP 407 Proxy Authentication Required', 'Google OAuth token expired');
    assert.ok(e instanceof S.GoogleSignInRequired, `got ${e?.name}: ${e?.message}`);
  });
  await test("caller: stderr (no trailing newline) \"unknown option '--login'\" + result.error \"run agy acp --login to sign in with Google\" → GoogleSignInRequired", async () => {
    const e = await viaResult("unknown option '--login'", 'run agy acp --login to sign in with Google');
    assert.ok(e instanceof S.GoogleSignInRequired, `got ${e?.name}: ${e?.message}`);
  });
  await test('caller: stderr "CONNECT tunnel failed, response 407" + result.error "authentication required" → plain error (negative)', async () => {
    const e = await viaResult('curl: (56) CONNECT tunnel failed, response 407', 'authentication required');
    assert.ok(e instanceof Error && !(e instanceof S.GoogleSignInRequired), `got ${e?.name}: ${e?.message}`);
  });

  // QA gate 1: classification AND card behaviour together, through the tracked chat path (session → showSignInCard).
  const { db } = await import('../server/dist/db.js');
  const { createBotRecord } = await import('../server/dist/features/bots.js');
  db.prepare('INSERT OR IGNORE INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('qa-u', 'qa@example.com', 'QA', 1000);
  const bot = createBotRecord('qa-u', { name: 'Gate1' });
  const botId = bot.id ?? bot;
  const signInCards = () => db.prepare(`SELECT COUNT(*) AS n FROM rows WHERE bot_id=? AND kind='card' AND json_extract(body,'$.card')='sign-in'`).get(botId).n;
  const tracked = async (stderr) => {
    db.prepare(`DELETE FROM rows WHERE bot_id=? AND kind='card'`).run(botId);
    writeFileSync(said, stderr);
    const e = await S.subscriptionReply(selection, 'hi', new AbortController().signal, [], {
      session: { id: `turn:gate1-${Math.random()}`, kind: 'subscription_bot', userId: 'qa-u', botId, request: 'hi' },
    }).then(() => null, (err) => err);
    return { e, cards: signInCards() };
  };
  await test('gate 1 card: genuine Google sign-in → GoogleSignInRequired AND exactly one sign-in card (positive)', async () => {
    for (const text of ['Error: You are not authenticated. Please sign in with Google.', 'Google OAuth token expired; run `agy acp --login`']) {
      assert.equal(S.isGoogleSignInFailure(text), true, text);
      const { e, cards } = await tracked(text);
      assert.ok(e instanceof S.GoogleSignInRequired, `classified: ${text} → ${e?.name}`);
      assert.equal(cards, 1, `card shown: ${text}`);
    }
  });
  await test('gate 1 card: proxy auth (407 / Proxy-Authenticate / proxy auth failed) → not classified, NO sign-in card (negative)', async () => {
    for (const text of ['HTTP 407 Proxy Authentication Required', 'HTTP/1.1 407 Proxy Authentication Required\nProxy-Authenticate: Basic realm="corp"',
      'proxy authentication failed: authentication required', 'tunneling socket could not be established, statusCode=407; proxy authorization required']) {
      assert.equal(S.isGoogleSignInFailure(text), false, text);
      const { e, cards } = await tracked(text);
      assert.ok(e instanceof Error && !(e instanceof S.GoogleSignInRequired), `not classified: ${text} → ${e?.name}`);
      assert.equal(cards, 0, `no card: ${text}`);
    }
  });
  await test('gate 1 card: unrelated --login failures (CLI flag / shell) → not classified, NO sign-in card (negative)', async () => {
    for (const text of ["error: unknown option '--login'", 'flag provided but not defined: -login', 'bash --login: /etc/profile: line 3: syntax error',
      'unrecognized arguments: --login (authentication required)']) {
      assert.equal(S.isGoogleSignInFailure(text), false, text);
      const { e, cards } = await tracked(text);
      assert.ok(e instanceof Error && !(e instanceof S.GoogleSignInRequired), `not classified: ${text} → ${e?.name}`);
      assert.equal(cards, 0, `no card: ${text}`);
    }
  });

  await test('gate 1 (Rev 3): account mismatch / 407 "Login required" / log-in-to-file / /tmp/--login are not sign-in; Gemini Enterprise saved-credentials is; downstreamClass agrees', async () => {
    const RS = await import('../server/dist/agent/runner-settings.js');
    const failures = [];
    const ACCOUNT_MISMATCH = [
      'Wrong Google account: please log in with henry@example.com instead of other@example.com',
      'Account mismatch: not authenticated as the workspace owner (signed in as other@example.com)',
    ];
    const NOT_AUTH = [
      ...ACCOUNT_MISMATCH,
      'Proxy returned 407. Login required.',
      'error: could not log in to file /var/log/agy.log (permission denied)',
      'open /tmp/--login: no such file or directory',
    ];
    const ENTERPRISE = "You're signed in to Gemini Enterprise, but couldn't load the saved credentials. Run agy acp --login again.";
    const ENTERPRISE_BARE = "signed in to Gemini Enterprise, but couldn't load the saved credentials";
    for (const text of NOT_AUTH) {
      if (S.isGoogleSignInFailure(text)) failures.push(`isGoogleSignInFailure false-positive (sign-in card): ${text}`);
      const { e, cards } = await tracked(text);
      if (e instanceof S.GoogleSignInRequired || cards !== 0) failures.push(`caller false-positive: ${text} → ${e?.name}, ${cards} sign-in card(s)`);
      const cls = RS.downstreamClass(new Error(`Gemini exited with code 1: ${text}`));
      if (cls === 'auth') failures.push(`downstreamClass = auth for: ${text}`);
    }
    for (const text of [ENTERPRISE, ENTERPRISE_BARE]) {
      if (!S.isGoogleSignInFailure(text)) failures.push(`missed sign-in: ${text}`);
      const { e, cards } = await tracked(text);
      if (!(e instanceof S.GoogleSignInRequired) || cards !== 1) failures.push(`caller missed sign-in: ${text} → ${e?.name}, ${cards} card(s)`);
      if (RS.downstreamClass(new Error(text)) !== 'auth') failures.push(`downstreamClass != auth for: ${text}`);
    }
    // Still auth (regression).
    for (const text of ['Sign in to Claude Code in Terminal', 'Gemini: not authenticated. Run agy acp --login', 'Unauthorized: token expired']) {
      if (RS.downstreamClass(new Error(text)) !== 'auth') failures.push(`downstreamClass lost auth for: ${text}`);
    }
    if (RS.downstreamClass(new S.GoogleSignInRequired()) !== 'auth') failures.push('downstreamClass(GoogleSignInRequired) != auth');
    if (failures.length) { console.error('GATE1 FAILURES:\n  ' + failures.join('\n  ')); assert.fail(`${failures.length} gate-1 check(s) failed`); }
  });

  await test('HOLD a68d563 P2 #1: account mismatch beside a Google sign-in clause, "auth … proxy" order, third-party 401s (negative); provider auth still auth', async () => {
    const RS = await import('../server/dist/agent/runner-settings.js');
    const failures = [];
    // 1. Account mismatch anywhere in the message: never a sign-in card, even when another clause is Google-specific.
    for (const text of [
      'Wrong account. Sign in with your Google account a@b',
      'Wrong account; Google OAuth token expired',
      'Account mismatch\nYou need to sign in with your personal Google account: run `agy acp --login`',
      'Please sign in with your personal Google account. Wrong Google account: expected a@b',
    ]) {
      if (S.isGoogleSignInFailure(text)) failures.push(`account mismatch → sign-in card: ${text}`);
      const { e, cards } = await tracked(text);
      if (e instanceof S.GoogleSignInRequired || cards !== 0) failures.push(`caller account mismatch → ${e?.name}, ${cards} card(s): ${text}`);
      if (RS.downstreamClass(new Error(`Gemini exited with code 1: ${text}`)) === 'auth') failures.push(`downstreamClass = auth for mismatch: ${text}`);
    }
    // 2. Proxy auth with "auth" before "proxy".
    for (const text of [
      'Authentication failed for proxy server',
      'Authentication required by proxy proxy.corp:8080',
      'authentication with the upstream proxy failed',
      'Error: authorization failed for corporate proxy; please sign in',
      'invalid credentials for proxy http://proxy.corp:8080',
    ]) {
      if (S.isGoogleSignInFailure(text)) failures.push(`proxy auth → sign-in card: ${text}`);
      const { e, cards } = await tracked(text);
      if (e instanceof S.GoogleSignInRequired || cards !== 0) failures.push(`caller proxy auth → ${e?.name}, ${cards} card(s): ${text}`);
      if (RS.downstreamClass(new Error(`Gemini exited with code 1: ${text}`)) === 'auth') failures.push(`downstreamClass = auth for proxy: ${text}`);
    }
    // A plain sign-in error that merely mentions a proxy elsewhere still counts.
    if (!S.isGoogleSignInFailure('Authentication required. Retrying through proxy http://proxy.corp:8080')) failures.push('lost sign-in beside a harmless proxy mention');
    // 3. Third-party / downstream 401 Unauthorized is not the provider's sign-in.
    for (const text of [
      'GitHub API 401 Unauthorized',
      'Codex exited with code 1: GitHub API 401 Unauthorized',
      'Claude Code exited with code 1: tool gh failed: HTTP 401 Unauthorized',
      'Request to https://api.example.com/v1/items failed: 401 Unauthorized',
      'Acme API returned 401 Unauthorized',
      'MCP server "linear" error: Unauthorized',
    ]) {
      const cls = RS.downstreamClass(new Error(text));
      if (cls === 'auth') failures.push(`downstreamClass = auth for third-party 401: ${text}`);
      if (S.isGoogleSignInFailure(text)) failures.push(`third-party 401 → sign-in card: ${text}`);
    }
    // Genuine provider auth failures stay auth.
    for (const text of [
      'Unauthorized: token expired',
      'Codex exited with code 1: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header',
      'OpenAI API error: 401 Unauthorized',
      'Claude Code exited with code 1: Unauthorized. Invalid API key · Please run /login',
      'Sign in to Claude Code in Terminal',
      'Gemini: not authenticated. Run agy acp --login',
    ]) {
      if (RS.downstreamClass(new Error(text)) !== 'auth') failures.push(`downstreamClass lost provider auth for: ${text}`);
    }
    if (failures.length) { console.error('P2#1 FAILURES:\n  ' + failures.join('\n  ')); assert.fail(`${failures.length} P2 #1 check(s) failed`); }
  });

  console.log(`PASS gemini-sign-in (${passed} tests)`);
} finally {
  rmSync(bin, { recursive: true, force: true });
}
process.exit(0);
