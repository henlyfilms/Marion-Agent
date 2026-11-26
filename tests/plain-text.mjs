// Notifications show plain text: Markdown symbols are stripped (server/src/lib/plainText.ts).
// Usage: npm run build && node tests/plain-text.mjs
import assert from 'node:assert/strict';
import { plainLine, stripMarkdown } from '../server/dist/lib/plainText.js';

const cases = [
  ['**Done** with __the task__', 'Done with the task'],
  ['Used *italic* and _also italic_ here', 'Used italic and also italic here'],
  ['Keep snake_case_names and 2*3*4 maths', 'Keep snake_case_names and 2*3*4 maths'],
  ['Run `npm test` now', 'Run npm test now'],
  ['```js\nconst a = 1;\n```', 'const a = 1;'],
  ['# Heading one\n## Heading two ##', 'Heading one\nHeading two'],
  ['See [the report](https://example.com/a_b) and ![chart](x.png)', 'See the report and chart'],
  ['> quoted\n> > nested', 'quoted\nnested'],
  ['- one\n* two\n- [x] three', '• one\n• two\n• three'],
  ['~~old~~ new', 'old new'],
  ['Escaped \\*star\\* and \\_under\\_', 'Escaped *star* and _under_'],
  ['<https://example.com>', 'https://example.com'],
  ['***bold italic***', 'bold italic'],
  ['---\ntext\n***', 'text'],
];
for (const [input, expected] of cases) assert.equal(stripMarkdown(input), expected, JSON.stringify(input));
assert.equal(plainLine('**Finished:**\n\n- `a`\n- [b](http://x)'), 'Finished: • a • b');
assert.equal(stripMarkdown(''), '');
console.log(`PASS: ${cases.length + 2} Markdown-to-plain-text cases.`);
