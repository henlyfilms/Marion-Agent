// Chat links are clickable and safe: Markdown + bare URLs render as <a target=_blank>, unsafe schemes never do,
// and the Electron shell hands only http/https/mailto to the default browser.
// Usage (repo root): TSX_TSCONFIG_PATH=web/tsconfig.json node --import tsx tests/links.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../web/src/components/Markdown.tsx';
import { safeHref } from '../web/src/lib/links.ts';

const require = createRequire(import.meta.url);
const { isExternalLink, wireExternalLinks } = require('../Marion Agent Installer/payload/Resources/app/external-links.cjs');

const html = text => renderToStaticMarkup(createElement(Markdown, { text }));
const anchors = markup => [...markup.matchAll(/<a\b[^>]*>/g)].map(m => m[0]);
const hrefOf = tag => tag.match(/href="([^"]*)"/)?.[1];

// --- Markdown rendering ---
const clickable = [
  ['[Docs](https://example.com/a?b=1&c=2)', 'https://example.com/a?b=1&amp;c=2'],
  ['[Plain http](http://example.com/x)', 'http://example.com/x'],
  ['See https://example.com/page now', 'https://example.com/page'],
  ['See http://example.com/page now', 'http://example.com/page'],
  ['Visit www.example.com today', 'http://www.example.com'],
  ['Mail [me](mailto:hi@example.com)', 'mailto:hi@example.com'],
  ['Mail mailto:hi@example.com please', 'mailto:hi@example.com'],
  ['Mail hi@example.com please', 'mailto:hi@example.com'],
  ['<https://example.com/angle>', 'https://example.com/angle'],
  ['- item [one](https://example.com/list)\n- item two', 'https://example.com/list'],
];
for (const [md, href] of clickable) {
  const tags = anchors(html(md));
  assert.equal(tags.length, 1, `one link for ${JSON.stringify(md)}: ${tags}`);
  assert.equal(hrefOf(tags[0]), href, md);
  assert.match(tags[0], /target="_blank"/, md);
  assert.match(tags[0], /rel="noopener noreferrer"/, md);
}
console.log(`PASS: ${clickable.length} Markdown / bare links render as clickable new-tab anchors.`);

const unsafe = [
  '[x](javascript:alert(1))', '[x](JaVaScRiPt:alert(1))', '[x](data:text/html;base64,PHNjcmlwdD4=)',
  '[x](vbscript:msgbox)', '[x](file:///etc/passwd)', '[x](/relative/path)', '[x](  javascript:alert(1))',
  'javascript:alert(1)', '<javascript:alert(1)>',
];
for (const md of unsafe) {
  const markup = html(md);
  assert.deepEqual(anchors(markup), [], `no anchor for ${md}: ${markup}`);
  assert.ok(!/href="\s*(javascript|data|vbscript|file):/i.test(markup), md);
}
assert.match(html('[click me](javascript:alert(1))'), /click me/, 'unsafe link text is kept as plain text');
for (const [url, ok] of [['https://a.b', true], ['http://a.b', true], ['mailto:a@b.c', true], ['javascript:1', false], ['data:,x', false], ['', false], [undefined, false]]) {
  assert.equal(Boolean(safeHref(url)), ok, String(url));
}
console.log(`PASS: ${unsafe.length} unsafe link forms render no anchor.`);

// --- Electron wiring ---
function fakeContents() {
  const handlers = {};
  return { handlers, setWindowOpenHandler(fn) { this.openHandler = fn; }, on(name, fn) { handlers[name] = fn; } };
}
const opened = [];
const contents = fakeContents();
const isLocal = url => { try { return new URL(url).origin === 'http://127.0.0.1:8789'; } catch { return false; } };
wireExternalLinks(contents, {
  isLocal,
  openExternal: async url => { opened.push(url); },
  onOpen: ({ url }) => url === 'about:blank' ? { action: 'allow' } : null,
});
for (const url of ['https://example.com/a', 'http://example.com/b', 'mailto:hi@example.com']) {
  assert.deepEqual(contents.openHandler({ url }), { action: 'deny' }, url);
  assert.equal(opened.pop(), url, `window.open / target=_blank opens ${url} externally`);
}
for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'not a url']) {
  assert.deepEqual(contents.openHandler({ url }), { action: 'deny' }, url);
  assert.equal(opened.length, 0, `${url} is never handed to the system`);
}
assert.deepEqual(contents.openHandler({ url: 'about:blank' }), { action: 'allow' }, 'OAuth popups are still claimed by the app');
assert.equal(opened.length, 0);

const nav = (url, from = 'will-navigate') => { let prevented = false; contents.handlers[from]({ preventDefault() { prevented = true; } }, url); return prevented; };
assert.equal(nav('https://example.com/c'), true, 'navigating away is cancelled');
assert.equal(opened.pop(), 'https://example.com/c', '...and opened in the default browser');
assert.equal(nav('javascript:alert(1)'), true);
assert.equal(opened.length, 0, 'unsafe navigation is cancelled, not opened');
assert.equal(nav('http://127.0.0.1:8789/chat'), false, 'in-app navigation is allowed');
assert.equal(nav('https://example.com/r', 'will-redirect'), true);
assert.equal(nav('http://127.0.0.1:8789/x', 'will-redirect'), false);
assert.equal(opened.length, 0, 'redirects are cancelled but not opened');
assert.ok(isExternalLink('mailto:a@b.c') && !isExternalLink('file:///x') && !isExternalLink('nope'));

// A failing openExternal must not throw out of the handler.
const broken = fakeContents();
wireExternalLinks(broken, { isLocal, openExternal: () => Promise.reject(new Error('no browser')) });
assert.deepEqual(broken.openHandler({ url: 'https://example.com' }), { action: 'deny' });
await new Promise(r => setTimeout(r, 10));

// main.cjs actually uses the helper for the main window.
const { readFileSync } = await import('node:fs');
const main = readFileSync(new URL('../Marion Agent Installer/payload/Resources/app/main.cjs', import.meta.url), 'utf8');
assert.match(main, /require\('\.\/external-links\.cjs'\)/);
assert.match(main, /wireExternalLinks\(win\.webContents,[\s\S]*shell\.openExternal\(url\)/);
console.log('PASS: Electron opens http/https/mailto externally via window-open + will-navigate; everything else is dropped.');
