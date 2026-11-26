// Universal skills: seeding, migration/deduplication, prompt injection, and propagation of edits.
// No listener and no model calls (in-memory database). Usage: npm run build && node tests/universal-skills.mjs
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
(await import('../server/dist/agent/subagents.js')).initSubagents();
(await import('../server/dist/agent/rooms.js')).initRooms();

const { createBotRecord } = await import('../server/dist/features/bots.js');
const { systemPrompt } = await import('../server/dist/agent/prompt.js');
const { agentSkills, tokenOptimizerFor, UNIVERSAL_BUDGET } = await import('../server/dist/agent/skills.js');
const { toolMap } = await import('../server/dist/agent/tools.js');
const U = await import('../server/dist/features/universal-skills.js');

const count = (sql, ...args) => db.prepare(sql).get(...args).n;
const universalRows = (user, name) => db.prepare('SELECT * FROM universal_skills WHERE user_id=? AND lower(name)=lower(?)').all(user, name);
const botCopies = (user, name) => count('SELECT COUNT(*) n FROM skills s JOIN bots b ON b.id=s.bot_id WHERE b.user_id=? AND lower(trim(s.name))=lower(?)', user, name);
const occurrences = (text, needle) => text.split(needle).length - 1;
const saveSkill = (botId, args) => toolMap.get('save_skill').impl(args, { botId });

