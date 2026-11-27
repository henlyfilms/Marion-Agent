// marion_app chat reasoning effort: read (list_bots / get_chat_effort) and write (set_chat_effort / set_chat_default_effort)
// without touching models or non-chat settings. Desktop mode (Claude as the inherited chat provider), offline, no CLIs run.
// Usage: npm run build && node tests/chat-effort-app.mjs
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), 'marion-effort-')), 'a.db');
process.env.MARION_LOCAL_MODEL_URL = 'http://127.0.0.1:9/v1';
process.env.MARION_DESKTOP_TOKEN = 'test-desktop';
process.env.HOST = '127.0.0.1';
delete process.env.SERVER_URL;
const { db } = await import('../server/dist/db.js');
await import('../server/dist/features/schema.js');
await import('../server/dist/db-config.js');
(await import('../server/dist/agent/subagents.js')).initSubagents();
const { isDesktop } = await import('../server/dist/lib/desktop-access.js');
assert.ok(isDesktop, 'test runs in desktop mode so subscription inheritance is exercised');
const { createBotRecord } = await import('../server/dist/features/bots.js');
const { runAppControl, appControlTool } = await import('../server/dist/features/app-control.js');
const { saveAgentSettings, agentSettings } = await import('../server/dist/features/agent-settings.js');
const { saveChatProvider, subscriptionSelection } = await import('../server/dist/agent/subscriptions.js');
const { chatModelForBot, saveChatEffortDefault } = await import('../server/dist/agent/chat-model.js');

db.prepare('INSERT INTO users(id,email,name,created_at) VALUES (?,?,?,?)').run('u1', 'a@example.com', 'A', Date.now());
const bob = createBotRecord('u1', { name: 'Bob', label: 'Bot Builder' });
const ada = createBotRecord('u1', { name: 'Ada', avatarColor: 'violet' });
const bea = createBotRecord('u1', { name: 'Bea', avatarColor: 'blue' });
const ctx = { userId: 'u1', botId: bob.id };
// Shared provider default (used by builder/team/Ask runs too): Claude Opus on high.
db.prepare('INSERT INTO subscription_model_preferences(user_id,provider,model,effort) VALUES (?,?,?,?)').run('u1', 'claude', 'claude-opus-5-5', 'high');
saveChatProvider('u1', 'claude');
// (a) Ada: explicit chat model override with High effort.
db.prepare(`UPDATE bots SET chat_provider='claude', chat_model='claude-sonnet-5-5', chat_model_label='Claude Sonnet 5.5', chat_effort='high' WHERE id=?`).run(ada.id);
// (b) Bea inherits the model and, before the chat-only default exists, the shared provider default.
const row = id => db.prepare('SELECT * FROM bots WHERE id=?').get(id);
const nonEffort = id => { const { chat_effort, effort, updated_at, ...rest } = row(id); return rest; };
const nonChat = () => JSON.stringify({
  prefs: db.prepare('SELECT * FROM subscription_model_preferences ORDER BY provider').all(),
  provider: db.prepare('SELECT * FROM chat_provider_preferences').all(),
  settings: agentSettings('u1'),
});
const read = async (bot) => {
  const out = JSON.parse((await runAppControl(ctx, { action: 'get_chat_effort', ...(bot ? { bot } : {}) })).output);
  return bot ? out.bots[0] : out;
};
const listed = async name => JSON.parse((await runAppControl(ctx, { action: 'list_bots' })).output).find(b => b.name === name);

// Schema and docs name the actions and parameters.
assert.deepEqual(appControlTool.parameters.properties.action.enum.slice(-3), ['get_chat_effort', 'set_chat_effort', 'set_chat_default_effort']);
assert.ok(appControlTool.parameters.properties.effort.enum.includes('medium') && appControlTool.parameters.properties.provider.enum.includes('claude'));
assert.match(appControlTool.description, /set_chat_default_effort/);

assert.equal((await read('Bea')).chat_effort_source, 'provider_default', 'no chat-only default yet: Bea inherits the shared provider default');
saveChatEffortDefault('u1', 'claude', 'high');

// ---- read: both bots are on High, with the right source ----
const adaBefore = nonEffort(ada.id), beaBefore = nonEffort(bea.id), sharedBefore = nonChat();
for (const view of [await read('Ada'), await listed('Ada')]) {
  assert.equal(view.chat_effort, 'high');
  assert.equal(view.chat_effort_source, 'bot_override');
  assert.equal(view.chat_effort_inherited, false);
  assert.equal(view.chat_default_effort, 'high', 'callers can still inspect the chat-only default');
}
for (const view of [await read('Bea'), await listed('Bea')]) {
  assert.equal(view.chat_effort, 'high');
  assert.equal(view.chat_effort_source, 'chat_default');
  assert.equal(view.chat_effort_inherited, true);
  assert.equal(view.chat_default_effort, 'high');
}
const all = await read();
assert.equal(all.chat_default_provider, 'claude');
assert.equal(all.chat_default_efforts.claude, 'high');
assert.equal(all.bots.length, 3);

