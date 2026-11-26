// macOS privacy blocks are recognised and described as "what it was doing" + "what macOS blocked".
// Usage: npm run build && node tests/mac-permissions.mjs
import assert from 'node:assert/strict';
import { describeMacBlock, macBlock, MacPermissionError, rethrowIfMacBlocked } from '../server/dist/lib/macPermissions.js';

if (process.platform !== 'darwin') {
  console.log('SKIP: macOS permission detection only runs on a Mac.');
} else {
  const cases = [
    ['execution error: Not authorized to send Apple events to System Events. (-1743)', /Automation/],
    ['osascript is not allowed assistive access. (-25211)', /Accessibility/],
    ['System Events got an error: osascript is not allowed to send keystrokes. (1002)', /Accessibility/],
    ['could not create image from display', /Screen Recording/],
    ['Speech recognition not authorized', /Speech Recognition/],
    ['EPERM: operation not permitted, scandir \'/Users/x/Desktop\'', /protected folder/],
  ];
  for (const [text, expected] of cases) {
    const block = macBlock(new Error(text), 'Do the thing');
    assert.ok(block, text);
    assert.match(block.blocked, expected, text);
    assert.equal(block.doing, 'Do the thing');
  }
  assert.equal(macBlock(new Error('Something else broke'), 'Do the thing'), undefined);
  assert.equal(macBlock({ stderr: 'Not authorized to send Apple events (-1743)', message: 'Command failed' }, 'x')?.blocked.includes('Automation'), true, 'stderr is read');
  const text = describeMacBlock(macBlock(new Error('-1743'), 'Choose a folder'));
  assert.match(text, /trying to: Choose a folder/);
  assert.match(text, /macOS blocked the Automation permission/);
  assert.throws(() => rethrowIfMacBlocked(new Error('-1743'), 'x'), MacPermissionError);
  assert.doesNotThrow(() => rethrowIfMacBlocked(new Error('User canceled. (-128)'), 'x'));
  console.log(`PASS: ${cases.length + 6} macOS permission cases.`);
}
