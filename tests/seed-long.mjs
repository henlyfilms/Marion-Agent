// Seeds a very long conversation (args: botId count) for the transcript paging check in shot-long.mjs.
process.env.DB_PATH = process.env.SHOT_DB;
const { appendRow } = await import('../server/dist/store.js');
const [botId, count = '400'] = process.argv.slice(2);
for (let i = 0; i < Number(count); i++) {
  appendRow(botId, 'message', { type: 'message', role: i % 2 ? 'assistant' : 'user', text: `Long ${i + 1}: ${'words here '.repeat(8 + (i % 7))}` });
}
console.log('seeded long');
