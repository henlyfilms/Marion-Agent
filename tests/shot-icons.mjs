// Pixel check: each icon's drawn ink is centered in its button (border hidden while measuring).
export const targets = [
  ['sidebar toggle', '.sidebar-toggle'], ['sort', '.sidebar__sort-trigger'], ['new bot', '.sidebar__create'], ['bot settings gear', '.details__gear'],
  ['share', '.conversation-actions [aria-label="Share"]'], ['side panel', '.details-toggle'], ['composer plus', '.composer__plus-anchor button'],
  ['mic', '.composer__mic-anchor button'], ['call', '.composer__call-anchor button'], ['footer', '.sidebar__footer .icon-btn'],
];
export async function measure(page) {
  await page.addStyleTag({ content: '.shot-bare { border-color: transparent !important; box-shadow: none !important; background: #000 !important; }' });
  const out = [];
  for (const [name, selector] of targets) {
    const el = page.locator(selector).first();
    if (!(await el.count()) || !(await el.isVisible())) continue;
    await el.evaluate(node => node.classList.add('shot-bare'));
    const png = (await el.screenshot()).toString('base64');
    await el.evaluate(node => node.classList.remove('shot-bare'));
    const r = await page.evaluate(async data => {
      const img = new Image(); img.src = `data:image/png;base64,${data}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
      const { data: px } = ctx.getImageData(0, 0, c.width, c.height);
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4; const l = (px[i] + px[i + 1] + px[i + 2]) / 3;
        if (l > 70) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      }
      return { w: c.width, h: c.height, dx: ((x0 + x1 + 1) / 2 - c.width / 2) / devicePixelRatio, dy: ((y0 + y1 + 1) / 2 - c.height / 2) / devicePixelRatio };
    }, png);
    out.push(`${name}: dx ${r.dx.toFixed(2)} dy ${r.dy.toFixed(2)}`);
  }
  return out;
}
export default async function (page) { console.log((await measure(page)).join('\n')); }
