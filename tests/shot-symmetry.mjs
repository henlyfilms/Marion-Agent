// Symmetry check for round icon buttons: for each button, the glyph's ink is mirrored left↔right (and
// top↕bottom for glyphs that should be) around the button's centre and compared with itself, and the
// ink's weighted centre is measured. Saves an 8x enlargement of each button so it can be inspected.
// Usage: npm run build && BROWSER_EXECUTABLE=... node tests/shot.mjs <outDir> tests/shot-symmetry.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { targets } from './shot-icons.mjs';

// Glyphs that should mirror top↕bottom too (the plus, the gear).
const both = new Set(['new bot', 'bot settings gear', 'composer plus']);

export default async function (page, shot) {
  await page.addStyleTag({ content: '.shot-bare { border-color: transparent !important; box-shadow: none !important; background: #000 !important; }' });
  const out = process.argv[2];
  const report = [];
  const bad = [];
  for (const width of [1320, 1287, 1451, 1517, 1203]) {
  await page.setViewportSize({ width, height: 860 });
  await page.waitForTimeout(400);
  report.push(`-- window ${width}px wide`);
  for (const [name, selector] of targets) {
    const el = page.locator(selector).first();
    if (!(await el.count()) || !(await el.isVisible())) continue;
    await el.evaluate(node => node.classList.add('shot-bare'));
    const png = await el.screenshot();
    await el.evaluate(node => node.classList.remove('shot-bare'));
    if (width === 1517) writeFileSync(join(out, `sym-${name.replace(/\W+/g, '-')}.png`), png);
    const box = await el.evaluate(node => { const r = node.getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; });
    const r = await page.evaluate(async data => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const { data: px } = ctx.getImageData(0, 0, c.width, c.height);
      const W = c.width, H = c.height, L = (x, y) => { const i = (y * W + x) * 4; return Math.max(0, (px[i] + px[i + 1] + px[i + 2]) / 3 - 20); };
      let sum = 0, sx = 0, sy = 0, mirX = 0, mirY = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = L(x, y); sum += v; if (v > 50) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } sx += v * (x + 0.5); sy += v * (y + 0.5);
        mirX += Math.abs(v - L(W - 1 - x, y)); mirY += Math.abs(v - L(x, H - 1 - y));
      }
      const d = devicePixelRatio;
      return { bx: ((x0 + x1 + 1) / 2 - W / 2) / d, by: ((y0 + y1 + 1) / 2 - H / 2) / d, cx: (sx / sum - W / 2) / d, cy: (sy / sum - H / 2) / d, lr: (mirX / sum) * 50, tb: (mirY / sum) * 50 };
    }, png.toString('base64'));
    const frac = box.some(v => Math.abs(v - Math.round(v)) > 0.01);
    if (frac) bad.push(`${width}: ${name} sits between pixels ${box.map(v => v.toFixed(2))}`);
    if (Math.abs(box[2] - box[3]) > 0.01) bad.push(`${width}: ${name} is not round (${box[2]}x${box[3]})`);
    if (Math.abs(r.bx) > 0.26 || Math.abs(r.by) > 0.26) bad.push(`${width}: ${name} edges off-centre ${r.bx.toFixed(2)}, ${r.by.toFixed(2)}`);
    if (r.lr > 3 && !['sort', 'call', 'sidebar toggle', 'side panel'].includes(name)) bad.push(`${width}: ${name} not mirror-symmetric (${r.lr.toFixed(1)}%)`);
    const line = `${name.padEnd(18)} edges off-centre x ${r.bx.toFixed(2)} y ${r.by.toFixed(2)} | weight off-centre x ${r.cx.toFixed(2)}px y ${r.cy.toFixed(2)}px | left↔right mismatch ${r.lr.toFixed(1)}%` + (both.has(name) ? ` | top↕bottom ${r.tb.toFixed(1)}%` : '');
    report.push(line);
  }
  }
  await page.setViewportSize({ width: 1320, height: 860 });
  console.log(report.join('\n'));
  console.log(bad.length ? 'NOT SYMMETRIC:\n' + bad.join('\n') : 'icons symmetric at every width');
}
