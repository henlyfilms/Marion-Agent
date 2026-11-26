// Right-click a message → Copy message: no focus ring on the menu, no error toast, text on the clipboard.
export default async (page, shot) => {
  const box = page.locator('textarea, [contenteditable="true"]').first();
  await box.click();
  await box.fill('Copy me please 123');
  await page.keyboard.press('Enter');
  const bubble = page.locator('.bubble', { hasText: 'Copy me please 123' }).first();
  await bubble.waitFor();
  await page.waitForTimeout(400);
  // Run 1: clipboard API refused (like the Mac app before the fix) — the fallback must still copy.
  await page.evaluate(() => {
    window.__copied = null;
    navigator.clipboard.writeText = () => Promise.reject(new DOMException('Write permission denied.', 'NotAllowedError'));
    const exec = document.execCommand.bind(document);
    document.execCommand = (cmd, ...rest) => { if (cmd === 'copy') window.__copied = document.activeElement?.value ?? null; return exec(cmd, ...rest); };
  });
  const b = await bubble.boundingBox();
  await page.mouse.click(b.x + 30, b.y + b.height / 2, { button: 'right' });
  await page.waitForSelector('.context-menu');
  const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle + ' ' + getComputedStyle(document.activeElement).outlineWidth);
  console.log('menu item outline:', outline);
  await shot('copy-menu', { x: Math.max(0, b.x - 40), y: Math.max(0, b.y - 40), width: 520, height: 180 });
  await page.locator('.context-menu [role="menuitem"]', { hasText: 'Copy message' }).click();
  await page.waitForTimeout(300);
  console.log('error toast:', await page.locator('.context-menu-error').count());
  console.log('copied via fallback:', JSON.stringify(await page.evaluate(() => window.__copied)));
  const bubbleOutline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  console.log('bubble outline after copy:', bubbleOutline);
  await shot('copy-after', { x: Math.max(0, b.x - 40), y: Math.max(0, b.y - 40), width: 520, height: 180 });
};
