// Working animations: makes bots in many colours, marks them all as working (by rewriting /api/bots),
// and shoots the sidebar, header and collapsed rail at several moments of the loop.
// Usage: BROWSER_EXECUTABLE=... node tests/shot.mjs tests/out/workfx tests/shot-workfx.mjs
export default async function (page, shot) {
  await page.evaluate(async () => {
    for (const [name, color] of [['Grok', 'gray'], ['Scout', 'green'], ['Pixel', 'magenta'], ['Atlas', 'cyan'], ['Ember', 'red'], ['Nova', 'yellow'], ['Juno', 'black'], ['Pip', 'brown']]) {
      await fetch('/api/bots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, avatarColor: color }) });
    }
  });
  await page.route('**/api/bots', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch(); const body = await res.json();
    body.live = body.bots.map((b) => ({ botId: b.id, isRunning: true, startedAt: Date.now() - 4000, activity: { kind: 'working', since: Date.now() - 4000 } }));
    await route.fulfill({ response: res, json: body });
  });
  await page.reload();
  await page.waitForSelector('.work-fx', { state: 'attached' });
  await page.locator('.bot-list .bot-row').first().click();
  const report = await page.evaluate(() => [...document.querySelectorAll('.bot-row .work-fx')].map(el => el.className.replace('work-fx ', '') + ' ' + el.dataset.eyes));
  console.log('styles:', report.join(' | '));
  for (const t of [300, 900, 1500]) { await page.waitForTimeout(t === 300 ? 300 : 600); await shot(`side-${t}`, { x: 0, y: 0, width: 360, height: 860 }); }
  await shot('header', { x: 300, y: 0, width: 900, height: 120 });
  await page.keyboard.press('Meta+b'); await page.waitForTimeout(700);
  await shot('rail', { x: 0, y: 0, width: 120, height: 860 });
}
