// Centring sweep: finds EVERY visible icon-only button on screen (sidebar open and collapsed, several window
// widths) and measures the icon's drawn ink against the button's centre, plus whether the button is round
// and on whole pixels. Run at both pixel densities: DPR=1 (non-Retina monitor) and DPR=2 (Retina).
// Usage: npm run build && DPR=1 BROWSER_EXECUTABLE=... node tests/shot.mjs <outDir> tests/shot-center-all.mjs
const TOL = 0.26; // css px
// No optical offsets any more: Share's old 1px lift read as "off by a couple pixels" (owner, Nov 25), so every
// icon is centred on its outline. For zoomed windows (90%, 110%) see tests/shot-center-zoom.mjs.
const OPTICAL = {};

async function sweep(page, label, bad, seen) {
  const handles = await page.$$('button');
  for (const h of handles) {
    const info = await h.evaluate((b) => {
      const r = b.getBoundingClientRect();
      const style = getComputedStyle(b);
      if (!r.width || !r.height || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
      if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return null;
      if (!b.querySelector('svg') || b.innerText.trim()) return null; // icon-only buttons
      if (b.closest('.bot-row, .chat__pill, .menu, [inert]')) return null;
      const round = parseFloat(style.borderTopLeftRadius) >= Math.min(r.width, r.height) / 2 - 0.5;
      const name = b.getAttribute('aria-label') || b.title || b.className;
      return { name, box: [r.x, r.y, r.width, r.height], round };
    });
    if (!info) continue;
    await h.evaluate(b => b.classList.add('shot-bare'));
    const png = await h.screenshot().catch(() => null);
    await h.evaluate(b => b.classList.remove('shot-bare'));
    if (!png) continue;
    const r = await page.evaluate(async data => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const { data: px } = ctx.getImageData(0, 0, c.width, c.height);
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4; if ((px[i] + px[i + 1] + px[i + 2]) / 3 > 60) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      }
      const d = devicePixelRatio;
      return x1 < 0 ? null : { dx: ((x0 + x1 + 1) / 2 - c.width / 2) / d, dy: ((y0 + y1 + 1) / 2 - c.height / 2) / d };
    }, png.toString('base64'));
    if (!r) continue;
    const key = `${label} ${info.name}`;
    const [x, y, w, hgt] = info.box;
    const issues = [];
    const want = OPTICAL[info.name] ?? { dx: 0, dy: 0 };
    if (Math.abs(r.dx - want.dx) > TOL || Math.abs(r.dy - want.dy) > TOL) issues.push(`icon off-centre ${r.dx.toFixed(2)}, ${r.dy.toFixed(2)}`);
    if (info.round && Math.abs(w - hgt) > 0.01) issues.push(`oval ${w}x${hgt}`);
    if ([x, y, w, hgt].some(v => Math.abs(v - Math.round(v)) > 0.01)) issues.push(`between pixels ${[x, y, w, hgt].map(v => +v.toFixed(2))}`);
    seen.push(`${key.padEnd(46)} dx ${r.dx.toFixed(2).padStart(5)} dy ${r.dy.toFixed(2).padStart(5)} ${w}x${hgt}`);
    if (issues.length) bad.push(`${key}: ${issues.join('; ')}`);
  }
}

export default async function (page) {
  await page.addStyleTag({ content: '.shot-bare { border-color: transparent !important; box-shadow: none !important; background: #000 !important; color: #fff !important; border-color: transparent !important; }' });
  const bad = [], seen = [];
  for (const width of (process.env.WIDTHS ?? '1320,1287,1451,1517').split(',').map(Number)) {
    await page.setViewportSize({ width, height: 860 });
    await page.waitForTimeout(400);
    await sweep(page, `${width}`, bad, seen);
    await page.keyboard.press('Meta+b');
    await page.waitForTimeout(600);
    await sweep(page, `${width} collapsed`, bad, seen);
    await page.keyboard.press('Meta+b');
    await page.waitForTimeout(600);
  }
  if (process.env.VERBOSE) console.log(seen.join('\n'));
  console.log(`checked ${seen.length} buttons at DPR ${await page.evaluate(() => devicePixelRatio)}`);
  console.log(bad.length ? 'OFF-CENTRE:\n' + [...new Set(bad)].join('\n') : 'every button centred');
}
