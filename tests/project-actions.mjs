// Offline: fake provider CLIs, fake GitHub commands and an isolated database inside ignored app data.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const scratch = mkdtempSync(resolve('data/project-actions-'));
try {
  process.env.HOME = scratch;
  process.env.DB_PATH = join(scratch, 'test.db');
  process.env.MARION_DESKTOP_TOKEN = 'test-only';
  process.env.MARION_NO_SCHEDULER = '1';
  const bin = join(scratch, 'bin');
  mkdirSync(bin);
  process.env.PATH = bin + ':' + process.env.PATH;
  const script = (name, source) => writeFileSync(join(bin, name), '#!' + process.execPath + '\n' + source, { mode: 0o700 });
  script('claude', `
    const args = process.argv.slice(2);
    const out = x => console.log(JSON.stringify(x));
    if (args.includes('auth')) {
      out({loggedIn:true, authMethod:'claude.ai', apiProvider:'firstParty', subscriptionType:'max'});
    } else if (args.includes('--cloud')) {
      require('node:readline').createInterface({input:process.stdin}).on('line', line => {
        if (JSON.parse(line).type !== 'user') return;
        out({type:'system',subtype:'init',cloud_session:{id:'cse_test_123',view_url:'https://claude.ai/code/cse_test_123'}});
        out({type:'assistant',message:{content:[{type:'text',text:'Reviewed src/example.ts'}]}});
        out(JSON.parse(line).message.content[0].text.includes('LIMIT') ?
          {type:'result',subtype:'error_during_execution',is_error:true,errors:['Weekly usage limit reached']} :
          {type:'result',subtype:'success',result:'Finished in Cloud'});
      });
    } else {
      let text = '';
      process.stdin.on('data', chunk => text += chunk).on('end', () => {
        if (text.includes('Saved task from Gemini') && text.includes('nextSteps')) {
          out({type:'result',subtype:'success',result:'Continued saved work'});
        } else {
          out({type:'assistant',message:{content:[{type:'tool_use',name:'Edit',input:{file_path:'src/main.ts'}}]}});
          out({type:'result',subtype:'error_during_execution',is_error:true,result:'You have reached your usage limit'});
        }
      });
    }`);
  script('agy', `
    process.stdin.resume(); process.stdin.on('end', () =>
      console.log(JSON.stringify({event:'result',result:{status:'ERROR',error:{code:429,message:'RESOURCE_EXHAUSTED'}}})));
  `);
  script('codex', `
    const out = x => console.log(JSON.stringify(x));
    require('node:readline').createInterface({input:process.stdin}).on('line', line => {
      const {id} = JSON.parse(line);
      if (id === 1) out({id,result:{}});
      if (id === 2) out({id,result:{account:{type:'chatgpt'}}});
      if (id === 5) out({id,result:{data:[{model:'codex-test',isDefault:true}]}});
      if (id === 3) out({id,result:{thread:{id:'test'}}});
      if (id === 4) {
        out({id,result:{}});
        out({method:'turn/completed',params:{threadId:'test',turn:{status:'failed',error:{codexErrorInfo:'usageLimitExceeded'}}}});
      }
    });
  `);

  (await import('../server/dist/agent/subagents.js')).initSubagents();
  (await import('../server/dist/agent/rooms.js')).initRooms();
  const { db, now } = await import('../server/dist/db.js');
  const { getSetting, setSetting } = await import('../server/dist/features/schema.js');
  const { isUsageLimitError } = await import('../server/dist/agent/usage-limit.js');
  const { subscriptionReply } = await import('../server/dist/agent/subscriptions.js');
  const { agentSettings, saveAgentSettings } = await import('../server/dist/features/agent-settings.js');
  const { gitSnapshot, writeHandoff } = await import('../server/dist/features/handoff-files.js');
  const { continueHandoff, validateFallback } = await import('../server/dist/features/handoffs.js');
  const { startCloudSession, cloudSessionUrl } = await import('../server/dist/features/cloud-sessions.js');
  const { listSessions, beginAgentSession, recoverAgentSessions } = await import('../server/dist/features/agent-sessions.js');
  const { createGitHubRepo, repoSpec, repoCreateArgs } = await import('../server/dist/features/github-repos.js');
  const { policyFor } = await import('../server/dist/agent/tools.js');

  for (const error of ['HTTP 429', 'You’ve hit your limit · resets later', 'rate_limit_error', 'Credit balance is too low',
    {error:{code:429}}, {codexErrorInfo:{usageLimitExceeded:{}}}, {status:'RESOURCE_EXHAUSTED'}]) assert.ok(isUsageLimitError(error), JSON.stringify(error));
  for (const error of ['Check your ChatGPT plan usage in Codex.', 'Model exhausted its context window', 'limit of 5 files', new Error('Sign in first')])
    assert.equal(isUsageLimitError(error), false);
  console.log('PASS usage-limit detector: provider messages and structured errors; excludes generic failures');

  db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('owner','test@example.com','Owner', now());
  db.prepare('INSERT INTO bots(id,user_id,name,label,description,instructions,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
    .run('bot','owner','Test','Helper','','',now(),now());
  const userId = 'owner', botId = 'bot';
  const makeTrack = (id, request) => ({ id, request, userId, botId, kind: 'ask_subscription' });
  const select = provider => ({ provider, model: provider === 'codex' ? 'codex-test' : 'claude-sonnet-5-5', effort: null });
  const cards = () => db.prepare("SELECT seq, body FROM rows WHERE json_extract(body,'$.card')='handoff' ORDER BY seq")
    .all().map(row => ({...JSON.parse(row.body), seq:row.seq}));
  const records = () => readdirSync(join(scratch,'handoffs')).map(file => JSON.parse(readFileSync(join(scratch,'handoffs',file),'utf8')));
  const waitFor = async (predicate) => {
    for (let i = 0; i < 120; i++) { const result = predicate(); if (result) return result; await delay(25); }
    assert.fail('Timed out waiting for a tracked session');
  };
  setSetting(userId, 'agent-settings', { liveFeed: false });
  assert.equal(agentSettings(userId).autoHandoff, false);
  assert.equal(agentSettings(userId).handoffFallback, null);
  assert.throws(() => saveAgentSettings(userId, {autoHandoff:true}), /Choose a fallback/);
  const folder = { path: process.cwd(), label: 'Marion Agent', write: false };
  assert.match((await gitSnapshot(folder.path)).status, /^## main/m);
  const statusBefore = execFileSync('git',['status','--porcelain'],{encoding:'utf8'});
  await assert.rejects(subscriptionReply(select('claude'), 'repair', new AbortController().signal, [], {folder,
    session:makeTrack('manual','Original repair goal')}), /Usage limit reached/);
  const [card] = cards();
  assert.equal(card.status, 'pending');
  const [record] = records();
  assert.equal(record.goal, 'Original repair goal');
  assert.match(record.progress.join(' '), /Edited src\/main\.ts/);
  assert.equal(record.git.root, folder.path);
  assert.ok(record.nextSteps.length >= 2);
  assert.equal(statSync(join(scratch,'handoffs',record.id+'.json')).mode & 0o777, 0o600);
  assert.equal(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}), statusBefore);
  const rejectedDir = resolve('temporary-handoff-guard-' + process.pid);
  try {
    await assert.rejects(writeHandoff(rejectedDir, record.id, {}), /outside Git or ignored/);
    assert.deepEqual(readdirSync(rejectedDir), []);
  } finally { rmSync(rejectedDir,{recursive:true,force:true}); }
  await assert.rejects(continueHandoff('different-user',botId,card.id,select('codex'),card.seq), /no longer available/);
  await continueHandoff(userId,botId,card.id,select('codex'),card.seq);
  assert.equal(cards()[0].status, 'started');
  await assert.rejects(continueHandoff(userId,botId,card.id,select('codex'),card.seq), /no longer available/);
  await waitFor(() => cards().find(c => c.provider === 'codex' && c.status === 'pending'));

  const fallback = await validateFallback({...select('claude'),effort:'high'});
  await assert.rejects(validateFallback({...fallback,effort:'not-real'}), /supported/);
  saveAgentSettings(userId, {handoffFallback:fallback,autoHandoff:true});
  assert.equal(getSetting(userId,'agent-settings',{}).handoffFallback.effort,'high');
  await assert.rejects(subscriptionReply({...select('gemini'),model:'gemini-test'}, 'Gemini has work', new AbortController().signal, [],
    {session:makeTrack('auto','Saved task from Gemini')}), /Usage limit reached/);
  await waitFor(() => listSessions(userId,{kind:'handoff',provider:'claude'}).find(s => s.status === 'completed'));
  assert.equal(cards().find(c => c.provider === 'gemini').status, 'started');
  console.log('PASS handoffs: all three CLI error paths, private ignored file, Git snapshot, ownership, repeat protection, auto fallback');

  saveAgentSettings(userId,{autoHandoff:false});
  const cloudRepo = { nameWithOwner: 'owner/repo', url: 'https://github.com/owner/repo' };
  const okLaunch = startCloudSession(userId,botId,1,'Review Cloud changes',cloudRepo);
  assert.equal(listSessions(userId,{kind:'cloud',botId})[0].status,'running');
  const ok = await okLaunch; // resolves only once Claude confirmed the Cloud session
  const done = await waitFor(() => listSessions(userId,{kind:'cloud'}).find(s => s.id === 'relay:'+ok && s.status === 'completed'));
  assert.equal(done.cloudUrl,'https://claude.ai/code/cse_test_123');
  const failed = await startCloudSession(userId,botId,1,'Cloud LIMIT',cloudRepo);
  const cloudHandoff = await waitFor(() => records().find(r => r.source.id === failed));
  assert.equal(cloudHandoff.source.cloudUrl,done.cloudUrl);
  assert.match(cloudHandoff.progress.join(' '), /Reviewed src\/example\.ts/);
  assert.equal(listSessions(userId,{kind:'cloud',botId}).find(s => s.id === 'relay:'+failed).status,'failed');
  assert.equal(cloudSessionUrl('https://evil.test/code/cse_test_123'),null);
  beginAgentSession({...makeTrack('lost','Disconnected'),kind:'cloud'},'claude');
  recoverAgentSessions();
  assert.match(listSessions(userId,{kind:'cloud'}).find(s => s.id === 'relay:lost').error,/disconnected/);
  console.log('PASS Cloud sessions: tracked from start through success/failure, safe URL, partial progress, handoff and restart status');

  assert.throws(() => repoSpec({name:'--template',visibility:'public'}),/repository name/);
  assert.throws(() => repoSpec({name:'/name',visibility:'private'}),/repository name/);
  assert.throws(() => repoSpec({name:'org/repo',visibility:'internal'}),/Public or Private/);
  assert.throws(() => repoSpec({name:'org/repo',visibility:'private',folder:'/project'}),/reviewed/);
  assert.deepEqual(repoCreateArgs(repoSpec({name:'owner/repo',visibility:'private',description:'--public; echo text'})),
    ['repo','create','owner/repo','--private','--description=--public; echo text']);
  const spec = {name:'owner/repo',visibility:'public'};
  await assert.rejects(createGitHubRepo(spec, async () => { throw Object.assign(new Error('not found'),{code:'ENOENT'}); }), /not installed/);
  await assert.rejects(createGitHubRepo(spec, async () => { throw new Error('not logged in'); }), /gh auth login/);
  const calls = [];
  const url = 'https://github.com/owner/repo';
  const run = async (cmd,args) => {
    calls.push([cmd,...args]);
    if (cmd === 'gh') return args[0] === 'auth' ? '' : url;
    if (args.includes('--show-toplevel')) throw new Error('not a git repository');
    if (args.includes('HEAD') && args[0] === 'rev-parse') throw new Error('unborn branch');
    if (args.includes('--others')) return 'README.md\0';
    if (args[0] === 'branch') return 'main';
    if (args[0] === 'remote' && args.length === 1) return 'origin\nmarion-github';
    return '';
  };
  assert.deepEqual(await createGitHubRepo(spec,run),{url,pushed:false});
  assert.deepEqual(await createGitHubRepo({...spec,folder:scratch,confirmPush:true},run,async () => scratch),{url,pushed:true});
  assert.ok(calls.some(call => call.join(' ') === 'git init -b main'));
  assert.ok(calls.some(call => call.join(' ') === 'git commit -m Initial commit'));
  assert.ok(calls.some(call => call.join(' ') === 'git remote add marion-github-2 '+url+'.git'));
  const partial = await createGitHubRepo({...spec,folder:scratch,confirmPush:true},(cmd,args) => {
    if (args.includes('push')) throw new Error('rejected');
    return run(cmd,args);
  },async () => scratch);
  assert.equal(partial.url,url); assert.equal(partial.pushed,false); assert.match(partial.warning,/did not finish/);
  await assert.rejects(createGitHubRepo({...spec,folder:scratch,confirmPush:true},(cmd,args) =>
    args.includes('--others') ? Promise.resolve('.env\0README.md\0') : run(cmd,args),async () => scratch),/Potential credentials/);
  assert.equal(policyFor(userId,'github_create_repo',spec,botId).decision,'ask');
  console.log('PASS GitHub: validation, argv safety, missing/auth errors, init and push, existing remote preserved, partial failure, approval');
} finally {
  rmSync(scratch,{recursive:true,force:true});
}