try {
  const addUser = db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)');
  addUser.run('legacy', 'legacy@example.com', 'Legacy', 1000);
  addUser.run('other', 'other@example.com', 'Other', 1000);

  // ---- an existing team from before universal skills: per-bot copies of both skills, one of them edited ----
  const rawBot = (id, user) => db.prepare('INSERT INTO bots(id,user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, user, id, 1000, 1000);
  rawBot('bot_a', 'legacy'); rawBot('bot_b', 'legacy'); rawBot('bot_c', 'legacy');
  const rawSkill = db.prepare('INSERT INTO skills(id,bot_id,name,body,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?)');
  rawSkill.run('s1', 'bot_a', 'Token optimizer', 'OLD optimizer text', '', 1000, 1000);
  rawSkill.run('s2', 'bot_b', 'token optimizer', 'EDITED optimizer text (newest)', 'Keep it lean', 1000, 5000);
  rawSkill.run('s3', 'bot_c', 'Marion Agent guide', 'Per-bot guide copy', '', 1000, 1000);
  rawSkill.run('s4', 'bot_a', 'Marion Agent guide', 'Another guide copy', '', 1000, 900);
  rawSkill.run('s6', 'bot_b', 'prompt Engineering', 'Old per-bot prompt copy', '', 1000, 1000);
  rawSkill.run('s5', 'bot_a', 'Weekly report', 'Private steps', '', 1000, 1000);

  U.migrateUniversalSkills();
  U.migrateUniversalSkills(); // idempotent
  for (const name of ['Token optimizer', 'Marion Agent guide', 'Prompt engineering']) {
    assert.equal(universalRows('legacy', name).length, 1, `${name}: exactly one universal row`);
    assert.equal(botCopies('legacy', name), 0, `${name}: per-bot copies removed`);
  }
  assert.equal(universalRows('legacy', 'Token optimizer')[0].body, 'EDITED optimizer text (newest)', 'newest edit survives the merge');
  assert.equal(universalRows('legacy', 'Marion Agent guide')[0].body, 'Per-bot guide copy', 'newest copy of the guide survives');
  assert.equal(universalRows('legacy', 'Prompt engineering')[0].body, 'Old per-bot prompt copy', 'an existing per-bot copy is folded into the universal skill');
  assert.equal(count("SELECT COUNT(*) n FROM skills WHERE name='Weekly report'"), 1, 'unrelated per-bot skills are untouched');
  assert.equal(count('SELECT COUNT(*) n FROM universal_skills WHERE user_id=?', 'other'), 3, 'migration seeds every user, even without skills');
  assert.equal(universalRows('other', 'Token optimizer')[0].body, U.TOKEN_OPTIMIZER_BODY, 'a fresh user gets the shipped text');
  const pe = universalRows('other', 'Prompt engineering')[0];
  assert.equal(pe.body, U.PROMPT_ENGINEERING_BODY, 'a fresh user gets the shipped Prompt engineering text');
  assert.ok(pe.description.length > 0, 'Prompt engineering has a description');
  for (const needle of [/rough/i, /Create/i, /at most 2/i, /ready-to-use/i, /Output format/i, /Success criteria/i, /exact intent/i]) assert.match(pe.body, needle);
  const shippedChars = U.DEFAULT_UNIVERSAL_SKILLS.reduce((n, d) => n + `### ${d.name}\n${d.body}`.length, 0);
  assert.equal(U.DEFAULT_UNIVERSAL_SKILLS.length, 3, 'three shipped universal skills');
  assert.ok(shippedChars <= UNIVERSAL_BUDGET * 0.6, `shipped skills (${shippedChars} chars) leave room for custom ones in the ${UNIVERSAL_BUDGET} budget`);
  console.log(`PASS seeding, migration and deduplication of the 3 shipped skills (${shippedChars}/${UNIVERSAL_BUDGET} chars used)`);

  // ---- prompt injection: existing bots, bots created later, both prompt paths, once each ----
  const bots = ['bot_a', 'bot_b', 'bot_c'];
  const fresh = createBotRecord('legacy', { name: 'Fresh', skills: [{ name: 'TOKEN optimizer', body: 'would be a duplicate' }, { name: 'Own playbook', body: '1. do it' }] }).id;
  assert.equal(botCopies('legacy', 'Token optimizer'), 0, 'a new bot does not get a per-bot copy');
  assert.equal(count("SELECT COUNT(*) n FROM skills WHERE bot_id=? AND name='Own playbook'", fresh), 1, 'a new bot still gets its own skills');

  for (const id of [...bots, fresh]) {
    const skills = agentSkills(id);
    assert.equal(occurrences(skills, '### Token optimizer'), 1, `${id}: Token optimizer appears once`);
    assert.equal(occurrences(skills, '### Marion Agent guide'), 1, `${id}: Marion Agent guide appears once`);
    assert.equal(occurrences(skills, '### Prompt engineering'), 1, `${id}: Prompt engineering appears once`);
    assert.match(skills, /EDITED optimizer text \(newest\)/);
    assert.doesNotMatch(skills, /- Token optimizer:/, 'no hardcoded duplicate built-in');
    const prompt = await systemPrompt('legacy', id);
    assert.match(prompt, /### Token optimizer/);
    assert.match(prompt, /### Marion Agent guide/);
    assert.match(prompt, /### Prompt engineering/);
  }
  assert.match(agentSkills('bot_a'), /### Weekly report/, 'private skills stay in their own bot');
  assert.doesNotMatch(agentSkills('bot_b'), /Weekly report/);
  assert.match(agentSkills(fresh), /### Own playbook/);
  assert.equal(tokenOptimizerFor('bot_c'), 'EDITED optimizer text (newest)', 'team members use the editable text');
  console.log('PASS universal skills are injected once into existing and newly created bots');

  // ---- updates propagate: via save_skill (same name), the API helpers, and universal: true ----
  const r1 = await saveSkill('bot_a', { name: 'token OPTIMIZER', description: '', body: 'IMPROVED by bot_a' });
  assert.match(r1.output, /Updated universal skill/);
  assert.equal(botCopies('legacy', 'Token optimizer'), 0, 'save_skill did not create a per-bot copy');
  assert.equal(universalRows('legacy', 'Token optimizer').length, 1);
  assert.equal(universalRows('legacy', 'Token optimizer')[0].description, 'Keep it lean', 'empty description keeps the old one');
  for (const id of [...bots, fresh]) assert.match(agentSkills(id), /IMPROVED by bot_a/, `${id} sees the improvement`);
  assert.doesNotMatch(agentSkills('bot_b'), /EDITED optimizer text/);
  assert.equal(universalRows('other', 'Token optimizer')[0].body, U.TOKEN_OPTIMIZER_BODY, 'another user is unaffected');

  const guide = universalRows('legacy', 'Marion Agent guide')[0];
  const upd = U.updateUniversalSkill('legacy', guide.id, { body: 'GUIDE v2 from the UI' });
  assert.ok(upd.ok);
  for (const id of [...bots, fresh]) assert.match(agentSkills(id), /GUIDE v2 from the UI/);
  assert.equal(U.updateUniversalSkill('other', guide.id, { body: 'hijack' }).ok, false, 'cannot edit another user\'s universal skill');
  assert.equal(U.updateUniversalSkill('legacy', guide.id, { name: 'token optimizer' }).ok, false, 'rename cannot collide');

  const r1b = await saveSkill('bot_c', { name: 'PROMPT engineering', description: '', body: 'PROMPT PLAYBOOK v2' });
  assert.match(r1b.output, /Updated universal skill/);
  assert.equal(botCopies('legacy', 'Prompt engineering'), 0, 'save_skill did not create a per-bot copy of Prompt engineering');
  for (const id of [...bots, fresh]) {
    assert.match(agentSkills(id), /PROMPT PLAYBOOK v2/, `${id} sees the Prompt engineering edit`);
    assert.doesNotMatch(agentSkills(id), /Old per-bot prompt copy/);
  }
  assert.equal(universalRows('other', 'Prompt engineering')[0].body, U.PROMPT_ENGINEERING_BODY, 'another user keeps the shipped Prompt engineering');

  const r2 = await saveSkill('bot_b', { name: 'Escalation rules', description: 'when to escalate', body: '1. Ask the owner', universal: true });
  assert.match(r2.output, /Saved universal skill/);
  assert.equal(count("SELECT COUNT(*) n FROM skills WHERE name='Escalation rules'"), 0);
  for (const id of [...bots, fresh]) assert.match(agentSkills(id), /### Escalation rules/);
  const laterBot = createBotRecord('legacy', { name: 'Later' });
  assert.match(agentSkills(laterBot.id), /### Escalation rules/, 'a bot created afterwards gets it too');
  assert.match(await systemPrompt('legacy', laterBot.id), /### Escalation rules/);

  const r3 = await saveSkill('bot_b', { name: 'Private note', description: '', body: '1. mine', universal: false });
  assert.match(r3.output, /Saved skill/);
  assert.doesNotMatch(agentSkills('bot_a'), /Private note/);
  assert.ok(toolMap.get('save_skill').parameters.properties.universal, 'save_skill declares the universal flag');
  assert.ok(!toolMap.get('save_skill').parameters.required.includes('universal'), 'universal is optional');
  console.log('PASS edits via save_skill, the API helpers and universal:true reach every bot');

  // ---- delete: gone for everyone and stays gone; per-bot skill with a universal name is shadowed ----
  const esc = universalRows('legacy', 'Escalation rules')[0];
  assert.ok(U.deleteUniversalSkill('legacy', esc.id));
  for (const id of [...bots, fresh, laterBot.id]) assert.doesNotMatch(agentSkills(id), /Escalation rules/);
  const opt = universalRows('legacy', 'Token optimizer')[0];
  assert.ok(U.deleteUniversalSkill('legacy', opt.id));
  U.migrateUniversalSkills();
  U.ensureUniversalSkills('legacy');
  assert.equal(universalRows('legacy', 'Token optimizer').length, 0, 'a deleted shipped skill is not re-seeded');
  assert.doesNotMatch(agentSkills('bot_a'), /### Token optimizer/);
  assert.equal(tokenOptimizerFor('bot_a'), '');
  const peRow = universalRows('legacy', 'Prompt engineering')[0];
  assert.ok(U.deleteUniversalSkill('legacy', peRow.id));
  U.migrateUniversalSkills();
  assert.equal(universalRows('legacy', 'Prompt engineering').length, 0, 'a deleted Prompt engineering is not re-seeded');
  assert.doesNotMatch(agentSkills('bot_a'), /### Prompt engineering/);
  assert.match(agentSkills('bot_a'), /### Marion Agent guide/, 'other shipped skills are unaffected');
  console.log('PASS deleting a universal skill removes it for every bot and it stays deleted');
} finally {
  db.close();
}
