// Seeds a long conversation and work cards into a bot (used by shot-ui.mjs). Args: botId
process.env.DB_PATH = process.env.SHOT_DB;
const { appendRow } = await import('../server/dist/store.js');
const botId = process.argv[2];
const t = Date.now();
for (let i = 0; i < 8; i++) {
  appendRow(botId, 'message', { type: 'message', role: 'user', text: `Message ${i + 1}: can you check how the project is going and keep me posted on the next steps?` });
  appendRow(botId, 'message', { type: 'message', role: 'assistant', text: `Reply ${i + 1}. Here is a longer answer so the conversation fills the screen and scrolls behind the floating composer and the bot pill at the top. Everything looks good so far.` });
}
appendRow(botId, 'message', { type: 'message', role: 'user', text: 'Fix the login bug. Use 6.2 Astra as the orchestrator and run two Gemini 4 Neon subagents.' });
appendRow(botId, 'card', { type: 'card', card: 'work', title: 'Fix the login bug in Marion Life', reporter: 'Barry', live: true, status: 'running', startedAt: t - 154_000,
  agents: [
    { id: 'orchestrator-0', label: 'GPT-6.2 Astra', provider: 'codex', model: 'gpt-6.2-astra', role: 'orchestrator' },
    { id: 'worker-0', label: 'Gemini 4 Neon', provider: 'gemini', model: 'gemini-4-neon', role: 'worker' },
    { id: 'worker-1', label: 'Gemini 4 Neon 2', provider: 'gemini', model: 'gemini-4-neon', role: 'worker' },
  ],
  phases: [{ title: 'Find the cause', status: 'done' }, { title: 'Fix and test', status: 'running' }, { title: 'Review', status: 'pending' }],
  steps: [
    { at: t - 150_000, agent: 'GPT-6.2 Astra', kind: 'note', text: 'Planned 3 phases' },
    { at: t - 120_000, agent: 'Gemini 4 Neon', kind: 'search', text: 'Searched loginWithPassword' },
    { at: t - 100_000, agent: 'Gemini 4 Neon 2', kind: 'read', text: 'Read src/auth/session.ts' },
    { at: t - 80_000, agent: 'GPT-6.2 Astra', kind: 'approve', text: 'Approved Find the cause: the session cookie expires before refresh' },
    { at: t - 40_000, agent: 'Gemini 4 Neon', kind: 'edit', text: 'Edited auth/session.ts' },
    { at: t - 6_000, agent: 'Gemini 4 Neon', kind: 'command', text: 'Ran npm test -- auth' },
  ] });
appendRow(botId, 'card', { type: 'card', card: 'work', title: 'Summarize the README', reporter: 'Barry', live: true, status: 'done', startedAt: t - 64_000, endedAt: t - 20_000,
  agents: [{ id: 'worker-0', label: 'Claude Opus 5.5', provider: 'claude', model: 'claude-opus-5-5', role: 'worker' }], phases: [],
  steps: [{ at: t - 60_000, agent: 'Claude Opus 5.5', kind: 'read', text: 'Read README.md' }, { at: t - 30_000, agent: 'Claude Opus 5.5', kind: 'note', text: 'The README covers setup, models and voice.' }] });
console.log('seeded');
