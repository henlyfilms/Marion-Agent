// Bot switch check: freezes the switch at several moments and screenshots the pill, checks the name is
// never cut to "…" mid-morph, and measures real frame gaps while switching back and forth.
// Usage: npm run build && BROWSER_EXECUTABLE=... node tests/shot.mjs <outDir> tests/shot-switch.mjs
export default async function (page, shot) {
  const row = (name) => page.locator(`.sidebar .bot-row[aria-label="${name}"]:visible`).first();
  const clip = async () => {
    const b = await page.locator('.chat__header').boundingBox();
    return { x: b.x + b.width / 2 - 160, y: b.y, width: 320, height: b.height };
  };
  const problems = [];
  for (const [from, to] of [['Moose', 'Bot Builder'], ['Bot Builder', 'Moose']]) {
    await row(from).click();
    await page.waitForTimeout(900);
    await row(to).click();
    await page.evaluate(() => document.getAnimations().forEach(a => a.pause()));
    for (const t of [0, 80, 160, 260, 380, 520]) {
      const info = await page.evaluate((t) => {
        document.getAnimations().forEach(a => { a.currentTime = t; });
        const name = document.querySelector('.chat__header .chat__pill > .chat__pill-name');
        const pill = name.parentElement;
        const cs = getComputedStyle(name);
        const cut = cs.textOverflow === 'ellipsis' && name.scrollWidth > name.clientWidth + 1;
        return { cut, pillW: Math.round(pill.getBoundingClientRect().width), ghosts: pill.querySelectorAll('.chat__pill-ghost').length };
      }, t);
      if (info.cut) problems.push(`${from}->${to} @${t}ms name shows …`);
      await shot(`switch-${to.replace(' ', '')}-${t}`, await clip());
      console.log(`${from} -> ${to} @${t}ms`, JSON.stringify(info));
    }
    await page.evaluate(() => document.getAnimations().forEach(a => a.play()));
    await page.waitForTimeout(800);
    const left = await page.evaluate(() => ({ ghosts: document.querySelectorAll('.chat__pill-ghost').length, morphing: !!document.querySelector('.chat__pill.is-morphing') }));
    if (left.ghosts || left.morphing) problems.push(`${to}: leftovers ${JSON.stringify(left)}`);
  }
  // Rapid switching should not leave ghosts or a stuck pill.
  for (const n of ['Barry', 'Moose', 'Bot Builder', 'Barry', 'Bot Builder']) { await row(n).click(); await page.waitForTimeout(70); }
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => {
    const pill = document.querySelector('.chat__header .chat__pill');
    const name = pill.querySelector('.chat__pill-name');
    return { ghosts: pill.querySelectorAll('.chat__pill-ghost').length, morphing: pill.classList.contains('is-morphing'), name: name.textContent, fits: name.scrollWidth <= name.clientWidth + 1 };
  });
  console.log('after rapid switching', JSON.stringify(after));
  if (after.ghosts || after.morphing || !after.fits || after.name !== 'Bot Builder') problems.push('rapid: ' + JSON.stringify(after));
  await shot('switch-final', await clip());
  // Frame gaps across real switches.
  const worst = [];
  for (const n of ['Moose', 'Bot Builder', 'Barry', 'Bot Builder']) {
    await page.evaluate(() => { window.__f = []; let l = performance.now(); const k = (t) => { window.__f.push(t - l); l = t; if (window.__f.length < 60) requestAnimationFrame(k); }; requestAnimationFrame(k); });
    await row(n).click();
    await page.waitForTimeout(700);
    worst.push(await page.evaluate(() => Math.round(Math.max(...window.__f.slice(2)))));
  }
  console.log('worst frame gap per switch (ms):', worst.join(', '));
  console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'switch OK');
}
