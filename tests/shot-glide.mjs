// Sidebar glide check: the selected highlight travels between rows when switching chats. Freezes the glide
// at several moments, screenshots the list, checks nothing is left behind after fast clicking, and in the
// collapsed sidebar. Usage: npm run build && BROWSER_EXECUTABLE=... node tests/shot.mjs <outDir> tests/shot-glide.mjs
export default async function (page, shot) {
  const row = (name) => page.locator(`.sidebar .bot-row:is([aria-label="${name}"], [aria-label="${name}, starred"]):visible`).first();
  const problems = [];
  const listClip = async () => { const b = await page.locator('.bot-list').boundingBox(); return { x: b.x, y: b.y - 4, width: b.width, height: Math.min(b.height + 8, 300) }; };
  async function frames(tag, from, to) {
    await row(from).click();
    await page.waitForTimeout(700);
    await row(to).click();
    await page.evaluate(() => document.getAnimations().forEach(a => a.pause()));
    const ys = [];
    for (const t of [0, 60, 120, 200, 380]) {
      const y = await page.evaluate((t) => {
        document.getAnimations().forEach(a => { a.currentTime = t; });
        const g = document.querySelector('.bot-list__glider');
        return g ? Math.round(g.getBoundingClientRect().top) : null;
      }, t);
      ys.push(y);
      await shot(`glide-${tag}-${t}`, await listClip());
    }
    await page.evaluate(() => document.getAnimations().forEach(a => a.play()));
    await page.waitForTimeout(700);
    const left = await page.evaluate(() => ({ glider: !!document.querySelector('.bot-list__glider'), gliding: !!document.querySelector('.bot-list.is-gliding') }));
    console.log(`${tag}: ${from} -> ${to} glider top over time`, ys.join(' → '), JSON.stringify(left));
    if (ys[0] === null || ys[0] === ys[3]) problems.push(`${tag}: glider did not move`);
    if (left.glider || left.gliding) problems.push(`${tag}: leftovers`);
  }
  await frames('down', 'Bot Builder', 'Barry');
  await frames('up', 'Barry', 'Bot Builder');
  for (const n of ['Moose', 'Barry', 'Bot Builder', 'Moose']) { await row(n).click(); await page.waitForTimeout(60); }
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => ({ gliders: document.querySelectorAll('.bot-list__glider').length, gliding: !!document.querySelector('.bot-list.is-gliding'),
    selected: document.querySelector('.bot-list .bot-row.is-selected')?.getAttribute('aria-label')?.replace(/, starred$/, ''),
    bg: getComputedStyle(document.querySelector('.bot-list .bot-row.is-selected')).backgroundColor }));
  console.log('after fast clicking', JSON.stringify(after));
  if (after.gliders || after.gliding || after.selected !== 'Moose') problems.push('fast: ' + JSON.stringify(after));
  await shot('glide-final', await listClip());
  await page.keyboard.press('Meta+b');
  await page.waitForTimeout(600);
  await frames('rail', 'Moose', 'Bot Builder');
  await page.keyboard.press('Meta+b');
  console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'glide OK');
}
