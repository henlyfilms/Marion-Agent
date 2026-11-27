// Offline: strict Cloud mode. Fake GitHub CLI and fake Claude CLI, isolated database inside ignored app data.
// Checks that Cloud requests resolve a GitHub repository and launch without any local folder, that every blocker
// (missing, ambiguous, no access, gh sign-in/scopes/missing CLI, Claude GitHub connection) becomes an in-app card with
// concrete fixes instead of a local fallback, and that approving the card carries on in the Cloud.
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
    try { remote = require('node:child_process').execFileSync('git',['remote','get-url','origin'],{encoding:'utf8'}).trim(); } catch {}
    fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({cwd:process.cwd(), remote, files:fs.readdirSync('.')})+'\\n');
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
  const { launchCloudWork, actOnCloudCard, setCloudDeps } = await import('../server/dist/features/cloud-cards.js');
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
  assert.match(CLOUD_PROMPT_LINE, /start_cloud_session/); assert.match(CLOUD_PROMPT_LINE, /Never look for, list or use a folder/);
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
      return JSON.stringify({ nameWithOwner: found.nameWithOwner, url: found.url, isPrivate: true, viewerPermission: found.canPush ? 'WRITE' : 'READ' });
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
  });

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

  // ---------- 2. Local fallbacks are refused when Cloud was asked for ----------
  const ask = TOOLS.find(t => t.name === 'ask_subscription');
  await assert.rejects(ask.impl({ provider: 'claude', prompt: 'Fix it', folder: 'Marion Agent' }, ctx), /start_cloud_session/);
  await assert.rejects(ask.impl({ provider: 'claude', prompt: 'Fix it in the cloud' }, { ...ctx, turn: undefined }), /Never use a folder/);
  await assert.rejects(TOOLS.find(t => t.name === 'folder_list').impl({ folder: 'Marion Agent' }, ctx), /start_cloud_session/);
  await assert.rejects(TOOLS.find(t => t.name === 'orchestrate').impl({ goal: 'x', orchestrator: 'a', workers: ['b'], folder: 'Marion Agent' }, ctx), /start_cloud_session/);
  console.log('PASS no local fallback: ask_subscription, folder_list and orchestrate with a folder refuse Cloud requests');

  // ---------- 3. Missing repo → card with fixes, nothing local; approving creates it and continues in the Cloud ----------
  const before = launches.length;
  const missing = await tool.impl({ prompt: 'Build the landing page', repo: 'shiny-new-site' }, ctx);
  assert.equal(missing.endTurn, true);
  assert.match(missing.output, /in-app card/); assert.match(missing.output, /never fall back to a local folder/);
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
  await actOnCloudCard(userId, botId, stopped.seq, 'cancel', { local: false }).done;
  assert.equal(card(stopped.seq).status, 'cancelled'); assert.equal(launches.length, launchedBefore);

  // A failed fix keeps the card open with the reason instead of falling back anywhere.
  gh.authed = false;
  setCloudDeps({ deviceAuth: async () => { throw new Error('authorization expired'); } });
  const expired = await launchCloudWork({ userId, botId, generation, goal: 'Fix CI', query: 'octo/widget' });
  await actOnCloudCard(userId, botId, expired.seq, 'gh-login', { local: true }).done;
  assert.equal(card(expired.seq).status, 'pending'); assert.match(card(expired.seq).note, /authorization expired/);
  gh.authed = true;
  console.log('PASS access blockers: gh sign-in (code shown on card), scopes, read-only fork, missing gh, cancel and failed fix all stay in-app');

  // ---------- 6. Claude Cloud's own GitHub connection, and mid-run permissions ----------
  gh.repos.push(repo('octo/unlinked'));
  const unlinked = await launchCloudWork({ userId, botId, generation, goal: 'Try', query: 'octo/unlinked' });
  assert.equal(unlinked.started, true);
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
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
