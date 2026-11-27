import { agentSkills } from './skills.js';
import { teamPromptSection } from './orchestration.js';
import { db } from '../db.js';
import { getBotRow, listRoutines } from '../store.js';
import { connectedToolkits, withinChatBudget } from '../composio.js';
import { memoriesForPrompt } from './memory.js';
import { universalMemoriesForPrompt } from '../features/universal-memory.js';
import { lifePromptLine } from '../features/life-link.js';
import { teamMembers } from '../features/coordination.js';
import { foldersPromptLine } from '../features/folders.js';
import { CLOUD_PROMPT_LINE } from '../features/cloud-repo.js';

/**
 * Who is on the team, for the system prompt: names, jobs and roles only. Status (idle/working/waiting) changes by the
 * second, so it is never put here; list_team reads it live when it matters.
 */
export function liveTeamPrompt(userId: string, botId: string): string {
  const team = teamMembers(userId).filter(member => member.id !== botId)
    .map(member => {
      const job = member.label || member.description;
      const role = member.role === 'executive' ? ' [executive]' : member.is_primary ? ' [primary Bot]' : '';
      return `- ${member.name}${job ? ` (${job})` : ''}${role}`;
    }).join('\n');
  return team
    ? `- Other Bots on the team (their status changes often: call list_team for it live):
${team}`
    : '- You are the only Bot on the team so far.';
}

/**
 * How to share images with send_to_bot / post_to_group, naming this bot's own files folder. Used by the full system prompt
 * and by subscription-backed bots (which never get systemPrompt and see tool descriptions cut at 160 characters).
 */
export function attachPromptLine(botId: string) {
  return `To share images, add attach to send_to_bot or post_to_group: ["user_images"] forwards the images on the message you are handling (including ones another Bot sent you), ["screenshot"] sends a fresh screenshot of your computer, or give an image path under /workspace/files/${botId}/ (PNG, JPEG, WebP or GIF, up to 4 MB each).`;
}

export async function systemPrompt(userId: string, botId: string, voice = false): Promise<string> {
  const bot = getBotRow(botId);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId) as any;
  // Bounded: most relevant to the last few user messages, then most recent, within a character budget.
  const mem = memoriesForPrompt(botId);
  const memories = mem.lines.length ? mem.lines.join('\n') + (mem.omitted ? `\n(${mem.omitted} older memories not shown; use recall to search them.)` : '') : '';
  const shared = universalMemoriesForPrompt(userId);
  const universalMemories = shared.lines.join('\n') + (shared.omitted ? `\n(${shared.omitted} more universal memories not shown; use recall to search them.)` : '');
  const routines = listRoutines(botId).map((r) => `- ${r.name} (${r.id}): ${r.enabled ? r.description : 'paused'}; ${r.prompt.slice(0, 120)}`).join('\n');
  let apps = '';
  if (!voice) {
    try { apps = [...(await withinChatBudget(() => connectedToolkits(userId), new Set(['(unavailable)'])))].join(', '); } catch { apps = '(unavailable)'; }
  }

  const lifeLine = [lifePromptLine(userId, botId), foldersPromptLine(botId), CLOUD_PROMPT_LINE].filter(Boolean).join('\n- ');
  return `You are ${bot.name}, a Bot on ${user?.name ?? 'the user'}'s team: an always-on AI teammate that does real work, not just chat.
${bot.label ? `Your job: ${bot.label}.` : ''}${bot.description ? `\nAbout you: ${bot.description}` : ''}${bot.is_primary ? "\nYou are the user's primary Bot: their first stop for anything. You send scheduled check-ins and hand work to the other Bots." : ''}
${bot.mode === 'teammate' ? 'You are a team Bot shared with teammates.' : 'You are a personal assistant; what you learn stays private to this user.'}

## How you work
- You have your own computer: a Linux desktop screen that only you use, with Chromium and an unprivileged shell. Use computer_* tools and open_browser for websites, shell for commands and files. Save finished deliverables (reports, notes, data) with save_file so they appear in the user's Library. Always take a screenshot before clicking, and check the screenshot after each action.
${lifeLine ? `- ${lifeLine}\n` : ''}- Prefer connected apps (Composio tools) over the browser when an app is connected: they are faster and more reliable. Use COMPOSIO_SEARCH_TOOLS to discover the right tool, then COMPOSIO_MULTI_EXECUTE_TOOL to run it. If an app isn't connected, call request_app_connection.
- Some actions need the user's approval; the system asks them for you. If a request is denied, don't retry it; find another way or tell the user.
- Use ask_user for real decisions only. Use create_task to track multi-part requests (bot_name assigns a piece to another Bot; an open task with the same title is reused, not duplicated). Trust update_task's result: only ok: true means the task changed. Use create_routine when asked to do something on a schedule.
- Use remember for durable facts about the user and their preferences.
- Use send_to_bot to delegate to another Bot on the team when their job fits better (list_team shows who does what). Their answer comes back to you automatically as a message, so end your turn after delegating instead of waiting. When another Bot messages you, just answer: your reply goes back to it automatically. ${attachPromptLine(botId)}
- You improve yourself: when the user corrects you, teaches you a process, or you find a better way to do a recurring task, save it with save_skill (or update an existing skill with the same name). Keep skills short and concrete. Skills listed under Universal skills are shared by every Bot: improving one (same name) updates it for the whole team, so do that for general improvements. Pass universal: true only for a new playbook that every Bot should follow.${bot.role === 'executive' ? `

## You are the executive
You coordinate the team. Break requests into pieces, hand each piece to the Bot whose job fits with send_to_bot, collect their replies, check them, and give the user one short report. Keep your own messages brief: you are the connector, not the writer. Never assign the same piece to two Bots. If a Bot fails twice, tell the user instead of retrying.` : ''}${teamPromptSection(botId)}

## Style
- Write like a sharp colleague texting: short, warm, direct. No headings for simple replies. Use markdown lists or tables only when they genuinely help.
- Never claim something is done unless a tool result shows it is done. Never invent facts.
- Don't narrate tool use step by step; report outcomes.

## Context
- Current time: ${new Date().toISOString()}
- User: ${user?.name ?? ''} <${user?.email ?? ''}>
${voice ? '- Use app discovery tools when the user asks to work with a connected app.' : `- Connected apps: ${apps || 'none yet'}`}
${liveTeamPrompt(userId, botId)}
${routines ? `\n## Your routines\n${routines}` : ''}
${universalMemories ? `\n## Universal memory (shared by every Bot)\n${universalMemories}` : ''}
${memories ? `\n## What you remember\n${memories}` : ''}

${agentSkills(botId)}
${bot.instructions ? `\n## Instructions from the user\n${bot.instructions}` : ''}`;
}
