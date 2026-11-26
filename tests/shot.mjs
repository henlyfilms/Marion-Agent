// Screenshot helper for UI work: starts the built server, signs in, makes a few bots and shoots the Mac
// window layout (Electron user agent, with the window buttons drawn where macOS puts them).
// Usage: npm run build && BROWSER_EXECUTABLE=... node tests/shot.mjs <outDir> [script.mjs]
// The optional script default-exports async (page, shot) => {} for extra steps.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const out = resolve(process.argv[2] ?? 'tests/out/shots');
await mkdir(out, { recursive: true });
const workDir = await mkdtemp(join(tmpdir(), 'marion-shot-'));
const port = process.env.MARION_TEST_PORT ?? '8861';
const app = `http://127.0.0.1:${port}`;
process.env.SHOT_DB = join(workDir, 'shot.db');
const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../server/', import.meta.url),
  env: { ...process.env, DB_PATH: join(workDir, 'shot.db'), PORT: port, HOST: '127.0.0.1', APP_URL: app, SERVER_URL: app, DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1', MARION_LOCAL_MODEL_URL: 'http://127.0.0.1:9/v1' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
let browser;
try {
  for (let i = 0; i < 80 && !(await fetch(app + '/api/health').catch(() => null))?.ok; i++) await new Promise(r => setTimeout(r, 100));
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
  const context = await browser.newContext({ viewport: { width: Number(process.env.W ?? 1320), height: Number(process.env.H ?? 860) }, deviceScaleFactor: 2,
    userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36 Electron/33.0.0', colorScheme: 'dark' });
  const page = await context.newPage();
  page.on('pageerror', e => console.log('pageerror', e.stack ?? String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|favicon/.test(m.text())) console.log('console', m.text()); });
  await page.goto(app);
  await page.evaluate(async () => {
    await fetch('/api/auth/dev', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'shot@example.com' }) });
    for (const [name, color] of [['Barry', 'purple'], ['Moose', 'blue'], ['Bot Builder', 'orange']]) {
      await fetch('/api/bots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description: 'Manage and improve Marion Agent using Claude, Codex, and Gemini.', avatarColor: color }) });
    }
  });
  await page.goto(app);
  await page.waitForSelector('.sidebar');
  await page.locator('.bot-list .bot-row').first().click();
  await page.waitForTimeout(700);
  // macOS window buttons: 12px circles at x 15/35/55 (left edges), y 14.
  await page.addStyleTag({ content: `body::after{content:'';position:fixed;z-index:99999;left:15px;top:14px;width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:20px 0 #febc2e,40px 0 #28c840;pointer-events:none}` });
  const shot = async (name, clip) => page.screenshot({ path: join(out, `${name}.png`), clip });
  await shot('main');
  if (process.argv[3]) await (await import(pathToFileURL(resolve(process.argv[3])).href)).default(page, shot, app);
  else {
    await page.keyboard.press('Meta+b');
    await page.waitForTimeout(500);
    await shot('collapsed');
  }
} finally {
  await browser?.close();
  child.kill();
}
