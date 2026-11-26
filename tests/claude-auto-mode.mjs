// Claude Code must always launch with --permission-mode auto (never dontAsk). No model calls, no listener.
// Usage: npm run build && node tests/claude-auto-mode.mjs
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const S = await import('../server/dist/agent/subscriptions.js');

const modeOf = (args) => {
  const i = args.indexOf('--permission-mode');
  assert.ok(i >= 0, 'has --permission-mode');
  assert.equal(args.filter((a) => a === '--permission-mode').length, 1, 'exactly one --permission-mode');
  return args[i + 1];
};

assert.equal(S.CLAUDE_PERMISSION_MODE, 'auto');
assert.deepEqual(S.claudePermissionArgs(), ['--permission-mode', 'auto']);
assert.deepEqual(S.claudePermissionArgs('plan'), ['--permission-mode', 'plan'], 'explicit override still possible');
assert.equal(modeOf(S.claudeArgs), 'auto', 'default chat launch');
for (const write of [false, true]) {
  const args = S.folderArgs('claude', { path: '/tmp/shared', write });
  assert.equal(modeOf(args), 'auto', `shared-folder launch (write=${write})`);
  assert.ok(!args.includes('dontAsk'));
}
assert.ok(!S.claudeArgs.includes('dontAsk'));

// Every launch site in the source uses the helper, so none can fall back to dontAsk.
const { readFileSync, readdirSync } = await import('node:fs');
const dir = new URL('../server/src/agent/', import.meta.url);
for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts'))) {
  assert.ok(!/['"]dontAsk['"]/.test(readFileSync(new URL(f, dir), 'utf8')), `${f} must not launch Claude in dontAsk mode`);
}
console.log('PASS Claude Code launches in auto mode at every launch site');
