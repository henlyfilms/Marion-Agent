import { db } from '../db.js';
import { getBotRow } from '../store.js';
import { TOKEN_OPTIMIZER_BODY, listUniversalSkills, universalSkillByName } from '../features/universal-skills.js';

/** Fallback wording only; the editable "Token optimizer" universal skill is the source of truth. */
export const tokenOptimizer = TOKEN_OPTIMIZER_BODY;

/** The user's current Token optimizer text (their edit), or nothing if they deleted the skill. */
export function tokenOptimizerFor(botId: string): string {
  const bot = getBotRow(botId);
  if (!bot) return '';
  listUniversalSkills(bot.user_id); // makes sure it was seeded
  const skill = universalSkillByName(bot.user_id, 'Token optimizer');
  return skill ? String(skill.body) : '';
}

const orchestration = 'When the user asks to create or run an orchestration, use Team tools. Discover model IDs with team_models and use team_setup to configure the chat when needed. Use team_delegate in parallel for independent work or in a chain for dependent work. Use team_discuss for decisions that need debate. Verify and combine the results. Use list_team and send_to_bot for existing Marion Bots.';

/** Characters of the prompt given to universal skills. The 3 shipped skills use about half; the rest is for custom ones. */
export const UNIVERSAL_BUDGET = 8000;
const LEARNED_BUDGET = 6000;

export function agentSkills(botId: string) {
  const bot = getBotRow(botId);
  const universal = bot ? listUniversalSkills(bot.user_id) : [];
  const shared = new Set(universal.map(s => s.name.toLowerCase()));
  const skills = (db.prepare('SELECT name, body FROM skills WHERE bot_id=? ORDER BY updated_at DESC, created_at DESC')
    .all(botId) as { name: string; body: string }[]).filter(s => !shared.has(s.name.replace(/\s+/g, ' ').trim().toLowerCase()));
  const fit = (list: { name: string; body: string }[], budget: number) => {
    const out: string[] = [];
    for (const skill of list) {
      if (budget <= 0) break;
      const section = `### ${skill.name}\n${skill.body}`.slice(0, budget);
      out.push(section);
      budget -= section.length;
    }
    return out;
  };
  const shown = fit(universal, UNIVERSAL_BUDGET);
  const learned = fit(skills, LEARNED_BUDGET);
  return [
    ...(shown.length ? ['## Universal skills (shared by every Bot on the team; edit them with save_skill)', ...shown] : []),
    '## Built-in skills',
    `- Orchestration: ${orchestration}`,
    ...(learned.length ? ['## Learned skills', ...learned] : []),
  ].join('\n');
}
