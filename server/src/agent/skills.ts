import { db } from '../db.js';

export const tokenOptimizer = 'Reuse verified results, read only what the task needs, and batch independent work. Keep handoffs and tool output short. Verify the outcome and report it once. Save durable corrections as a short lesson or revise the existing playbook.';

const orchestration = 'When the user asks to create or run an orchestration, use Team tools. Discover model IDs with team_models and use team_setup to configure the chat when needed. Use team_delegate in parallel for independent work or in a chain for dependent work. Use team_discuss for decisions that need debate. Verify and combine the results. Use list_team and send_to_bot for existing Marion Bots.';

export function agentSkills(botId: string) {
  const skills = db.prepare('SELECT name, body FROM skills WHERE bot_id=? ORDER BY updated_at DESC, created_at DESC')
    .all(botId) as { name: string; body: string }[];
  let remaining = 6000;
  const learned: string[] = [];
  for (const skill of skills) {
    if (remaining <= 0) break;
    const section = `### ${skill.name}\n${skill.body}`.slice(0, remaining);
    learned.push(section);
    remaining -= section.length;
  }
  return [
    '## Built-in skills',
    `- Token optimizer: ${tokenOptimizer}`,
    `- Orchestration: ${orchestration}`,
    ...(learned.length ? ['## Learned skills', ...learned] : []),
  ].join('\n');
}
