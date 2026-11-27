// Default model & effort per builder provider (Settings → Models): pure resolution rules, plus source checks that the
// Settings section lists Claude, Codex and Gemini and that ask_subscription and orchestrate fall back to those defaults.
// Usage: node --import tsx tests/builder-defaults.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const D = await import('../server/src/agent/provider-defaults.ts');
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const efforts = ['low', 'medium', 'high'];
const models = [
  { provider: 'claude', id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts, defaultEffort: 'high' },
  { provider: 'claude', id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', efforts, defaultEffort: 'high' },
  { provider: 'codex', id: 'gpt-6.2-sol', label: 'GPT-6.2-Sol', efforts: [...efforts, 'xhigh'], defaultEffort: 'high' },
  { provider: 'codex', id: 'gpt-6.2-astra', label: 'GPT-6.2-Astra', efforts, defaultEffort: 'high' },
  { provider: 'gemini', id: 'gemini-4-neon', label: 'Gemini 4 Neon', efforts, defaultEffort: 'high' },
  { provider: 'gemini', id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium'], defaultEffort: 'medium' },
];
const saved = { claude: { model: 'claude-sonnet-5-5', effort: 'low' }, codex: { model: 'gpt-6.2-astra', effort: 'medium' }, gemini: { model: 'gemini-4-neon', effort: 'low' } };

// Nothing named: the provider's Settings default.
for (const provider of ['claude', 'codex', 'gemini']) {
  const run = D.resolveRunSelection(provider, models, saved[provider]);
  assert.equal(run.model, saved[provider].model, `${provider} default model`);
  assert.equal(run.effort, saved[provider].effort, `${provider} default effort`);
}
// A bare provider name counts as "nothing named".
assert.equal(D.resolveRunSelection('claude', models, saved.claude, { model: 'claude' }).model, 'claude-sonnet-5-5');
// Model named, effort not: the named model with the default effort (when that model offers it).
assert.deepEqual(D.resolveRunSelection('claude', models, saved.claude, { model: 'opus' }), { provider: 'claude', model: 'claude-opus-5-5', effort: 'low', label: 'Claude Opus 5.5' });
assert.equal(D.resolveRunSelection('codex', models, saved.codex, { model: '6.2 Sol' }).model, 'gpt-6.2-sol');
// Default effort the named model lacks → that model's own default.
assert.equal(D.resolveRunSelection('gemini', models, { model: 'gemini-4-neon', effort: 'high' }, { model: 'flash' }).effort, 'medium');
// Effort named, model not: default model with the named effort.
assert.deepEqual(D.resolveRunSelection('codex', models, saved.codex, { effort: 'HIGH' }), { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high', label: 'GPT-6.2-Astra' });
// Both named.
assert.equal(D.resolveRunSelection('codex', models, saved.codex, { model: 'gpt-6.2-sol', effort: 'xhigh' }).effort, 'xhigh');
// Bad names fail clearly instead of silently running something else.
assert.throws(() => D.resolveRunSelection('claude', models, saved.claude, { model: 'haiku 9' }), /No Claude model matches "haiku 9"/);
assert.throws(() => D.resolveRunSelection('gemini', models, saved.gemini, { model: 'flash', effort: 'high' }), /supports low, medium effort/);
// Catalog unavailable: names pass through, defaults still apply.
assert.deepEqual(D.resolveRunSelection('gemini', [], saved.gemini), { provider: 'gemini', model: 'gemini-4-neon', effort: 'low' });
assert.equal(D.resolveRunSelection('gemini', [], saved.gemini, { model: 'gemini-x' }).model, 'gemini-x');

// Team (orchestrate): bare provider → Settings default model; any model → the provider's default effort when offered.
assert.equal(D.pickModel(models, 'claude', saved).id, 'claude-sonnet-5-5');
assert.equal(D.pickModel(models, 'gpt', saved).id, 'gpt-6.2-astra');
assert.equal(D.pickModel(models, 'gemini 3.8 flash', saved).id, 'gemini-3.8-flash');
assert.equal(D.pickModel(models, 'claude', {}).id, 'claude-opus-5-5', 'no saved default: catalog default');
assert.equal(D.defaultEffortFor(models[0], saved.claude), 'low');
assert.equal(D.defaultEffortFor(models[0], undefined), 'high');
assert.equal(D.defaultEffortFor({ ...models[0], efforts: [] }, saved.claude), null);

// ---------- wiring ----------
const tools = read('server/src/agent/tools.ts');
assert.match(tools, /model: \{ type: 'string', description: 'Optional: only when the owner names a model/, 'ask_subscription takes an optional model');
assert.match(tools, /effort: \{ type: 'string', description: 'Optional: only when the owner names an effort level/, 'ask_subscription takes an optional effort');
assert.match(tools, /resolveRunSelection\(provider, /, 'ask_subscription resolves named model/effort against Settings defaults');
const orchestrate = read('server/src/agent/orchestrate.ts');
assert.match(orchestrate, /pickModel\(models, String\(args\?\.orchestrator/, 'orchestrator uses Settings defaults');
assert.match(orchestrate, /pickModel\(models, name, defaults\)/, 'workers use Settings defaults');
assert.match(orchestrate, /defaultEffortFor\(model, defaults\[model\.provider\]\)/, 'every agent gets its provider default effort');
const settings = read('web/src/components/config/LocalSettings.tsx');
assert.match(settings, /export function ProviderDefaultsSettings/);
for (const name of ['Claude', 'Codex', 'Gemini']) assert.match(settings, new RegExp(`name: '${name}'`), `${name} row`);
assert.match(settings, /default model`/);
assert.match(settings, /default effort`/);
assert.match(read('web/src/components/config/AppSettings.tsx'), /<ProviderDefaultsSettings \/>/, 'shown on the Models page');
assert.match(read('web/src/styles/config.css'), /\.provider-defaults__row \{/);

console.log('PASS: per-provider default model & effort resolve from Settings unless a request names its own; ask, orchestrate and Settings are wired.');
