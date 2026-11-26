// Contact sheet of every bot icon (large + sidebar size) for eyeballing distinctness.
// Usage: npm run build && node tests/shot-avatar-shapes.mjs  → tests/out/avatar-shapes.png
import { mkdirSync, writeFileSync } from 'node:fs';
import { AVATAR_GEOMETRY } from '../server/dist/avatarGeometry.js';
import { AVATAR_SHAPES, AVATAR_SHAPE_IDS } from '../server/dist/avatarShapes.js';

const FILL = '#7a3fd0', STEM = '#69864a';
const icon = (id, size, x, y) => {
  const g = AVATAR_GEOMETRY[id], [sx, sy] = g.stem;
  const eyes = [-1, 1].map((s) => `<ellipse cx="${50 + s * g.eyes.dx}" cy="${g.eyes.y}" rx="${4.6 * g.eyes.s}" ry="${7.5 * g.eyes.s}" transform="rotate(-15 ${50 + s * g.eyes.dx} ${g.eyes.y})" fill="#fff9fc"/>`).join('');
  return `<g transform="translate(${x} ${y}) scale(${size / 100})"><g transform="translate(${sx} ${sy + 3}) rotate(-18)"><path d="M0 4C0-2 2-7 6-10" fill="none" stroke="${STEM}" stroke-width="4" stroke-linecap="round"/><path d="M3-6Q6-14 16-11Q13-4 3-6Z" fill="${STEM}"/></g><path d="${g.d}" fill="${FILL}"/>${eyes}</g>`;
};
const cols = 6, cw = 150;
let body = '';
AVATAR_SHAPE_IDS.forEach((id, i) => {
  const x = 10 + (i % cols) * cw, y = 10 + Math.floor(i / cols) * cw;
  body += icon(id, 110, x + 10, y) + `<text x="${x + 65}" y="${y + 128}" font-size="12" text-anchor="middle" fill="#333" font-family="sans-serif">${AVATAR_SHAPES[id]}</text>`;
});
const rowY = 10 + Math.ceil(AVATAR_SHAPE_IDS.length / cols) * cw;
AVATAR_SHAPE_IDS.forEach((id, i) => { body += icon(id, 32, 10 + i * 37, rowY) + icon(id, 16, 10 + i * 37 + 8, rowY + 42); });
const h = rowY + 70;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cw + 20}" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${body}</svg>`;
mkdirSync(new URL('./out/', import.meta.url), { recursive: true });
const svgPath = new URL('./out/avatar-shapes.svg', import.meta.url);
writeFileSync(svgPath, svg);
try {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: cols * cw + 20, height: h } });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.screenshot({ path: new URL('./out/avatar-shapes.png', import.meta.url).pathname });
  await browser.close();
  console.log('wrote tests/out/avatar-shapes.png');
} catch (e) {
  console.log('wrote tests/out/avatar-shapes.svg (no browser available:', e.message.split('\n')[0] + ')');
}
