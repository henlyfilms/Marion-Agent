// Renders the app icon artwork to every PNG the app ships, and the macOS .icns (owner, Nov 25: the app icon glows
// like a bot with Glow on). Run after editing assets/icon.svg or web/public/favicon.svg:
//   BROWSER_EXECUTABLE=... node scripts/render-icons.mjs
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined });
async function render(svgPath, size, out, inset = 0) {
  const svg = await readFile(join(root, svgPath), 'utf8');
  const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${size - inset * 2}" height="${size - inset * 2}" style="display:block;margin:${inset}px"`)}</body></html>`);
  await page.screenshot({ path: out, omitBackground: true });
  await page.close();
}
try {
  await render('assets/icon.svg', 1024, join(root, 'assets/icon-1024.png'));
  // Home Screen / install icons are full-bleed: draw the small artwork (no margin) so iOS rounds it itself.
  await render('web/public/favicon.svg', 512, join(root, 'web/public/app-512.png'));
  await render('web/public/favicon.svg', 192, join(root, 'web/public/app-192.png'));
  const set = join(await mkdtemp(join(tmpdir(), 'marion-icon-')), 'MarionAgent.iconset');
  execFileSync('mkdir', ['-p', set]);
  for (const size of [16, 32, 128, 256, 512]) {
    await render('assets/icon.svg', size, join(set, `icon_${size}x${size}.png`));
    await render('assets/icon.svg', size * 2, join(set, `icon_${size}x${size}@2x.png`));
  }
  execFileSync('iconutil', ['-c', 'icns', set, '-o', join(root, 'Marion Agent Installer/payload/Resources/MarionAgent.icns')]);
  console.log('icons rendered');
} finally {
  await browser.close();
}
