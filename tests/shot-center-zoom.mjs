// Zoom centring check (owner, Nov 25: "even though it's off by only a couple pixels, you still need to fix it").
// The owner runs the app at 90% zoom, which Chromium draws exactly like a 1.8 device pixel ratio. This paints every
// icon-only button's hover circle solid red, then measures the drawn icon against the drawn circle in screen
// pixels (not against the CSS box), sidebar open and collapsed, at a few window widths.
// Usage: npm run build && DPR=1.8 BROWSER_EXECUTABLE=... node tests/shot.mjs <outDir> tests/shot-center-zoom.mjs
const TOL = Number(process.env.TOL ?? 0.5); // screen pixels

async function sweep(page, label, bad, seen) {
  const handles = await page.$$('button');
  for (const h of handles) {
    const info = await h.evaluate((b) => {
      const r = b.getBoundingClientRect();
      const style = getComputedStyle(b);
      if (!r.width || !r.height || style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
      if (r.right < 0 || r.bottom < 0 || r.left > innerWidth || r.top > innerHeight) return null;
      if (!b.querySelector('svg') || b.innerText.trim()) return null;
      if (b.closest('.bot-row, .chat__pill, .menu, [inert]')) return null;
      return { name: b.getAttribute('aria-label') || b.title || b.className, box: [r.x, r.y, r.width, r.height] };
    });
    if (!info) continue;
    await h.evaluate(b => b.classList.add('shot-red'));
    const [x, y, w, hgt] = info.box;
    const png = await page.screenshot({ clip: { x, y, width: w, height: hgt } }).catch(() => null);
    if (png && process.env.SAVE && process.env.SAVE_DIR) await import('node:fs/promises').then(fs => fs.writeFile(`${process.env.SAVE_DIR}/${label}-${info.name}.png`.replace(/ /g, '_'), png));
    await h.evaluate(b => b.classList.remove('shot-red'));
    if (!png) continue;
    const r = await page.evaluate(async data => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const { data: px } = ctx.getImageData(0, 0, c.width, c.height);
      // Outline boxes with sub-pixel edges: per row/column, the strongest coverage; an edge pixel that is
      // half covered moves the edge by half a pixel. Red = the circle or its ring (white ink is red too), bright green = the white icon (the ring's dim edge is ignored).
      const cov = (channel, axis) => {
        const n = axis === 'x' ? c.width : c.height, m = axis === 'x' ? c.height : c.width, out = new Array(n).fill(0);
        for (let a = 0; a < n; a++) for (let b = 0; b < m; b++) {
          const x = axis === 'x' ? a : b, y = axis === 'x' ? b : a;
          const v = px[(y * c.width + x) * 4 + channel];
          out[a] = Math.max(out[a], channel === 1 ? Math.max(0, v - 110) / 145 : Math.max(0, v - 40) / 215);
        }
        return out;
      };
      const span = line => {
        const first = line.findIndex(v => v > 0.04), last = line.length - 1 - [...line].reverse().findIndex(v => v > 0.04);
        if (first < 0) return null;
        return [first + 1 - line[first], last + line[last]];
      };
      const box = channel => { const x = span(cov(channel, 'x')), y = span(cov(channel, 'y')); return x && y ? [(x[0] + x[1]) / 2, (y[0] + y[1]) / 2] : null; };
      const circle = box(0), ink = box(1);
      if (!circle || !ink) return null;
      return { dx: ink[0] - circle[0], dy: ink[1] - circle[1] };
    }, png.toString('base64'));
    if (!r) continue;
    const key = `${label} ${info.name}`;
    seen.push(`${key.padEnd(46)} dx ${r.dx.toFixed(2).padStart(5)} dy ${r.dy.toFixed(2).padStart(5)} (screen px)`);
    if (Math.abs(r.dx) > TOL || Math.abs(r.dy) > TOL) bad.push(`${key}: icon off by ${r.dx.toFixed(2)}, ${r.dy.toFixed(2)} screen px`);
  }
}

export default async function (page) {
  // Circle solid red, icon pure white, nothing else on top (no ring, glow or shadow).
  await page.addStyleTag({ content: '.shot-red { background: #ff0000 !important; border-color: #ff0000 !important; box-shadow: none !important; color: #fff !important; } .shot-red svg { opacity: 1 !important; filter: none !important; }' });
  if (process.env.STYLE) await page.addStyleTag({ content: process.env.STYLE });
  const bad = [], seen = [];
  for (const width of (process.env.WIDTHS ?? '1320,1287,1451').split(',').map(Number)) {
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
  console.log(`checked ${seen.length} buttons at DPR ${(await page.evaluate(() => devicePixelRatio)).toFixed(2)}`);
  console.log(bad.length ? 'OFF-CENTRE:\n' + [...new Set(bad)].join('\n') : 'every icon centred in its circle');
}
