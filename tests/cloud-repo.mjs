// Offline: strict Cloud mode. Fake GitHub CLI and fake Claude CLI, isolated database inside ignored app data.
// Checks that Cloud requests resolve a GitHub repository and launch without any local folder, that every blocker
// (missing, ambiguous, no access, gh sign-in/scopes/missing CLI, Claude GitHub connection) becomes an in-app card with
// concrete fixes instead of a local fallback, and that approving the card carries on in the Cloud. Public repositories
// work read-only (even without gh sign-in or the private scopes), and every Cloud request is one Sessions record from
// the moment it is asked for (Waiting while a card holds it, then Running/Done under the same id).
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const scratch = mkdtempSync(resolve('data/cloud-repo-'));
try {
  process.env.HOME = scratch;
  process.env.DB_PATH = join(scratch, 'test.db');
  process.env.MARION_DESKTOP_TOKEN = 'test-only';
  process.env.MARION_NO_SCHEDULER = '1';
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  process.env.PATH = bin + ':' + process.env.PATH;
  const log = join(scratch, 'claude-cloud.log');
  const script = (name, source) => writeFileSync(join(bin, name), '#!' + process.execPath + '\n' + source, { mode: 0o700 });
  script('claude', `
    const args = process.argv.slice(2);
    const fs = require('node:fs');
    const out = x => console.log(JSON.stringify(x));
    if (args.includes('auth')) { out({loggedIn:true, authMethod:'claude.ai', apiProvider:'firstParty', subscriptionType:'max'}); process.exit(0); }
    if (!args.includes('--cloud')) process.exit(2);
    let remote = '';
    try { remote = require('node:child_process').execFileSync('git',['remote','get-url','origin'],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim(); } catch {}
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({cwd:process.cwd(), remote, files:fs.readdirSync('.')})+'\\n');
    // Like the real CLI on an account without the headless Cloud gate: stream-json is refused, a terminal launch works.
    if (args.includes('--input-format') && fs.existsSync(${JSON.stringify(join(scratch, 'terminal-only'))})) {
      process.stderr.write('Error: --cloud requires an interactive terminal.\\nNon-interactive runs (piped stdout, --init-only, --sdk-url) run locally and would silently ignore --cloud.\\n');
      process.exit(1);
    }
    if (!args.includes('--input-format')) {
      const goal = args[args.indexOf('--cloud') + 1];
      const w = s => process.stdout.write(s);
      let step = 0;
      const create = () => {
        if (goal.includes('MIDESC')) { w('Created cloud session: Fix it\\r\\nView: https://claude.ai/code/session_ab\\x1b[3'); setTimeout(() => { w('0Gcd\\x1b[2Cef\\x1b[1Ggh?from=cli&m=0\\r\\n'); setTimeout(() => process.exit(0), 20); }, 60); return; }
        if (goal.includes('MIDURL')) { w('Created cloud session: Fix it\\r\\nView: https://claude.ai/code/session_ab'); setTimeout(() => { w('\\x1b[1Xcd\\x1b[30Gef?from=cli&m=0\\r\\n'); setTimeout(() => process.exit(0), 20); }, 60); return; }
        if (goal.includes('TERM_FAIL')) { w('\\r\\n\\x1b[31mError: Could not create a cloud session: repository not accessible\\x1b[39m\\r\\n'); process.exit(1); }
        w('Created cloud session: Fix it\\r\\nSession ID: session_term_1\\r\\nView: https://claude.ai/code/session_term_1?from=cli&m=0\\r\\nResume with: claude --teleport session_term_1\\r\\n');
        if (goal.includes('ATTACH')) { let n = 0; const t = setInterval(() => { w('\\x1b[2K\\x1b[G✻ Working… (1s · esc to interrupt)\\r\\n● Edited README.md part ' + (n++) + '\\r\\n'); if (n > 3) clearInterval(t); }, 40); return; }
        setTimeout(() => process.exit(0), 20);
      };
      const next = () => {
        if (!goal.includes('ASK_OWNER')) return create();
        step = 2;
        w('\\x1b[2K\\x1b[1ADo you want to grant Claude access to octo/widget?\\r\\n\\x1b[36m❯\\x1b[39m 1. Yes\\r\\n  2. No\\r\\n');
      };
      // The folder-trust prompt. Default: numbered like Claude Code, ❯ on Yes. SQUASHED: the renderer skips blanks with
      // ESC[nG / ESC[nX instead of spaces, no numbers, and ❯ starts on "No, exit" (listed first).
      const squashed = goal.includes('SQUASHED');
      const options = squashed || goal.includes('UNSPACED') ? ['No, exit', 'Yes, I trust this folder'] : ['Yes, I trust this folder', 'No, exit'];
      let at = 0;
      const squash = line => line.replace(/ /g, (_, i) => i % 2 ? '\\x1b[' + (i + 2) + 'G' : '\\x1b[1X');
      const unspaced = goal.includes('UNSPACED');
      const render = () => {
        // The exact screen a QA run captured: no spaces between words, ❯ on "No, exit" listed before Yes, no numbers.
        if (unspaced) return w('\\x1b[2J\\x1b[Hfolderfirst. ClaudeCode\\'llbeabletoread,edit,andexecutefileshere. Security guide ' + (at === 0 ? '❯' : ' ') + 'No,exit ' + (at === 1 ? '❯' : '') + 'Yes,Itrustthisfolder Entertoconfirm·Esctocancel\\r\\n');
        const lines = ['╭──────╮', '│ \\x1b[1mDo you trust the files in this folder?\\x1b[22m │', "Claude Code'll be able to read, edit, and execute files here.", '',
          ...options.map((o, i) => (i === at ? '❯ ' : '  ') + (squashed ? '' : (i + 1) + '. ') + o)];
        w('\\x1b[?25l\\x1b[2J\\x1b[H' + lines.map(l => '\\x1b[1G' + (squashed ? squash(l) : l)).join('\\r\\n') + '\\r\\n');
      };
      render();
      if (goal.includes('TRUST_THEN_DIE')) setTimeout(() => { w('\\r\\nError: Claude Code crashed while waiting\\r\\n'); process.exit(1); }, 400);
      process.stdin.on('data', d => {
        const key = String(d);
        fs.appendFileSync(${JSON.stringify(join(scratch, 'keys.log'))}, JSON.stringify({ goal: goal.split('\\n').pop().split(' ')[0], key, at }) + '\\n');
        if (step === 0) {
          if (key === '\\x1b[B' || key === '\\x1b[A') { at = Math.max(0, Math.min(options.length - 1, at + (key === '\\x1b[B' ? 1 : -1))); return render(); }
          const pick = key === '\\r' ? at : !squashed && /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
          if (!options[pick] || options[pick].startsWith('No')) { w('Error: folder not trusted\\r\\n'); process.exit(1); }
          if (goal.includes('STUCK')) return render();
          step = 1; return next();
        }
        if (step === 2) { if (key === '\\r') { step = 3; return create(); } w('\\r\\nError: The owner declined GitHub access.\\r\\n'); process.exit(1); }
      });
      return;
    }
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const frame = JSON.parse(line);
      if (frame.type === 'user') {
        const text = frame.message.content[0].text;
        if (text.includes('octo/unlinked')) return out({type:'result',subtype:'error_during_execution',is_error:true,
          errors:['The Claude GitHub app is not installed for octo/unlinked. Connect GitHub access to continue.']});
        out({type:'system',subtype:'init',cloud_session:{id:'cse_cloud_1',view_url:'https://claude.ai/code/cse_cloud_1'}});
        if (text.includes('NEEDS_PERMISSION')) return out({type:'control_request',request_id:'perm-1',request:{subtype:'can_use_tool',tool_name:'Bash',input:{command:'npm test'}}});
        out({type:'result',subtype:'success',result:'Cloud done on '+remote});
      }
      if (frame.type === 'control_response' && frame.response?.request_id === 'perm-1')
        out({type:'result',subtype:'success',result:'Permission '+frame.response.response.behavior});
    });`);
  // A real gh-style device flow, for the parser in ghDeviceAuth.
  script('gh', `
    process.stderr.write('! First copy your one-time code: WXYZ-9876\\nPress Enter to open https://github.com/login/device in your browser...\\n');
    process.stdin.once('data', () => { process.stderr.write('✓ Authentication complete.\\n'); process.exit(0); });`);

  (await import('../server/dist/agent/subagents.js')).initSubagents();
  (await import('../server/dist/agent/rooms.js')).initRooms();
  const { db, now } = await import('../server/dist/db.js');
  const { getRow } = await import('../server/dist/store.js');
  const repoMod = await import('../server/dist/features/cloud-repo.js');
  const { wantsCloud, exactRepo, repoHint, matchRepos, resolveCloudRepo, tokenScopes, ghDeviceAuth, CLOUD_PROMPT_LINE } = repoMod;
  const { cloudGoal } = await import('../server/dist/features/cloud-sessions.js');
  const { launchCloudWork, actOnCloudCard, setCloudDeps, pendingCloudPermissions } = await import('../server/dist/features/cloud-cards.js');
  const { interrupt } = await import('../server/dist/agent/loop.js');
  const { startCloudSession } = await import('../server/dist/features/cloud-sessions.js');
  const { listSessions } = await import('../server/dist/features/agent-sessions.js');
  const { TOOLS, policyFor } = await import('../server/dist/agent/tools.js');

  // ---------- pure helpers ----------
  for (const text of ['Work on Marion Agent in the cloud', 'use Claude Cloud for this', 'start a cloud session on octo/app', 'run it with --cloud', 'do this on Claude Code on the web'])
    assert.ok(wantsCloud(text), text);
  for (const text of ['Fix the login bug', 'deploy to Google Cloud Run', 'cloudy weather today']) assert.equal(wantsCloud(text), false, text);
  assert.equal(exactRepo('https://github.com/Octo/App.git'), 'Octo/App');
  assert.equal(exactRepo('git@github.com:octo/app.git'), 'octo/app');
  assert.equal(exactRepo('octo/app'), 'octo/app');
  assert.equal(exactRepo('Marion Agent'), null);
  assert.equal(repoHint('fix the tests in octo/widget please'), 'octo/widget');
  assert.equal(repoHint('work on the Marion Agent repo in the cloud'), 'Marion Agent');
  assert.deepEqual(tokenScopes("  - Token scopes: 'gist', 'read:org', 'repo'"), ['gist', 'read:org', 'repo']);
  const sample = [{ nameWithOwner: 'octo/marion-agent', url: 'u' }, { nameWithOwner: 'octo/widget', url: 'u' }, { nameWithOwner: 'acme/widget', url: 'u' }, { nameWithOwner: 'octo/widgets-old', url: 'u' }];
  assert.deepEqual(matchRepos(sample, 'Marion Agent').map(r => r.nameWithOwner), ['octo/marion-agent']);
  assert.deepEqual(matchRepos(sample, 'widget').map(r => r.nameWithOwner), ['octo/widget', 'acme/widget']);
  assert.match(CLOUD_PROMPT_LINE, /start_cloud_session/); assert.match(CLOUD_PROMPT_LINE, /Local work is always allowed/);
  assert.doesNotMatch(CLOUD_PROMPT_LINE, /Never look for, list or use a folder|never switch to ask_subscription/, 'no strict local-folder ban in the prompt');
  console.log('PASS cloud helpers: cloud intent, exact/URL repos, repo hints, token scopes, fuzzy ranking, prompt rule');

  // ---------- fake GitHub ----------
  const repo = (nameWithOwner, canPush = true) => ({ nameWithOwner, url: 'https://github.com/' + nameWithOwner, isPrivate: true, canPush, pushedAt: '2026-11-01T00:00:00Z' });
  const gh = { missing: false, authed: true, scopes: ['gist', 'read:org', 'repo'], repos: [] };
  const ghCalls = [];
  const fakeGh = async (args) => {
    ghCalls.push(args.join(' '));
    if (gh.missing) throw Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    if (args[0] === 'auth') {
      if (!gh.authed) throw new Error('You are not logged into any GitHub hosts. To log in, run: gh auth login');
      return `github.com\n  ✓ Logged in to github.com account octo\n  - Token scopes: ${gh.scopes.map(s => `'${s}'`).join(', ')}`;
    }
    if (args[0] === 'api' && args[1] === 'user') return 'octo';
    if (args[0] === 'api') return gh.repos.map(r => JSON.stringify(r)).join('\n');
    if (args[0] === 'repo' && args[1] === 'view') {
      const found = gh.repos.find(r => r.nameWithOwner.toLowerCase() === args[2].toLowerCase());
      if (!found) throw new Error(`GraphQL: Could not resolve to a Repository with the name '${args[2]}'.`);
      return JSON.stringify({ nameWithOwner: found.nameWithOwner, url: found.url, isPrivate: found.isPrivate !== false, viewerPermission: found.canPush ? 'WRITE' : 'READ' });
    }
    if (args[0] === 'repo' && args[1] === 'fork') { gh.repos.push(repo('octo/' + args[2].split('/')[1])); return ''; }
    throw new Error('unexpected gh ' + args.join(' '));
  };
  const launches = [];
  const created = [];
  const device = [];
  let installs = 0;
  setCloudDeps({
    gh: fakeGh,
    claudeInstalled: () => true,
    installGh: async () => { installs++; gh.missing = false; },
    createRepo: async name => { created.push(name); gh.repos.push(repo(name)); },
    deviceAuth: async (args, onCode) => { device.push(args.join(' ')); onCode('ABCD-1234', 'https://github.com/login/device'); await delay(50); gh.authed = true; gh.scopes = ['gist', 'read:org', 'repo']; },
    launch: (...args) => { launches.push(args[4].nameWithOwner); return startCloudSession(...args); },
    // Public repositories GitHub would return without any sign-in (no network in this test).
    publicRepo: async name => name.toLowerCase() === 'torvalds/linux' ? { nameWithOwner: 'torvalds/linux', url: 'https://github.com/torvalds/linux', isPrivate: false, canPush: false } : null,
  });
  const publicRepo = nameWithOwner => ({ ...repo(nameWithOwner, false), isPrivate: false });

  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner', 'test@example.com', 'Owner', now());
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('bot', 'owner', 'Test', 'Helper', '', '', now(), now());
  const userId = 'owner', botId = 'bot', generation = 1;
  const waitFor = async (predicate, what = 'a condition') => {
    for (let i = 0; i < 200; i++) { const result = predicate(); if (result) return result; await delay(25); }
    assert.fail('Timed out waiting for ' + what);
  };
  const card = seq => getRow(botId, seq).body;
  const cloudLog = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  const messages = () => db.prepare("SELECT body FROM rows WHERE bot_id=? AND kind='message'").all(botId).map(r => JSON.parse(r.body).text);
  const localFolder = process.cwd();
  const assertNoLocal = () => {
    for (const run of cloudLog()) {
      assert.ok(run.cwd.startsWith(tmpdir()) || run.cwd.startsWith('/private' + tmpdir()), 'Cloud started outside Marion\'s temporary pointer: ' + run.cwd);
      assert.notEqual(run.cwd, localFolder);
      assert.deepEqual(run.files, ['.git'], 'the pointer folder holds no project files');
      assert.match(run.remote, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/);
    }
    for (const s of listSessions(userId, { kind: 'cloud' })) assert.match(s.folder?.path ?? '', /^https:\/\/github\.com\//, 'Cloud session recorded a local folder');
  };

  // ---------- 1. Cloud request resolves the GitHub repo and launches, no local folder ----------
  gh.repos = [repo('octo/marion-agent'), repo('octo/widget'), repo('acme/widget'), repo('acme/readonly-lib', false)];
  const tool = TOOLS.find(t => t.name === 'start_cloud_session');
  assert.ok(tool, 'start_cloud_session tool exists');
  assert.equal(policyFor(userId, 'start_cloud_session', { repo: 'Marion Agent', prompt: 'x' }, botId).decision, 'ask');
  const ctx = { userId, botId, depth: 0, enqueueBotMessage() {}, turn: { id: 't1', startedAt: Date.now(), request: 'Fix the flaky test in the Marion Agent repo, in the cloud' } };
  const ran = await tool.impl({ prompt: 'Fix the flaky test', repo: 'Marion Agent' }, ctx);
  assert.match(ran.output, /Claude Cloud started on GitHub octo\/marion-agent/);
  assert.deepEqual(launches, ['octo/marion-agent']);
  await waitFor(() => messages().includes('Cloud done on https://github.com/octo/marion-agent.git'), 'the Cloud reply');
  assertNoLocal();
  const exact = await launchCloudWork({ userId, botId, generation, goal: 'Review', query: 'https://github.com/octo/widget' });
  assert.equal(exact.started, true); assert.equal(exact.repo.nameWithOwner, 'octo/widget');
  const hinted = await tool.impl({ prompt: 'Update the README of acme/widget' }, ctx);
  assert.match(hinted.output, /acme\/widget/);
  await waitFor(() => listSessions(userId, { kind: 'cloud' }).filter(s => s.status === 'completed').length === 3, 'three completed Cloud sessions');
  assertNoLocal();
  console.log('PASS strict Cloud launch: name, URL and in-prompt repo resolved on GitHub; Claude starts in an empty pointer with only the GitHub remote');

  // ---------- 2. Talking about Cloud never blocks local work ----------
  const ask = TOOLS.find(t => t.name === 'ask_subscription');
  const localFolderCheck = async (run) => { try { await run(); } catch (error) { assert.doesNotMatch(String(error.message), /The owner asked for|Never use a folder or local copy on this Mac|start_cloud_session/); } };
  await localFolderCheck(() => ask.impl({ provider: 'claude', prompt: 'Fix it', folder: 'Marion Agent' }, ctx));
  await localFolderCheck(() => ask.impl({ provider: 'claude', prompt: 'Fix it locally, we talked about the cloud earlier' }, { ...ctx, turn: undefined }));
  await localFolderCheck(() => TOOLS.find(t => t.name === 'folder_list').impl({ folder: 'Marion Agent' }, ctx));
  await localFolderCheck(() => TOOLS.find(t => t.name === 'orchestrate').impl({ goal: 'x', orchestrator: 'a', workers: ['b'], folder: 'Marion Agent' }, ctx));
  console.log('PASS local work allowed: ask_subscription, folder_list and orchestrate are never refused because Cloud or web sessions came up');

  // ---------- 3. Missing repo → card with fixes, nothing local; approving creates it and continues in the Cloud ----------
  const before = launches.length;
  const missing = await tool.impl({ prompt: 'Build the landing page', repo: 'shiny-new-site' }, ctx);
  assert.equal(missing.endTurn, true);
  assert.match(missing.output, /in-app card/); assert.match(missing.output, /do not say the session started/);
  assert.equal(launches.length, before);
  const missingSeq = db.prepare("SELECT seq FROM rows WHERE bot_id=? AND json_extract(body,'$.card')='cloud' ORDER BY seq DESC").get(botId).seq;
  let body = card(missingSeq);
  assert.equal(body.blocker, 'not-found'); assert.equal(body.status, 'pending'); assert.equal(body.mode, 'setup');
  assert.ok(body.options.some(o => o.kind === 'create-repo' && o.repo === 'octo/shiny-new-site'));
  assert.ok(body.options.some(o => o.kind === 'repo' && o.repo === 'octo/marion-agent'), 'offers recent repositories');
  assert.ok(body.options.some(o => o.kind === 'cancel'));
  assert.throws(() => actOnCloudCard(userId, botId, missingSeq, 'create:octo/shiny-new-site', { local: false }), /on the Mac/);
  assert.throws(() => actOnCloudCard('someone-else', botId, missingSeq, 'cancel', { local: true }), /not found/);
  await actOnCloudCard(userId, botId, missingSeq, 'create:octo/shiny-new-site', { local: true }).done;
  body = card(missingSeq);
  assert.equal(body.status, 'started'); assert.equal(body.repo, 'octo/shiny-new-site');
  assert.deepEqual(created, ['octo/shiny-new-site']);
  assert.equal(launches.at(-1), 'octo/shiny-new-site');
  assert.throws(() => actOnCloudCard(userId, botId, missingSeq, 'cancel', { local: true }), /already done/);
  console.log('PASS missing repo: concrete fixes on an in-app card, Mac-only approval for gh commands, approve → created → Cloud started');

  // ---------- 4. Ambiguous repo → pick on the card ----------
  const ambiguous = await launchCloudWork({ userId, botId, generation, goal: 'Bump deps', query: 'widget' });
  assert.equal(ambiguous.started, false); assert.equal(ambiguous.blocker, 'ambiguous');
  assert.deepEqual(card(ambiguous.seq).options.filter(o => o.kind === 'repo').map(o => o.repo).sort(), ['acme/widget', 'octo/widget']);
  await actOnCloudCard(userId, botId, ambiguous.seq, 'repo:acme/widget', { local: false }).done; // picking a repo runs nothing on the Mac
  assert.equal(card(ambiguous.seq).status, 'started'); assert.equal(launches.at(-1), 'acme/widget');
  console.log('PASS ambiguous repo: every match offered on the card; picking one starts Cloud on it');

  // ---------- 5. Access/auth blockers ----------
  gh.authed = false;
  const auth = await launchCloudWork({ userId, botId, generation, goal: 'Fix CI', query: 'octo/widget' });
  assert.equal(auth.blocker, 'gh-auth'); assert.ok(auth.options.some(o => o.kind === 'gh-login'));
  const login = actOnCloudCard(userId, botId, auth.seq, 'gh-login', { local: true });
  await waitFor(() => card(auth.seq).device?.code === 'ABCD-1234', 'the one-time code on the card');
  assert.equal(card(auth.seq).status, 'working');
  assert.throws(() => actOnCloudCard(userId, botId, auth.seq, 'gh-login', { local: true }), /already working/);
  await login.done;
  assert.equal(card(auth.seq).status, 'started'); assert.equal(card(auth.seq).device, undefined);
  assert.match(device[0], /^auth login --hostname github\.com .*--web --scopes repo,read:org$/);

  gh.scopes = ['gist'];
  const scopes = await launchCloudWork({ userId, botId, generation, goal: 'Fix CI', query: 'octo/widget' });
  assert.equal(scopes.blocker, 'gh-scopes'); assert.match(scopes.problem, /repo and read:org/);
  await actOnCloudCard(userId, botId, scopes.seq, 'gh-scopes', { local: true }).done;
  assert.equal(card(scopes.seq).status, 'started'); assert.match(device[1], /^auth refresh /);

  const readOnly = await launchCloudWork({ userId, botId, generation, goal: 'Patch', query: 'acme/readonly-lib' });
  assert.equal(readOnly.blocker, 'no-access');
  await actOnCloudCard(userId, botId, readOnly.seq, 'fork:acme/readonly-lib', { local: true }).done;
  assert.equal(card(readOnly.seq).status, 'started'); assert.equal(launches.at(-1), 'octo/readonly-lib');

  gh.missing = true;
  const noGh = await launchCloudWork({ userId, botId, generation, goal: 'Patch', query: 'octo/widget' });
  assert.equal(noGh.blocker, 'gh-missing'); assert.ok(noGh.options.some(o => o.kind === 'gh-install'));
  await actOnCloudCard(userId, botId, noGh.seq, 'gh-install', { local: true }).done;
  assert.equal(installs, 1); assert.equal(card(noGh.seq).status, 'started');

  const stopped = await launchCloudWork({ userId, botId, generation, goal: 'Never mind', query: 'nothing-like-this' });
  const launchedBefore = launches.length;
  const waitingId = card(stopped.seq).sessionId;
  assert.ok(waitingId, 'the card names its Sessions record');
  const waitingRow = listSessions(userId, { kind: 'cloud' }).find(s => s.id === 'relay:' + waitingId);
  assert.equal(waitingRow?.status, 'waiting', 'a blocked Cloud request shows in Sessions right away');
  assert.match(waitingRow.error, /Waiting for you/);
  assert.ok(listSessions(userId, { type: 'builders' }).some(s => s.id === 'relay:' + waitingId), 'under Builders too');
  await actOnCloudCard(userId, botId, stopped.seq, 'cancel', { local: false }).done;
  assert.equal(card(stopped.seq).status, 'cancelled'); assert.equal(launches.length, launchedBefore);
  assert.equal(listSessions(userId, { kind: 'cloud' }).find(s => s.id === 'relay:' + waitingId).status, 'stopped', 'cancelling closes the record');

  // A failed fix keeps the card open with the reason instead of falling back anywhere.
  gh.authed = false;
  setCloudDeps({ deviceAuth: async () => { throw new Error('authorization expired'); } });
  const expired = await launchCloudWork({ userId, botId, generation, goal: 'Fix CI', query: 'octo/widget' });
  await actOnCloudCard(userId, botId, expired.seq, 'gh-login', { local: true }).done;
  assert.equal(card(expired.seq).status, 'pending'); assert.match(card(expired.seq).note, /authorization expired/);
  gh.authed = true;
  console.log('PASS access blockers: gh sign-in (code shown on card), scopes, read-only fork, missing gh, cancel and failed fix all stay in-app');

  // ---------- 5b. Public repositories and one Sessions record per Cloud request ----------
  gh.repos.push(publicRepo('vercel/next.js'));
  const pub = await launchCloudWork({ userId, botId, generation, goal: 'Explain the router', query: 'https://github.com/vercel/next.js' });
  assert.equal(pub.started, true, 'a public repository without write access starts right away (no fork needed)');
  assert.equal(pub.repo.canPush, false); assert.equal(pub.repo.isPrivate, false);
  assert.match(cloudGoal('Explain the router', pub.repo), /read-only access: clone and inspect it/);
  assert.doesNotMatch(cloudGoal('Explain the router', pub.repo), /push it, and open a pull request/);
  assert.match(cloudGoal('x', repo('octo/widget')), /open a pull request/, 'writable repositories still get a PR');
  gh.authed = false;
  const signedOut = await launchCloudWork({ userId, botId, generation, goal: 'Summarise the scheduler', query: 'torvalds/linux' });
  assert.equal(signedOut.started, true, 'a public owner/repo needs no gh sign-in');
  const stillBlocked = await launchCloudWork({ userId, botId, generation, goal: 'x', query: 'octo/private-thing' });
  assert.equal(stillBlocked.blocker, 'gh-auth', 'private or unknown repositories still need sign-in');
  gh.authed = true; gh.scopes = ['gist'];
  const noScopes = await launchCloudWork({ userId, botId, generation, goal: 'Read the docs', query: 'vercel/next.js' });
  assert.equal(noScopes.started, true, 'the private-repo scopes are not needed for a public repository');
  gh.scopes = ['gist', 'read:org', 'repo'];
  const privateRead = await resolveCloudRepo('acme/readonly-lib', fakeGh, async () => null);
  assert.equal(privateRead.ok, false); assert.equal(privateRead.blocker, 'no-access', 'private read-only repositories still offer a fork');
  await waitFor(() => listSessions(userId, { kind: 'cloud' }).find(s => s.id === 'relay:' + pub.sessionId)?.status === 'completed', 'the public Cloud run to finish');
  assert.equal(listSessions(userId, { kind: 'cloud' }).find(s => s.id === 'relay:' + pub.sessionId).folder.name, 'vercel/next.js');

  // A request that waited on a card continues the same record once it starts.
  const later = await launchCloudWork({ userId, botId, generation, goal: 'Tidy the widget docs', query: 'widget' });
  const laterId = card(later.seq).sessionId;
  assert.equal(listSessions(userId, { kind: 'cloud' }).find(s => s.id === 'relay:' + laterId).status, 'waiting');
  await actOnCloudCard(userId, botId, later.seq, 'repo:octo/widget', { local: false }).done;
  assert.equal(card(later.seq).sessionId, laterId, 'the card keeps the same session');
  await waitFor(() => listSessions(userId, { kind: 'cloud' }).find(s => s.id === 'relay:' + laterId)?.status === 'completed', 'the waited request to finish');
  const finished = listSessions(userId, { kind: 'cloud' }).find(s => s.id === 'relay:' + laterId);
  assert.equal(finished.folder.name, 'octo/widget'); assert.equal(finished.error, null); assert.equal(finished.calls, 1);
  assert.equal(listSessions(userId, { kind: 'cloud' }).filter(s => s.id === 'relay:' + laterId).length, 1, 'one row, not two');
  assertNoLocal();
  console.log('PASS public repositories: read-only Cloud work without fork, sign-in or scopes; Cloud requests are one Sessions record (Waiting → Done)');

  // ---------- 6. Claude Cloud's own GitHub connection, and mid-run permissions ----------
  gh.repos.push(repo('octo/unlinked'));
  // It never started: the launch rejects (no "started" result) and the fix card is already up.
  await assert.rejects(launchCloudWork({ userId, botId, generation, goal: 'Try', query: 'octo/unlinked' }), error => error.cardShown === true && /not installed/.test(error.message));
  const connectSeq = await waitFor(() => db.prepare("SELECT seq FROM rows WHERE bot_id=? AND json_extract(body,'$.blocker')='cloud-connect'").get(botId)?.seq, 'the Claude GitHub connection card');
  assert.ok(card(connectSeq).options.some(o => o.kind === 'open' && /github\.com\/apps\/claude/.test(o.url)));
  assert.ok(card(connectSeq).options.some(o => o.kind === 'repo' && o.repo === 'octo/unlinked'));

  await launchCloudWork({ userId, botId, generation, goal: 'NEEDS_PERMISSION run tests', query: 'octo/widget' });
  const permSeq = await waitFor(() => db.prepare("SELECT seq FROM rows WHERE bot_id=? AND json_extract(body,'$.mode')='permission'").get(botId)?.seq, 'the permission card');
  assert.match(card(permSeq).problem, /Bash/); assert.match(card(permSeq).solution, /npm test/);
  await actOnCloudCard(userId, botId, permSeq, 'allow', { local: false }).done;
  assert.equal(card(permSeq).status, 'allowed');
  await waitFor(() => messages().includes('Permission allow'), 'the Cloud session to continue after approval');
  assertNoLocal();
  console.log('PASS Cloud connection and permissions: Claude GitHub app card with retry; mid-run tool permission approved in-app and the session continues');

  // ---------- 7. Real gh device flow parsing (fake gh binary) ----------
  const codes = [];
  await ghDeviceAuth(['auth', 'login'], (code, url) => codes.push([code, url]));
  assert.deepEqual(codes, [['WXYZ-9876', 'https://github.com/login/device']]);
  const unresolved = await resolveCloudRepo('', fakeGh);
  assert.equal(unresolved.ok, false); assert.equal(unresolved.blocker, 'not-found'); assert.ok(unresolved.options.some(o => o.kind === 'repo'));
  assert.ok(!ghCalls.some(call => /repo clone|--clone(?!=false)/.test(call)), 'never clones');
  console.log('PASS gh device flow: one-time code parsed and confirmed; unnamed repo asks which one; nothing is cloned');

  // ---------- 8. Headless refused → pseudo-terminal launch; failures are failures ----------
  const CS = await import('../server/dist/features/cloud-sessions.js');
  assert.equal(CS.terminalCloudUrl('View: https://claude.ai/code/session_ab12?from=cli&m=0'), 'https://claude.ai/code/session_ab12');
  assert.equal(CS.terminalCloudUrl('Session ID: cse_x9'), 'https://claude.ai/code/cse_x9');
  assert.equal(CS.terminalCloudUrl('https://evil.test/code/session_x'), null);
  assert.equal(CS.cleanTerminal('\x1b[1mHi\x1b[22m\x1b[3Cthere\r\n\x1b]0;title\x07ok'), 'Hi   there\nok');
  const [shell, shellArgs] = CS.ptyCommand('/x/claude', ['--cloud', "it's"]);
  assert.equal(shell, '/bin/sh'); assert.match(shellArgs[1], /cat <&3 & echo \$! >"\$p"; wait; \} 2>\/dev\/null \| \{/); assert.doesNotMatch(shellArgs[1], /mkfifo/); assert.match(shellArgs[1], process.platform === 'darwin' ? /\/usr\/bin\/script -q \/dev\/null/ : /script -qfec/);
  assert.deepEqual(CS.cloudTerminalArgs('Fix it').slice(0, 2), ['--cloud', 'Fix it']);
  // This sandbox cannot open a pseudo-terminal, so the fake CLI runs directly; the real wrapper is checked above.
  CS.setCloudTerminal((program, args) => [program, args]);
  writeFileSync(join(scratch, 'terminal-only'), '');
  const workCards = () => db.prepare("SELECT body FROM rows WHERE bot_id=? AND json_extract(body,'$.card')='work' ORDER BY seq").all(botId).map(r => JSON.parse(r.body));
  // Claude Code's folder-trust question: an in-app card the owner answers (never an automatic Enter).
  const trustCardSeq = () => waitFor(() => db.prepare("SELECT seq FROM rows WHERE bot_id=? AND json_extract(body,'$.blocker')='folder-trust' AND json_extract(body,'$.status')='pending'").get(botId)?.seq, 'the folder-trust card');
  const answerTrust = async (option = 'allow') => { const seq = await trustCardSeq(); await actOnCloudCard(userId, botId, seq, option, { local: false }).done; return seq; };
  const keysFor = tag => existsSync(join(scratch, 'keys.log')) ? readFileSync(join(scratch, 'keys.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(k => k.goal === tag) : [];
  const termRun = tool.impl({ prompt: 'Fix the README', repo: 'octo/widget' }, ctx);
  const firstTrust = await answerTrust();
  const term = await termRun;
  assert.equal(card(firstTrust).status, 'allowed');
  assert.deepEqual(keysFor('Fix').map(k => k.key), ['1'], 'numbered prompt: presses the number of "Yes, I trust this folder"');
  assert.match(term.output, /confirmed/);
  const termRow = await waitFor(() => listSessions(userId, { type: 'builders' }).find(s => s.cloudUrl === 'https://claude.ai/code/session_term_1' && s.status === 'completed'), 'the terminal-launched session in Sessions → Builders');
  assert.equal(termRow.kind, 'cloud');
  const termCard = await waitFor(() => workCards().find(c => c.links?.some(l => l.url === 'https://claude.ai/code/session_term_1') && c.status === 'done'), 'a finished builder card with the session link');
  assert.equal(termCard.agents[0].label, 'Claude Cloud'); assert.equal(termCard.stop.kind, 'cloud');
  console.log('PASS terminal launch: stream-json refused → pseudo-terminal, trust prompt answered, session URL parsed, builder card + Sessions (Builders) updated');

  // A failed launch is a failed tool result, never "started".
  const failRun = tool.impl({ prompt: 'TERM_FAIL fix', repo: 'octo/widget' }, ctx);
  await answerTrust();
  await assert.rejects(failRun, error => /did NOT start/.test(error.message) && /repository not accessible/.test(error.message));
  await waitFor(() => listSessions(userId, { kind: 'cloud' }).find(s => s.status === 'failed' && /repository not accessible/.test(s.error ?? '')), 'the failed record');
  await waitFor(() => workCards().find(c => c.status === 'failed' && c.steps.some(s => /repository not accessible/.test(s.text))), 'a failed builder card');
  console.log('PASS launch failure: tool result fails with the CLI error, Sessions and the card say failed');

  // A question the CLI asks while launching becomes an in-app approval card; approving continues, declining fails.
  const asked = launchCloudWork({ userId, botId, generation, goal: 'ASK_OWNER fix', query: 'octo/widget' });
  await answerTrust();
  const askSeq = await waitFor(() => db.prepare("SELECT seq FROM rows WHERE bot_id=? AND json_extract(body,'$.mode')='permission' AND json_extract(body,'$.status')='pending'").get(botId)?.seq, 'the launch question card');
  assert.match(card(askSeq).problem, /Claude Code is asking/); assert.match(card(askSeq).solution, /grant Claude access to octo\/widget/);
  await actOnCloudCard(userId, botId, askSeq, 'allow', { local: false }).done;
  assert.equal((await asked).started, true);
  const declined = launchCloudWork({ userId, botId, generation, goal: 'ASK_OWNER again', query: 'octo/widget' });
  await answerTrust();
  const denySeq = await waitFor(() => db.prepare("SELECT seq FROM rows WHERE bot_id=? AND json_extract(body,'$.mode')='permission' AND json_extract(body,'$.status')='pending'").get(botId)?.seq, 'the second question card');
  await actOnCloudCard(userId, botId, denySeq, 'deny', { local: false }).done;
  await assert.rejects(declined, /declined/);
  console.log('PASS launch questions: approvable in-app; approve → started, decline → failed (not started)');

  // Stays attached (live terminal view): progress streams to the card, then Marion detaches when it goes quiet.
  const steps = [];
  const pointerDir = mkdtempSync(join(tmpdir(), 'marion-cloud-test-'));
  const attached = await CS.relayCloudTerminal('claude', pointerDir, 'ATTACH work', new AbortController().signal,
    { onUrl: () => {}, onProgress: line => steps.push(line), onTrust: async () => true }, { idleMs: 400 });
  rmSync(pointerDir, { recursive: true, force: true });
  assert.equal(attached.url, 'https://claude.ai/code/session_term_1'); assert.equal(attached.attached, true);
  assert.ok(steps.some(s => /Edited README\.md part 2/.test(s))); assert.ok(!steps.some(s => /esc to interrupt/.test(s)), 'spinner lines filtered');
  console.log('PASS attached terminal: progress lines stream, spinner noise dropped, detaches when idle');

  // Stop from the work card ends exactly that run.
  assert.throws(() => CS.stopCloudSession(userId, botId, 'nope'), /no longer running/);

  // ---------- 9. Folder trust: squashed ANSI prompt, owner decides, Yes selected deliberately, cards cleaned up ----------
  const squashedPrompt = '\x1b[1G❯\x1b[1XNo,\x1b[5Gexit\r\n\x1b[1G\x1b[1X\x1b[2GYes,\x1b[1XI\x1b[8Gtrust\x1b[1Xthis\x1b[14Gfolder\r\n';
  const cleaned = CS.cleanTerminal(squashedPrompt);
  assert.match(cleaned, /❯\s*No,\s*exit/); assert.match(cleaned, /Yes,\s*I\s*trust\s*this\s*folder/);
  // ESC[nX erases without moving the cursor: no space. ESC[nG within a line is a gap only when reading the screen.
  assert.equal(CS.cleanTerminal('a\x1b[5Gb\x1b[3Xc\x1b[2;9Hd'), 'a bc\nd');
  assert.equal(CS.cleanTerminal('a\x1b[5Gb\x1b[3Xc\x1b[2;9Hd', { gaps: false }), 'abc\nd');
  // Mid-token cursor sequences never cut a session link short (it used to stop at session_ab, and that first link stuck).
  for (const midUrl of ['View: https://claude.ai/code/session_ab\x1b[1Xcd\r\n', 'View: https://claude.ai/code/session_ab\x1b[30Gcd\r\n']) {
    assert.equal(CS.terminalCloudUrl(CS.cleanTerminal(midUrl, { gaps: false }), { complete: true }), 'https://claude.ai/code/session_abcd', JSON.stringify(midUrl));
  }
  assert.equal(CS.terminalCloudUrl('View: https://claude.ai/code/session_ab', { complete: true }), null, 'a link at the very end may still be arriving');
  assert.equal(CS.terminalCloudUrl('Session ID: session_ab\n', { complete: true }), 'https://claude.ai/code/session_ab');
  // A chunk that ends mid-escape (ESC[3 before 0G arrives): the cut-off sequence is dropped, so its "[3" is no terminator.
  const splitAt = 'View: https://claude.ai/code/session_ab\x1b[3';
  assert.equal(CS.terminalCloudUrl(CS.cleanTerminal(splitAt, { gaps: false }), { complete: true }), null, 'mid-escape split: wait for the rest');
  assert.equal(CS.terminalCloudUrl(CS.cleanTerminal(splitAt + '0Gcd\r\n', { gaps: false }), { complete: true }), 'https://claude.ai/code/session_abcd');
  for (const cut of ['\x1b', '\x1b[', '\x1b[?25', '\x1b]0;tit', '\x1b]0;title\x1b']) {
    assert.equal(CS.cleanTerminal('session_ab' + cut, { gaps: false }), 'session_ab', 'cut-off sequence dropped: ' + JSON.stringify(cut));
  }
  assert.equal(CS.cleanTerminal('a\x1b]0;t\x1b\\b c'), 'ab c', 'a complete OSC (ST) is not taken for a cut-off one');
  // ESC[nC and ESC[1G inside a token: nothing under gaps: false (a space / line break only when reading the screen).
  for (const jump of ['\x1b[3C', '\x1b[C', '\x1b[1G', '\x1b[G']) {
    const mid = 'View: https://claude.ai/code/session_ab' + jump + 'cd\r\n';
    assert.equal(CS.terminalCloudUrl(CS.cleanTerminal(mid, { gaps: false }), { complete: true }), 'https://claude.ai/code/session_abcd', JSON.stringify(jump));
  }
  assert.equal(CS.cleanTerminal('a\x1b[2Cb\x1b[1Gc'), 'a  b\nc', 'gaps still drawn when reading the screen');
  assert.ok(CS.isTrustPrompt('❯No,exit\nYes,Itrustthisfolder'));
  assert.ok(CS.isTrustPrompt("Doyoutrustthefilesinthisfolder?"));
  assert.ok(CS.isTrustPrompt("Claude Code’ll be able to read, edit, and execute files here."));
  assert.ok(!CS.isTrustPrompt('Do you want to grant Claude access to octo/widget?'));
  const DOWN = '\x1b[B', UP = '\x1b[A';
  assert.deepEqual(CS.trustSelection('❯No,exit\nYes,Itrustthisfolder'), { number: null, key: DOWN }, 'pointer on No above Yes: one step down');
  assert.deepEqual(CS.trustSelection('Yes, I trust this folder\n❯ No, exit'), { number: null, key: UP }, 'pointer on No below Yes: one step up');
  assert.deepEqual(CS.trustSelection('❯ Yes, I trust this folder\n  No, exit'), { number: null, key: '\r' });
  assert.deepEqual(CS.trustSelection('❯ 1. Yes, I trust this folder\n  2. No, exit'), { number: '1', key: '\r' });
  assert.deepEqual(CS.trustSelection('  1. No, exit\n❯ 2. Yes, I trust this folder'), { number: '2', key: '\r' });
  assert.deepEqual(CS.trustSelection('❯ No, exit\n  Show details\n  Yes, I trust this folder'), { number: null, key: DOWN }, '3 options: ❯ on the first is one step, not Enter');
  assert.deepEqual(CS.trustSelection('  No, exit\n❯ Show details\n  Yes, I trust this folder'), { number: null, key: DOWN }, '3 options: ❯ on the middle one is not Yes');
  assert.deepEqual(CS.trustSelection('Do you trust it?\n❯ Yes, I trust this folder\n  No, exit\nDo you trust it?\n  Yes, I trust this folder\n❯ No, exit'), { number: null, key: UP }, 'only the latest render counts');
  assert.deepEqual(CS.trustSelection('Yes, I trust this folder\nNo, exit'), { number: null, key: null }, 'no pointer, no number: nothing is pressed');
  assert.equal(CS.trustSelection('Do you trust the files in this folder?'), null, 'no Yes option drawn yet');

  // selectTrustOption re-reads the terminal after every key and presses Enter only with ❯ confirmed on Yes.
  const fakeMenu = ({ options, at = 0, drop = 0, lagMs = 0 }) => {
    const yes = options.findIndex(o => o.startsWith('Yes'));
    const render = () => 'Do you trust the files in this folder?\n' + options.map((o, i) => (i === at ? '❯ ' : '  ') + o).join('\n') + '\n';
    let since = render();
    const typed = [];
    return { typed, yes, term: {
      read: () => since,
      wait: ms => delay(ms),
      type: key => {
        typed.push({ key, at }); since = '';
        if (key === '\r' || /^\d$/.test(key)) return;
        if (drop > 0) { drop--; return; }
        at = Math.max(0, Math.min(options.length - 1, at + (key === DOWN ? 1 : -1)));
        const shot = render();
        if (lagMs) setTimeout(() => { since += shot; }, lagMs); else since += shot;
      },
    } };
  };
  const fast = { pollMs: 10, redrawMs: 250, settleMs: 40, numberMs: 200, timeoutMs: 3000 };
  const enterOnYes = (menu, what) => {
    const enters = menu.typed.filter(k => k.key === '\r');
    assert.equal(enters.length, 1, what + ': one Enter'); assert.equal(enters[0].at, menu.yes, what + ': Enter only with ❯ on Yes');
    assert.equal(menu.typed.at(-1).key, '\r', what + ': Enter is the last key');
  };
  const three = fakeMenu({ options: ['No, exit', 'Show details', 'Yes, I trust this folder'] });
  assert.equal((await CS.selectTrustOption(three.term, fast)).ok, true);
  assert.deepEqual(three.typed.map(k => k.key), [DOWN, DOWN, '\r'], '3 options: two arrows, each confirmed by a redraw, then Enter');
  enterOnYes(three, '3 options');
  const lagging = fakeMenu({ options: ['No, exit', 'Yes, I trust this folder'], lagMs: 150 });
  assert.equal((await CS.selectTrustOption(lagging.term, fast)).ok, true);
  assert.deepEqual(lagging.typed.map(k => k.key), [DOWN, '\r'], 'delayed redraw: waits for it, no extra arrow, no early Enter');
  enterOnYes(lagging, 'delayed redraw');
  const dropped = fakeMenu({ options: ['No, exit', 'Yes, I trust this folder'], drop: 1 });
  assert.equal((await CS.selectTrustOption(dropped.term, fast)).ok, true);
  assert.deepEqual(dropped.typed.map(k => k.key), [DOWN, DOWN, '\r'], 'dropped arrow: stepped again, never a blind Enter');
  enterOnYes(dropped, 'dropped arrow');
  const below = fakeMenu({ options: ['No, exit', 'Yes, I trust this folder', 'Show details'], at: 2 });
  assert.equal((await CS.selectTrustOption(below.term, fast)).ok, true);
  assert.deepEqual(below.typed.map(k => k.key), [UP, '\r']); enterOnYes(below, '❯ below Yes');
  const deaf = fakeMenu({ options: ['No, exit', 'Yes, I trust this folder'], drop: Infinity });
  const deafResult = await CS.selectTrustOption(deaf.term, { ...fast, maxSteps: 3 });
  assert.equal(deafResult.ok, false, 'arrows never arrive: fails');
  assert.ok(!deaf.typed.some(k => k.key === '\r'), 'no Enter without ❯ on Yes'); assert.equal(deaf.typed.length, 3, 'bounded retries');
  const numbered = fakeMenu({ options: ['1. Yes, I trust this folder', '2. No, exit'], at: 1 });
  assert.equal((await CS.selectTrustOption(numbered.term, fast)).ok, true);
  assert.deepEqual(numbered.typed.map(k => k.key), ['1'], 'numbered: the number of Yes, and no Enter when the prompt does not redraw');

  // Fix 2a: after a number key, Enter only when the prompt is proven to still wait with ❯ on Yes (never on a stale frame).
  const TRUST_ON_YES = 'Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\n  2. No, exit\n';
  const TRUST_ON_NO = 'Do you trust the files in this folder?\n  1. Yes, I trust this folder\n❯ 2. No, exit\n';
  const afterNumber = async ({ frames, screen }) => {
    let since = TRUST_ON_NO, shown = TRUST_ON_NO;
    const typed = [];
    const result = await CS.selectTrustOption({ read: () => since, wait: ms => delay(ms), screen: () => shown,
      type: key => {
        typed.push(key); since = '';
        if (key === '1') for (const [ms, text, scr] of frames) setTimeout(() => { since += text; shown = scr ?? screen; }, ms);
      } }, fast);
    return { result, typed };
  };
  const NEXT = 'Creating cloud session…\n';
  // (i) The number answered it: one last render with ❯ on Yes, then the next screen (it erases the prompt).
  let run = await afterNumber({ frames: [[20, TRUST_ON_YES, TRUST_ON_YES], [60, NEXT, NEXT]] });
  assert.equal(run.result.ok, true); assert.deepEqual(run.typed, ['1'], 'stale frame, then the next screen: no Enter');
  // Same, with both in one read.
  run = await afterNumber({ frames: [[20, TRUST_ON_YES + NEXT, NEXT]] });
  assert.deepEqual(run.typed, ['1'], 'stale frame and next screen in one read: no Enter');
  // The next screen arrives late (after the stale frame looked settled): still inside the watched window, no Enter.
  run = await afterNumber({ frames: [[20, TRUST_ON_YES, TRUST_ON_YES], [150, NEXT, NEXT]] });
  assert.deepEqual(run.typed, ['1'], 'late next screen inside numberMs: no Enter');
  // A stale frame with ❯ still on No: no arrows after a number key (they would go to the next screen).
  run = await afterNumber({ frames: [[20, TRUST_ON_NO, TRUST_ON_NO], [60, NEXT, NEXT]] });
  assert.deepEqual(run.typed, ['1'], 'stale ❯-on-No frame after a number: no arrows, no Enter');
  // (ii) The number only moved ❯: the prompt redraws with ❯ on Yes and stays on screen, so it still needs Enter.
  run = await afterNumber({ frames: [[20, TRUST_ON_YES, TRUST_ON_YES]] });
  assert.equal(run.result.ok, true); assert.deepEqual(run.typed, ['1', '\r'], 'number moved ❯ only: Enter on the waiting prompt');
  // No screen to read: a stale frame cannot be told from a waiting prompt, so no Enter.
  {
    let since = TRUST_ON_NO; const typed = [];
    await CS.selectTrustOption({ read: () => since, wait: ms => delay(ms),
      type: key => { typed.push(key); since = ''; if (key === '1') setTimeout(() => { since = TRUST_ON_YES; }, 20); } }, fast);
    assert.deepEqual(typed, ['1'], 'no screen: no Enter after a number');
  }

  // Fix 2c: 10+ options. ❯ on "10. Yes" is Enter (not Down); the two-digit number is never typed (it could read as "1").
  assert.deepEqual(CS.trustSelection('Do you trust the files in this folder?\n  9. No, exit\n❯ 10. Yes, I trust this folder'), { number: '10', key: '\r' });
  assert.deepEqual(CS.trustSelection('Do you trust the files in this folder?\n❯ 9. No, exit\n  10. Yes, I trust this folder'), { number: '10', key: DOWN });
  assert.deepEqual(CS.trustSelection('Do you trust the files in this folder?\n> 10. Yes, I trust this folder\n  11. No, exit'), { number: '10', key: '\r' }, 'ASCII > pointer before a two-digit number');
  const ten = (at) => ({ ...fakeMenu({ options: [...Array.from({ length: 9 }, (_, i) => `${i + 1}. Option ${i + 1}`), '10. Yes, I trust this folder', '11. No, exit'], at }), yes: 9 });
  const tenOnYes = ten(9);
  assert.equal((await CS.selectTrustOption(tenOnYes.term, fast)).ok, true);
  assert.deepEqual(tenOnYes.typed.map(k => k.key), ['\r'], '❯ already on "10. Yes": Enter only, no Down, no digits'); enterOnYes(tenOnYes, '10 options');
  const tenBelow = ten(10);
  assert.equal((await CS.selectTrustOption(tenBelow.term, fast)).ok, true);
  assert.deepEqual(tenBelow.typed.map(k => k.key), [UP, '\r'], '❯ on 11: one Up to 10, then Enter'); enterOnYes(tenBelow, '11 options');

  // P0 regression: a number answers the trust prompt; the NEXT prompt ("Do you want to proceed? ❯ 1. Yes, proceed") is the
  // owner's to answer on its own card. It is never auto-confirmed here, with or without the old trust render above it.
  assert.equal(CS.trustSelection('Do you want to proceed?\n❯ 1. Yes, proceed\n  2. No'), null, 'a bare "Yes, proceed" prompt is not the trust prompt');
  assert.equal(CS.trustSelection('Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit\nDo you want to proceed?\n❯ 1. Yes, proceed\n  2. No'), null, 'a question after the trust prompt: a different prompt');
  assert.equal(CS.trustSelection('Do you trust the files in this folder?\n❯ 1. Yes, I trust this folder\nAllow Bash(rm -rf x)?\n❯ 1. Yes\n  2. No'), null, 'no arrows/Enter onto a following tool prompt');
  assert.deepEqual(CS.trustSelection('Do you trust the files in this folder?\n\n/tmp/x\n\n❯ 1. Yes, proceed\n  2. No, exit'), { number: '1', key: '\r' }, 'the older trust dialog ("Yes, proceed" under its header) still works');
  assert.deepEqual(CS.trustSelection('❯ 1. Yes, proceed\n  2. No, exit', { known: true }), { number: '1', key: '\r' }, 'right after an arrow it is still the trust prompt');
  for (const next of ['Do you want to proceed?\n❯ 1. Yes, proceed\n  2. No\n', 'Do you trust the files in this folder?\n  1. Yes, proceed\n  2. No, exit\nDo you want to proceed?\n❯ 1. Yes, proceed\n  2. No\n']) {
    let since = 'Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit\n';
    const typed = [];
    const result = await CS.selectTrustOption({ read: () => since, wait: ms => delay(ms), screen: () => next,
      type: key => { typed.push(key); since = ''; if (key === '1') setTimeout(() => { since = next; }, 30); } }, fast);
    assert.equal(result.ok, true);
    assert.deepEqual(typed, ['1'], 'the following "Yes, proceed" prompt gets no Enter: ' + JSON.stringify(next));
  }

  // Partial redraws: after an arrow Claude Code may redraw only the changed cells (old ❯ blanked, new ❯ drawn), so the output
  // since the key holds no option text. That is a redraw (not a dropped key), read from the whole screen.
  assert.equal(CS.terminalScreen('Do you trust the files in this folder?\r\n❯ No, exit\r\n  Yes, I trust this folder\r\n\x1b[2A\x1b[1G \x1b[1B\x1b[1G❯'),
    'Do you trust the files in this folder?\n  No, exit\n❯ Yes, I trust this folder');
  assert.equal(CS.terminalScreen('abc\x1b[2;5Hxy\x1b[1;2H\x1b[K\r\n\x1b[2KZ'), 'a\nZ', 'absolute moves and line erases');
  const partialMenu = ({ withScreen }) => {
    let raw = 'Do you trust the files in this folder?\r\n❯ No, exit\r\n  Yes, I trust this folder\r\n', since = raw, at = 0;
    const typed = [];
    return { typed, term: {
      read: () => CS.cleanTerminal(since), wait: ms => delay(ms),
      ...withScreen ? { screen: () => CS.terminalScreen(raw) } : {},
      type: key => {
        typed.push({ key, at }); since = '';
        if (key !== DOWN || at === 1) return;
        at = 1;
        const delta = '\x1b[2A\x1b[1G \x1b[1B\x1b[1G❯\x1b[2B\x1b[1G';
        raw += delta; since += delta;
      },
    } };
  };
  const partial = partialMenu({ withScreen: true });
  assert.equal(CS.cleanTerminal('\x1b[2A\x1b[1G \x1b[1B\x1b[1G❯').includes('Yes'), false, 'the delta itself has no "Yes" text');
  assert.equal((await CS.selectTrustOption(partial.term, fast)).ok, true);
  assert.deepEqual(partial.typed.map(k => k.key), [DOWN, '\r'], 'partial redraw: one arrow (not re-stepped as dropped), then Enter');
  assert.equal(partial.typed.at(-1).at, 1, 'Enter only with ❯ on Yes');
  const blind = partialMenu({ withScreen: false });
  const blindResult = await CS.selectTrustOption(blind.term, { ...fast, timeoutMs: 800 });
  assert.equal(blindResult.ok, false, 'no screen to read the partial redraw: fails safely');
  assert.match(blindResult.reason, /redrew only in part/);
  assert.deepEqual(blind.typed.map(k => k.key), [DOWN], 'no extra arrows, no Enter');
  console.log('PASS folder trust: a later "Yes, proceed" prompt is never auto-confirmed; partial (❯-only) redraws are read from the screen, never treated as dropped');

  // The card detail: from the question on, or the latest output (never the oldest) when the question line is not in view.
  assert.equal(CS.trustDetail('old stuff\nDo you trust the files in this folder?\n❯ Yes'), 'Do you trust the files in this folder?\n❯ Yes');
  const tailOnly = CS.trustDetail('OLDEST ' + 'x'.repeat(12_000) + ' ❯ Yes, I trust this folder');
  assert.ok(tailOnly.endsWith('❯ Yes, I trust this folder') && !tailOnly.includes('OLDEST'), 'no question line: the tail, not the oldest output');
  // Several renders in the buffer: the latest one, from its own question line (not the oldest render).
  const render = (pointer) => `Do you trust the files in this folder?\nClaude Code'll be able to read, edit, and execute files here.\n${pointer}\n`;
  assert.equal(CS.trustDetail('OLD ' + render('❯ No, exit') + render('❯ Yes, I trust this folder')),
    "Do you trust the files in this folder?\nClaude Code'll be able to read, edit, and execute files here.\n❯ Yes, I trust this folder");
  assert.equal(CS.trustDetail(render('❯ No, exit') + "Claude Code'll be able to read, edit, and execute files here.\n❯ Yes"),
    'read, edit, and execute files here.\n❯ Yes', 'latest render without a question line: from its own "read, edit" line');

  // (a)+(b) Direct terminal launch: onTrust fires, the startup clock pauses while the owner thinks (startupMs 700, answer after 1500),
  // then ❯ moves from "No, exit" to Yes with the down arrow and Enter is pressed only there; the session URL comes back.
  const trustDir = mkdtempSync(join(tmpdir(), 'marion-cloud-test-'));
  const trustAsked = [];
  const trustedRun = await CS.relayCloudTerminal('claude', trustDir, 'SQUASHED trust', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onTrust: async detail => { trustAsked.push(detail); await delay(1500); return true; } }, { startupMs: 700 });
  assert.equal(trustedRun.url, 'https://claude.ai/code/session_term_1');
  assert.equal(trustAsked.length, 1, 'asked once'); assert.match(trustAsked[0], /trust/i);
  const squashedKeys = keysFor('SQUASHED');
  assert.deepEqual(squashedKeys.map(k => k.key), ['\x1b[B', '\r'], 'down to Yes, then Enter');
  assert.equal(squashedKeys.find(k => k.key === '\r').at, 1, 'Enter pressed with ❯ on "Yes, I trust this folder", never on "No, exit"');
  // Without an answer, the same short startup window still times out.
  await assert.rejects(CS.relayCloudTerminal('claude', trustDir, 'SQUASHED slow', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onPrompt: undefined, onTrust: undefined }, { startupMs: 300 }), /nobody can answer/);

  // (c) Cancel: Esc is sent and the launch fails cleanly.
  await assert.rejects(CS.relayCloudTerminal('claude', trustDir, 'SQUASHED deny', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onTrust: async () => false }, { startupMs: 300 }),
    error => error instanceof CS.CloudLaunchError && error.message === 'Owner declined folder trust' && error.cardShown === true);
  await waitFor(() => keysFor('SQUASHED').some(k => k.key === '\x1b'), 'Esc on decline');
  assert.ok(!keysFor('SQUASHED').filter(k => k.key === '\r').some(k => k.at === 0), 'never Enter on "No, exit"');
  // A trust question nobody can answer any more (conversation reset) is not the owner's decline, and shows no card.
  await assert.rejects(CS.relayCloudTerminal('claude', trustDir, 'SQUASHED aborted', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onTrust: async () => 'aborted' }, { startupMs: 300 }),
    error => error instanceof CS.CloudLaunchError && error.message === CS.FOLDER_TRUST_ABORTED && error.cardShown === false);
  // A session link split across output chunks, with mid-token ESC[1X / ESC[30G, comes back whole.
  const midUrl = await CS.relayCloudTerminal('claude', trustDir, 'MIDURL run', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onTrust: async () => true }, { startupMs: 3000 });
  assert.equal(midUrl.url, 'https://claude.ai/code/session_abcdef');
  // A chunk that ends mid-escape (ESC[3 | 0G), then ESC[2C / ESC[1G inside the link: the whole link, not session_ab.
  const midEsc = await CS.relayCloudTerminal('claude', trustDir, 'MIDESC run', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onTrust: async () => true }, { startupMs: 3000 });
  assert.equal(midEsc.url, 'https://claude.ai/code/session_abcdefgh');
  // Fix 2b: the selection itself throws: the launch fails promptly and cleanly (no unhandled rejection, no stuck clock).
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  const throwStart = Date.now();
  await assert.rejects(CS.relayCloudTerminal('claude', trustDir, 'SQUASHED throws', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onTrust: async () => true },
    { startupMs: 60_000, trust: { get pollMs() { throw new Error('terminal read failed'); } } }),
    error => /could not confirm "Yes, I trust this folder" was selected \(terminal read failed\)/.test(error.message));
  assert.ok(Date.now() - throwStart < 10_000, 'failed right away, not after the startup clock');
  // The owner's trust hook throws (synchronously) or rejects: no answer, so the launch ends right away as aborted
  // (not a decline), never with the startup clock paused until maxMs.
  for (const [how, onTrust] of [['throws', () => { throw new Error('card broke'); }], ['rejects', async () => { throw new Error('card broke'); }]]) {
    const askStart = Date.now();
    await assert.rejects(CS.relayCloudTerminal('claude', trustDir, 'SQUASHED ask ' + how, new AbortController().signal,
      { onUrl: () => {}, onProgress: () => {}, onTrust }, { startupMs: 60_000, maxMs: 120_000 }),
      error => error instanceof CS.CloudLaunchError && error.message === CS.FOLDER_TRUST_ABORTED, 'ask ' + how);
    assert.ok(Date.now() - askStart < 10_000, `ask ${how}: failed right away, not after the startup clock`);
  }
  // The generic prompt hook throwing (no dedicated trust hook) is handled the same way.
  await assert.rejects(CS.relayCloudTerminal('claude', trustDir, 'SQUASHED prompt throws', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onPrompt: () => { throw new Error('card broke'); } }, { startupMs: 60_000, maxMs: 120_000 }),
    error => error.message === CS.FOLDER_TRUST_ABORTED);
  // Fix 4: the launch signal aborts (interrupt / conversation reset) while the folder-trust card is open: the
  // trust-specific error, not "Stopped." and not the owner's decline.
  const resetCtrl = new AbortController();
  let trustOpen = false;
  const resetRun = CS.relayCloudTerminal('claude', trustDir, 'SQUASHED reset mid-card', resetCtrl.signal,
    { onUrl: () => {}, onProgress: () => {}, onTrust: () => { trustOpen = true; return new Promise(() => {}); } }, { startupMs: 60_000 });
  await waitFor(() => trustOpen, 'the trust question');
  resetCtrl.abort(new Error('Stopped.'));
  await assert.rejects(resetRun, error => error instanceof CS.CloudLaunchError && error.message === CS.FOLDER_TRUST_ABORTED
    && error.message !== CS.FOLDER_TRUST_DECLINED && error.cardShown === false);
  // An abort with no trust card open keeps its own reason.
  const plainCtrl = new AbortController();
  const plainRun = CS.relayCloudTerminal('claude', trustDir, 'SQUASHED plain abort', plainCtrl.signal,
    { onUrl: () => {}, onProgress: () => {}, onTrust: async () => true }, { startupMs: 60_000 });
  plainCtrl.abort(new Error('Stopped.'));
  await assert.rejects(plainRun, error => error.message === 'Stopped.' && !(error instanceof CS.CloudLaunchError));
  await delay(50);
  process.off('unhandledRejection', onUnhandled);
  assert.deepEqual(unhandled, [], 'no unhandled rejection');
  rmSync(trustDir, { recursive: true, force: true });

  // Through the in-app card: "Trust folder" / "Cancel", explained, and the launch proceeds or fails.
  const viaCard = launchCloudWork({ userId, botId, generation, goal: 'SQUASHED card', query: 'octo/widget' });
  const trustSeq = await trustCardSeq();
  const trustCard = card(trustSeq);
  assert.equal(trustCard.mode, 'permission'); assert.equal(trustCard.blocker, 'folder-trust');
  assert.deepEqual(trustCard.options.map(o => o.label), ['Trust folder', 'Cancel']);
  assert.match(trustCard.problem, /temporary Git launch folder for octo\/widget/);
  assert.equal(pendingCloudPermissions(), 1);
  await actOnCloudCard(userId, botId, trustSeq, 'allow', { local: false }).done;
  assert.equal((await viaCard).started, true);
  assert.equal(pendingCloudPermissions(), 0);
  const deniedRun = launchCloudWork({ userId, botId, generation, goal: 'SQUASHED refuse', query: 'octo/widget' });
  const deniedSeq = await answerTrust('deny');
  await assert.rejects(deniedRun, error => error.message === 'Owner declined folder trust' && error.cardShown === true);
  assert.equal(card(deniedSeq).status, 'denied');
  assert.ok(keysFor('SQUASHED').some(k => k.key === '\x1b'));
  // The conversation reset before the question came up: no card, and the launch fails as such (not "Owner declined").
  const trustCards = () => db.prepare("SELECT COUNT(*) n FROM rows WHERE bot_id=? AND json_extract(body,'$.blocker')='folder-trust'").get(botId).n;
  const cardsBefore = trustCards();
  await assert.rejects(launchCloudWork({ userId, botId, generation: generation + 1, goal: 'SQUASHED reset', query: 'octo/widget' }),
    error => error.message === CS.FOLDER_TRUST_ABORTED && error.message !== CS.FOLDER_TRUST_DECLINED && error.cardShown === false);
  assert.equal(trustCards(), cardsBefore, 'no folder-trust card for a reset conversation');
  assert.equal(pendingCloudPermissions(), 0);

  // (d) A pending trust card expires, and its wait is dropped, when the launch is stopped or fails.
  const stoppedRun = launchCloudWork({ userId, botId, generation, goal: 'SQUASHED stop', query: 'octo/widget' });
  const stopSeq = await trustCardSeq();
  assert.equal(pendingCloudPermissions(), 1);
  const stopId = await waitFor(() => { const c = workCards().at(-1); return c.status === 'running' && c.stop?.sessionId; }, 'the running work card with Stop');
  CS.stopCloudSession(userId, botId, stopId);
  await assert.rejects(stoppedRun, /Stopped/);
  await waitFor(() => card(stopSeq).status === 'expired', 'the trust card to expire on stop');
  assert.match(card(stopSeq).note, /stopped/);
  assert.equal(pendingCloudPermissions(), 0, 'stop removes the wait');
  assert.throws(() => actOnCloudCard(userId, botId, stopSeq, 'allow', { local: false }), /already done/);
  // Conversation reset (POST /bots/:id/fresh calls interrupt() first) while the trust card is open: FOLDER_TRUST_ABORTED,
  // not "Stopped before the Cloud session started" and not the owner's decline.
  const resetRun2 = launchCloudWork({ userId, botId, generation, goal: 'SQUASHED interrupt', query: 'octo/widget' });
  await trustCardSeq();
  const resetCard = await waitFor(() => { const c = workCards().at(-1); return c.status === 'running' && c.stop?.sessionId && c; }, 'the running work card');
  interrupt(botId);
  await assert.rejects(resetRun2, error => error.message === CS.FOLDER_TRUST_ABORTED && error.message !== CS.FOLDER_TRUST_DECLINED);
  await waitFor(() => workCards().find(c => c.stop?.sessionId === resetCard.stop.sessionId)?.status !== 'running', 'the work card to finish');
  const resetSteps = workCards().find(c => c.stop?.sessionId === resetCard.stop.sessionId).steps.filter(st => st.kind === 'error').map(st => st.text);
  assert.ok(resetSteps.includes(CS.FOLDER_TRUST_ABORTED) && !resetSteps.some(t => /Stopped before the Cloud session started/.test(t)),
    'the work card names the trust abort, not a plain stop: ' + JSON.stringify(resetSteps));
  await waitFor(() => pendingCloudPermissions() === 0, 'the trust wait to drop on interrupt');
  const diedRun = launchCloudWork({ userId, botId, generation, goal: 'SQUASHED TRUST_THEN_DIE', query: 'octo/widget' });
  const diedSeq = await trustCardSeq();
  await assert.rejects(diedRun, /crashed while waiting/);
  await waitFor(() => card(diedSeq).status === 'expired', 'the trust card to expire on failure');
  assert.equal(pendingCloudPermissions(), 0, 'failure removes the wait');
  console.log('PASS folder trust: squashed ANSI prompt detected; owner card (Trust folder / Cancel); startup clock paused; ❯ moved to Yes before Enter; Cancel → Esc + "Owner declined folder trust"; stop/failure expire the card and its wait');

  // ---------- 10. The exact unspaced prompt from QA (it used to stall 2m 30s, then error with raw terminal lines) ----------
  const QA_PROMPT = "folderfirst. ClaudeCode'llbeabletoread,edit,andexecutefileshere. Security guide ❯No,exit Yes,Itrustthisfolder Entertoconfirm·Esctocancel";
  assert.ok(CS.isTrustPrompt(QA_PROMPT), 'unspaced QA prompt recognised');
  assert.deepEqual(CS.trustSelection(QA_PROMPT), { number: null, key: DOWN }, '❯ on "No,exit" first: Down (Enter only once the redraw shows ❯ on Yes)');
  assert.match(CS.waitingPrompt(QA_PROMPT), /folder-trust/);
  assert.equal(CS.FOLDER_TRUST_DECLINED, 'Owner declined folder trust');
  // Without a dedicated trust hook, the generic onPrompt card answers it (never a silent Enter).
  const qaDir = mkdtempSync(join(tmpdir(), 'marion-cloud-test-'));
  const prompted = [];
  const viaPrompt = await CS.relayCloudTerminal('claude', qaDir, 'UNSPACED prompt', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onPrompt: async text => { prompted.push(text); return true; } }, { startupMs: 5000 });
  assert.equal(viaPrompt.url, 'https://claude.ai/code/session_term_1'); assert.equal(prompted.length, 1);
  // Startup clock paused while the owner decides (startupMs 400, owner answers after 1200 ms) and resumed afterwards.
  let waitingSince = 0;
  const paused = await CS.relayCloudTerminal('claude', qaDir, 'UNSPACED pause', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onTrust: async () => { waitingSince = Date.now(); await delay(1200); return true; } }, { startupMs: 400 });
  assert.ok(waitingSince > 0 && paused.url, 'no timeout while the owner was deciding');
  // A timeout on a recognised prompt is a clean sentence, not raw terminal lines.
  await assert.rejects(CS.relayCloudTerminal('claude', qaDir, 'UNSPACED STUCK', new AbortController().signal,
    { onUrl: () => {}, onProgress: () => {}, onTrust: async () => true }, { startupMs: 600 }),
    error => /did not start within 1 seconds\. Claude Code was still waiting on its folder-trust question/.test(error.message)
      && !/Entertoconfirm|Security guide/.test(error.message));
  rmSync(qaDir, { recursive: true, force: true });
  // Through the app: the folder-trust action card, Allow selects Yes (not No), Cancel fails cleanly.
  const qaAllow = launchCloudWork({ userId, botId, generation, goal: 'UNSPACED allow', query: 'octo/widget' });
  const qaSeq = await trustCardSeq();
  assert.equal(card(qaSeq).blocker, 'folder-trust'); assert.deepEqual(card(qaSeq).options.map(o => o.label), ['Trust folder', 'Cancel']);
  await actOnCloudCard(userId, botId, qaSeq, 'allow', { local: false }).done;
  assert.equal((await qaAllow).started, true);
  const allowKeys = keysFor('UNSPACED').filter(k => k.key === '\r');
  assert.ok(allowKeys.length > 0 && allowKeys.every(k => k.at === 1), 'every Enter landed on "Yes, I trust this folder", never "No, exit"');
  const qaCancel = launchCloudWork({ userId, botId, generation, goal: 'UNSPACED cancel', query: 'octo/widget' });
  const qaCancelSeq = await answerTrust('deny');
  await assert.rejects(qaCancel, error => error.message === 'Owner declined folder trust');
  assert.equal(card(qaCancelSeq).status, 'denied');
  console.log('PASS QA unspaced folder-trust prompt: folder-trust card (Trust folder / Cancel), Allow → Down+Enter on Yes, Cancel → "Owner declined folder trust", startup clock paused while asking');
  CS.setCloudTerminal();
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