// ---- write: Ada's override High → Medium ----
assert.match((await runAppControl(ctx, { action: 'set_chat_effort', bot: 'Ada', effort: 'Medium' })).output, /Model unchanged/);
assert.equal((await read('Ada')).chat_effort, 'medium');
assert.equal((await read('Ada')).chat_effort_source, 'bot_override');
assert.deepEqual(nonEffort(ada.id), adaBefore, 'Ada keeps model and every non-effort column');
assert.equal(chatModelForBot(row(ada.id)).model, 'claude-sonnet-5-5');
assert.equal(chatModelForBot(row(ada.id)).effort, 'medium', 'the chat run uses the new effort');
assert.equal((await read('Bea')).chat_effort, 'high', 'Bea untouched by a per-bot change');
assert.equal(nonChat(), sharedBefore);

// ---- write: the chat-only default High → Medium ----
const out = (await runAppControl(ctx, { action: 'set_chat_default_effort', effort: 'medium' })).output;
assert.match(out, /claude is now medium/);
assert.match(out, /Bea/);
const bea2 = await read('Bea');
assert.equal(bea2.chat_effort, 'medium');
assert.equal(bea2.chat_effort_source, 'chat_default');
assert.equal(bea2.chat_default_effort, 'medium');
assert.deepEqual(chatModelForBot(row(bea.id)), { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium' }, 'Bea keeps the inherited model');
assert.deepEqual(nonEffort(bea.id), beaBefore);
assert.equal(row(bea.id).chat_effort, null, 'Bea gets no per-bot override');
assert.equal(nonChat(), sharedBefore, 'provider/builder defaults and the chat provider are unchanged');
assert.deepEqual(subscriptionSelection('u1', 'claude'), { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, 'builder/team/Ask default still High');
assert.equal((await read('Ada')).chat_effort, 'medium');
assert.deepEqual(nonEffort(ada.id), adaBefore);

// ---- edge cases ----
// Effort-only override on an inheriting bot, then clearing it with "default".
await runAppControl(ctx, { action: 'set_chat_effort', bot: 'Bea', effort: 'max' });
assert.deepEqual([(await read('Bea')).chat_effort, (await read('Bea')).chat_effort_source], ['max', 'bot_override']);
await runAppControl(ctx, { action: 'set_chat_effort', bot: 'Bea', effort: 'default' });
assert.deepEqual([(await read('Bea')).chat_effort, (await read('Bea')).chat_effort_source], ['medium', 'chat_default']);
assert.deepEqual(nonEffort(bea.id), beaBefore);
assert.match((await runAppControl(ctx, { action: 'set_chat_effort', bot: 'Ada', effort: 'default' })).output, /own chat model/);
assert.equal(row(ada.id).chat_effort, 'medium');
// Invalid values never write.
const snapshot = () => JSON.stringify([row(ada.id), row(bea.id), db.prepare('SELECT * FROM chat_effort_defaults').all(), nonChat()]);
const frozen = snapshot();
for (const effort of ['turbo', '', undefined, 7, 'HIGHEST']) {
  assert.match((await runAppControl(ctx, { action: 'set_chat_effort', bot: 'Ada', effort })).output, /isn't a reasoning effort/);
  assert.match((await runAppControl(ctx, { action: 'set_chat_default_effort', effort })).output, /isn't a reasoning effort/);
}
assert.match((await runAppControl(ctx, { action: 'set_chat_default_effort', effort: 'max', provider: 'local' })).output, /local chats support low, medium, high, xhigh/);
assert.match((await runAppControl(ctx, { action: 'set_chat_default_effort', effort: 'high', provider: 'openai' })).output, /Provider must be one of/);
assert.match((await runAppControl(ctx, { action: 'set_chat_effort', bot: 'Nobody', effort: 'low' })).output, /No bot matches "Nobody"/);
assert.match((await runAppControl(ctx, { action: 'set_chat_effort', effort: 'low' })).output, /Say which bot/);
assert.match((await runAppControl(ctx, { action: 'get_chat_effort', bot: 'Nobody' })).output, /No bot matches/);
assert.equal(snapshot(), frozen, 'rejected requests change nothing');
// Another provider's chat default is stored separately and does not affect Claude chats.
await runAppControl(ctx, { action: 'set_chat_default_effort', effort: 'low', provider: 'gemini' });
assert.equal((await read()).chat_default_efforts.gemini, 'low');
assert.equal((await read('Bea')).chat_effort, 'medium');

// ---- permission: "Bots can change Marion Agent" off blocks reads and writes ----
saveAgentSettings('u1', { appControl: false });
const locked = snapshot();
for (const args of [{ action: 'get_chat_effort' }, { action: 'set_chat_effort', bot: 'Ada', effort: 'low' }, { action: 'set_chat_default_effort', effort: 'low' }]) {
  assert.match((await runAppControl(ctx, args)).output, /turned off/);
}
assert.equal(snapshot(), locked, 'nothing changes while the setting is off');
console.log('chat-effort-app: all checks passed');
