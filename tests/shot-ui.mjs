// Extra steps for tests/shot.mjs: icon centering, collapsed sidebar, side panel, settings, work card.
export default async function (page, shot, app) {
  // Every icon button: is the glyph centered in its button (within 0.75px)?
  const off = await page.evaluate(() => {
    const out = [];
    for (const button of document.querySelectorAll('button.icon-btn, .sidebar-toggle, .details__gear, .composer__btn, .composer__cta')) {
      const glyph = button.querySelector('svg, img');
      if (!glyph || !button.getClientRects().length) continue;
      const b = button.getBoundingClientRect();
      // Measure the drawn shape, not the viewBox: use getBBox on the svg's children.
      let g = glyph.getBoundingClientRect();
      if (glyph.tagName === 'svg' && glyph.getBBox) {
        const box = glyph.getBBox();
        const vb = glyph.viewBox?.baseVal;
        if (vb && vb.width) {
          const sx = g.width / vb.width, sy = g.height / vb.height;
          g = { left: g.left + (box.x - vb.x) * sx, top: g.top + (box.y - vb.y) * sy, width: box.width * sx, height: box.height * sy };
        }
      }
      const dx = (g.left + g.width / 2) - (b.left + b.width / 2);
      const dy = (g.top + g.height / 2) - (b.top + b.height / 2);
      if (Math.abs(dx) > 0.75 || Math.abs(dy) > 0.75) out.push(`${button.getAttribute('aria-label') || button.className}: dx ${dx.toFixed(2)} dy ${dy.toFixed(2)}`);
    }
    return out;
  });
  console.log('OFF-CENTER', JSON.stringify(off, null, 1));
  await shot('top-left', { x: 0, y: 0, width: 520, height: 160 });
  await shot('top-right', { x: 1000, y: 0, width: 320, height: 120 });
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(600);
  await shot('collapsed');
  await shot('collapsed-top', { x: 0, y: 0, width: 220, height: 200 });
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(600);
  // Share menu and side panel toggle.
  await page.locator('.conversation-actions [aria-label="Share"]').click();
  await page.waitForTimeout(300);
  await shot('share-menu', { x: 900, y: 0, width: 420, height: 200 });
  await page.keyboard.press('Escape');
  await page.locator('.details-toggle').click();
  await page.waitForTimeout(700);
  await shot('details-closed');
  await page.locator('.details-toggle').click();
  await page.waitForTimeout(700);
  // Switch bots (animation midpoint and end).
  await page.locator('.bot-list .bot-row').nth(1).click();
  await page.waitForTimeout(150);
  await shot('switch-mid');
  await page.waitForTimeout(600);
  // Fake a long conversation + a work card to see the floating composer and the card.
  const botId = await page.evaluate(() => document.querySelector('.bot-row.is-selected')?.closest('[data-chat-id]')?.getAttribute('data-chat-id'));
  const { execFileSync } = await import('node:child_process');
  console.log(execFileSync(process.execPath, [decodeURIComponent(new URL('./shot-seed.mjs', import.meta.url).pathname), botId], { env: process.env }).toString());
  await page.reload();
  await page.waitForSelector('.work-card');
  await page.waitForTimeout(800);
  await shot('work-cards');
  await page.locator('.transcript').evaluate(el => el.scrollTo(0, el.scrollHeight - el.clientHeight - 500));
  await page.waitForTimeout(300);
  await shot('scrolled-behind');
  await page.locator('.details__gear').click();
  await page.waitForTimeout(500);
  await page.locator('.bot-settings .cfg-nav__item', { hasText: 'Access' }).click();
  await page.waitForTimeout(400);
  await shot('access');
  await page.locator('.full-access [role="switch"]').click();
  await page.waitForTimeout(400);
  await shot('access-confirm');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.keyboard.press('Meta+,');
  await page.waitForTimeout(600);
  await page.locator('.sheet-row', { hasText: 'General' }).click();
  await page.waitForTimeout(500);
  await page.locator('.theme-tile', { hasText: 'Custom' }).click().catch(() => {});
  await page.waitForTimeout(500);
  await shot('settings-general');
  await page.locator('.app-settings .sheet-scroll, .app-settings [class*="scroll"]').first().evaluate(el => el.scrollBy(0, 700)).catch(() => {});
  await page.waitForTimeout(300);
  await shot('settings-general-2');
}
