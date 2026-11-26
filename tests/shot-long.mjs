// Long chat check: switching into a 400-message chat stays smooth, draws only the newest part, and
// scrolling up loads older messages without jumping. Usage: node tests/shot.mjs <out> tests/shot-long.mjs
import { execFileSync } from 'node:child_process';
export default async function (page, shot) {
  const bots = await page.evaluate(async () => (await (await fetch('/api/bots')).json()).bots);
  const moose = bots.find(b => b.name === 'Moose');
  execFileSync(process.execPath, [decodeURIComponent(new URL('./seed-long.mjs', import.meta.url).pathname), moose.id, '400'], { env: process.env, stdio: 'inherit' });
  await page.reload();
  await page.waitForSelector('.sidebar');
  const row = (name) => page.locator(`.sidebar .bot-row[aria-label="${name}"]:visible`).first();
  const gaps = [];
  for (const n of ['Moose', 'Bot Builder', 'Moose', 'Barry', 'Moose']) {
    await page.evaluate(() => { window.__f = []; let l = performance.now(); const k = (t) => { window.__f.push(t - l); l = t; if (window.__f.length < 50) requestAnimationFrame(k); }; requestAnimationFrame(k); });
    await row(n).click();
    await page.waitForTimeout(900);
    gaps.push(await page.evaluate(() => Math.round(Math.max(...window.__f.slice(1)))));
  }
  const drawn = () => page.evaluate(() => document.querySelectorAll('.transcript .bubble, .transcript [class*="bubble"]').length);
  const atBottom = await page.evaluate(() => { const t = document.querySelector('.transcript'); return t.scrollHeight - t.scrollTop - t.clientHeight < 5; });
  const before = await page.evaluate(() => document.querySelector('.transcript__col').childElementCount);
  // Scroll to the top: older messages load and the visible message stays put.
  const res = await page.evaluate(async () => {
    const t = document.querySelector('.transcript');
    t.scrollTop = 100;
    const anchor = [...document.querySelectorAll('.transcript__col > *')].find(el => el.getBoundingClientRect().top > t.getBoundingClientRect().top + 60);
    const y0 = anchor.getBoundingClientRect().top;
    await new Promise(r => setTimeout(r, 300));
    return { moved: Math.round(anchor.getBoundingClientRect().top - y0), after: document.querySelector('.transcript__col').childElementCount };
  });
  console.log('worst frame per switch (ms):', gaps.join(', '));
  console.log('at bottom after switch:', atBottom, '| items drawn first:', before, '| after scrolling up:', res.after, '| visible message moved by', res.moved, 'px');
  await shot('long-top');
  const ok = atBottom && res.after > before && Math.abs(res.moved) <= 2;
  console.log(ok ? 'long chat OK' : 'LONG CHAT PROBLEM');
}
