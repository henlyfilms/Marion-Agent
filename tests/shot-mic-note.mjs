// "No speech heard" must never move the model, effort and Team buttons (owner, Nov 25: "it moves the UI up").
// Shows the dictation note with the longest text it can hold and checks nothing in the model row moves.
// Usage: npm run build && BROWSER_EXECUTABLE=... node tests/shot.mjs <outDir> tests/shot-mic-note.mjs
export default async function (page, shot) {
  for (const width of [1320, 900, 390]) {
    await page.setViewportSize({ width, height: 860 });
    await page.waitForTimeout(400);
    if (width <= 700 && !(await page.locator('.composer__models').isVisible())) await page.locator('.bot-list .bot-row').first().click();
    const where = () => page.evaluate(() => [...document.querySelectorAll('.composer__models > :not(.mic-note), .composer')]
      .map(e => Math.round(e.getBoundingClientRect().top * 10) / 10));
    const before = await where();
    await page.evaluate(() => {
      const note = document.querySelector('.mic-note');
      note.classList.add('is-error');
      note.querySelector('.mic-note__text').textContent = 'No speech heard';
      note.dataset.visible = 'true';
    });
    await page.waitForTimeout(500);
    const after = await where();
    await shot(`mic-note-${width}`);
    const moved = before.some((y, i) => y !== after[i]);
    console.log(`${width}px: ${moved ? `MOVED ${before} -> ${after}` : 'nothing moved'}`);
    await page.evaluate(() => { document.querySelector('.mic-note').dataset.visible = 'false'; });
  }
}
