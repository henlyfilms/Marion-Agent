import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, devices, webkit } from 'playwright';

const work = await mkdtemp(join(tmpdir(), 'marion-chat-'));
const origin = 'http://127.0.0.1:' + (process.env.MARION_TEST_PORT ?? '8799');
const requests = [];
const selectedModel = 'qwen3.8:27b-test';
const otherModel = 'other-chat-test';
const inference = createServer(async (request, response) => {
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: selectedModel }, { id: otherModel }] }));
    return;
  }
  if (request.method !== 'POST') return response.writeHead(404).end(); // not Ollama: no /api/ps
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  const text = 'Finished the task.';
  const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.output_item.done', item },
    { type: 'response.completed', response: { output: [item] } },
  ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
  response.end();
});
await new Promise(resolve => inference.listen(0, '127.0.0.1', resolve));
const server = spawn(process.execPath, ['dist/index.js'], {
  cwd: new URL('../server/', import.meta.url),
  env: {
    ...process.env, HOST: '127.0.0.1', PORT: new URL(origin).port, APP_URL: origin, SERVER_URL: origin,
    DB_PATH: join(work, 'test.db'), DEV_LOGIN: '1', MARION_NO_SCHEDULER: '1', MARION_DESKTOP_TOKEN: '',
    COMPOSIO_API_KEY: '', XAI_API_KEY: '', MARION_STT_URL: '',
    MARION_LOCAL_MODEL_URL: `http://127.0.0.1:${inference.address().port}/v1`, MARION_LOCAL_MODEL_KEY: '',
  },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const stopped = once(server, 'exit');
let browser, safari;

async function checkComposer(page, name) {
  const role = page.getByRole('group', { name: 'Message model and effort' });
  const field = page.getByRole('textbox', { name: 'Message ' + name });
  await role.waitFor();
  const [picker, input, shell] = await Promise.all([
    page.locator('.composer__models').boundingBox(), field.boundingBox(), page.locator('.composer').boundingBox(),
  ]);
  assert.ok(picker && input && shell);
  assert.ok(picker.y + picker.height <= shell.y && shell.y - (picker.y + picker.height) <= 10);
  assert.equal(picker.x, shell.x);
  assert.ok(input.x >= picker.x && input.y >= shell.y);
  assert.equal(await page.locator('.chat__header .chat-model').count(), 0);
  assert.equal(await role.getByRole('button', { name: /^Model:/ }).getAttribute('aria-controls'), await field.getAttribute('id'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

async function checkAppearance(page, linger = false) {
  const dialog = page.getByRole('dialog', { name: 'Create New Bot' });
  await page.getByRole('button', { name: 'New Bot', exact: true }).click();
  await dialog.waitFor();
  await dialog.getByRole('textbox', { name: 'Bot name' }).fill('Preview only');
  const first = dialog.getByRole('button', { name: 'Close', exact: true });
  await first.focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await dialog.getByRole('button', { name: 'Create', exact: true }).evaluate(button => button === document.activeElement), true);
  await page.keyboard.press('Tab');
  assert.equal(await first.evaluate(button => button === document.activeElement), true);
  const avatars = await dialog.evaluate(node => [...node.querySelectorAll('.shape-grid .bot-avatar > svg')].map(svg => {
    const eyes = svg.querySelector('[data-avatar-eyes]');
    const stem = svg.querySelector('[data-stem-color]');
    const transform = stem.transform.baseVal.getItem(0).matrix;
    const body = stem.nextElementSibling;
    const point = new DOMPoint(transform.e, transform.f + 2);
    return {
      eyes: eyes.querySelectorAll(':scope > ellipse').length, pupils: eyes.querySelectorAll('circle').length,
      attached: [...body.children].some(shape => shape.isPointInFill(point)),
    };
  }));
  assert.equal(avatars.length, 27, 'three full rows of berry shapes');
  assert.ok(avatars.every(shape => shape.eyes === 2 && shape.pupils === 0 && shape.attached), JSON.stringify(avatars.filter(shape => !shape.attached)));
  const stem = dialog.getByRole('switch', { name: 'Show stem' });
  const glow = dialog.getByRole('switch', { name: 'Glow' });
  await dialog.getByRole('radio', { name: 'blue' }).check();
  // A stem swatch applies straight away (no Done button).
  await dialog.getByRole('radio', { name: 'Stem #8a6236' }).click();
  assert.equal(await dialog.locator('.create-modal__preview [data-stem-color]').getAttribute('data-stem-color'), '#8a6236');
  const custom = dialog.getByRole('radio', { name: 'Custom stem color' });
  await custom.click();
  const hex = dialog.getByRole('textbox', { name: 'Stem color hex code' });
  await hex.fill('#7b38aa');
  assert.equal(await dialog.locator('.create-modal__preview [data-stem-color]').getAttribute('data-stem-color'), '#7b38aa');
  const field = dialog.locator('.stem-picker .color-picker__field');
  if (linger && process.env.MARION_SCREENSHOT_DIR) await dialog.screenshot({ path: join(process.env.MARION_SCREENSHOT_DIR, 'stem-picker.png'), animations: 'disabled' });
  await field.click({ position: { x: 150, y: 30 } });
  assert.notEqual(await hex.inputValue(), '#7b38aa');
  const chosen = (await hex.inputValue()).toLowerCase();
  await hex.press('Escape');
  assert.equal(await custom.getAttribute('aria-expanded'), 'false');
  assert.equal(await dialog.isVisible(), true);
  // Glow puts a bloom on the avatar itself.
  await glow.click();
  assert.equal(await dialog.locator('.create-modal__preview.is-glowing').count(), 1);
  await stem.click();
  assert.equal(await stem.getAttribute('aria-checked'), 'false');
  assert.equal(await dialog.locator('.create-modal__preview [data-stem-color]').count(), 0);
  await stem.click();
  assert.equal(await dialog.locator('.create-modal__preview [data-stem-color]').getAttribute('data-stem-color'), chosen);
  // The rainbow bot color opens the picker and any color applies at once.
  await dialog.locator('.color-choice .swatch-cell').last().click();
  await dialog.getByRole('textbox', { name: 'Bot color hex code' }).fill('#2a9d8f');
  assert.equal(await dialog.getByRole('radio', { name: 'Custom color' }).isChecked(), true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
}

try {
  let health;
  for (let i = 0; i < 40 && !health?.ok; i++) {
    health = await fetch(origin + '/api/health').catch(() => null);
    if (!health?.ok) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await health.json()).app, 'marion-agent');
  const login = await fetch(origin + '/api/auth/dev', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'chat-test@example.com' }),
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = (path, method = 'GET', body) => fetch(origin + '/api' + path, {
    method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  }).then(response => { assert.ok(response.ok, `${method} ${path}: ${response.status}`); return response.json(); });
  for (const [name, avatarColor] of [['Research', 'green'], ['Studio', 'blue'], ['Inbox', 'orange'], ['Operations', 'cyan']]) {
    const { bot } = await api('/bots', 'POST', { name, avatarColor });
    if (name === 'Studio' || name === 'Inbox') await api('/bots/' + bot.id, 'PATCH', { pinned: true });
  }

  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE || undefined, args: ['--no-sandbox'] });
  const [name, value] = cookie.split('=');
  const auth = { name, value, url: origin };
  const desktop = await browser.newContext({ viewport: { width: 1390, height: 925 } });
  await desktop.addCookies([auth]);
  const page = await desktop.newPage();
  const pageErrors = [];
  page.on('pageerror', cause => pageErrors.push(cause.message));
  await page.addInitScript(() => {
    window.SpeechRecognition = class {
      start() { window.recognition = this; }
      stop() { this.onend?.(); }
      abort() {}
    };
  });
  await page.goto(origin);
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await checkComposer(page, 'Research');
  const { memory } = await api('/settings/local-memory');
  assert.ok(memory.total > 0 && memory.available >= 0 && memory.available <= memory.total);
  await page.getByText(/GiB RAM available/).waitFor();
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.getByRole('menuitemradio', { name: selectedModel, exact: true }).click();
  await page.getByRole('button', { name: 'Effort: Medium' }).click();
  await page.getByRole('menuitemradio', { name: 'Extra high' }).click();
  await page.getByRole('button', { name: 'Effort: Extra high' }).waitFor();

  const composer = page.getByRole('textbox', { name: 'Message Research' });
  await page.keyboard.press('Meta+Shift+d');
  await page.getByRole('button', { name: 'Stop dictation' }).waitFor();
  await page.evaluate(() => {
    window.recognition.onresult({ results: [
      { isFinal: true, 0: { transcript: 'review the' } },
      { isFinal: false, 0: { transcript: 'research notes' } },
    ] });
  });
  await page.waitForFunction(() => document.querySelector('.composer__input').value === 'Review the research notes');
  await page.keyboard.press('Meta+Shift+d');
  assert.equal(await composer.inputValue(), 'Review the research notes');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('main.chat').getByText('Finished the task.', { exact: true }).waitFor();
  await page.getByRole('img', { name: 'Task completed' }).waitFor();
  const roster = await api('/bots');
  const research = roster.bots.find(bot => bot.name === 'Research');
  const operations = roster.bots.find(bot => bot.name === 'Operations');
  assert.ok(research.completedAt);
  assert.equal(requests.at(-1).model, selectedModel);
  assert.equal(requests.at(-1).reasoning.effort, 'xhigh');
  await page.waitForFunction(() => document.querySelector('.bot-list [data-chat-id]:nth-child(4) .bot-row__name')?.textContent === 'Research');
  await page.getByRole('button', { name: 'Operations', exact: true }).click();
  await page.getByRole('button', { name: /^Model:/ }).click();
  await page.getByRole('menuitemradio', { name: otherModel, exact: true }).click();
  await page.getByRole('button', { name: 'Effort: Medium' }).click();
  await page.getByRole('menuitemradio', { name: 'Low', exact: true }).click();
  await page.getByRole('button', { name: 'Effort: Low' }).waitFor();
  await page.getByRole('textbox', { name: 'Message Operations' }).fill('Use the Operations model.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('main.chat').getByText('Finished the task.', { exact: true }).waitFor();
  assert.equal(requests.at(-1).model, otherModel);
  assert.equal(requests.at(-1).reasoning.effort, 'low');
  await page.getByRole('button', { name: 'Research', exact: true }).click();
  await page.getByRole('button', { name: 'Model: ' + selectedModel }).waitFor();
  await page.getByRole('button', { name: 'Effort: Extra high' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Model: ' + selectedModel }).waitFor();

  const chat = (tab, id) => tab.locator(`[data-chat-id="${id}"] .bot-row`);
  const order = () => page.locator('.bot-list [data-chat-id]').evaluateAll(rows => rows.map(row => row.dataset.chatId));
  await page.getByRole('button', { name: 'Sort chats' }).click();
  await page.getByRole('menuitemradio', { name: 'Name', exact: true }).click();
  await page.waitForFunction(id => document.querySelector('.bot-list [data-chat-id]:nth-child(4)')?.dataset.chatId === id, operations.id);
  const before = await order();
  const from = await chat(page, research.id).boundingBox();
  const to = await chat(page, operations.id).boundingBox();
  const x = from.x + from.width / 2;
  await page.mouse.move(x, from.y + from.height / 2);
  await page.mouse.down();
  await page.locator('.bot-list .is-moving').waitFor();
  await page.mouse.move(x, to.y + to.height / 4, { steps: 6 });
  await page.waitForFunction(id => document.querySelector(`[data-chat-id="${id}"]`).style.translate !== '', operations.id);
  let finishSave;
  const saved = new Promise(resolve => { finishSave = resolve; });
  await page.route('**/api/bots/order', async route => { await saved; await route.continue(); }, { times: 1 });
  const reordered = page.waitForResponse(response => response.url().endsWith('/api/bots/order') && response.ok());
  try {
    await page.mouse.up();
    await page.waitForFunction(id => document.querySelector('.bot-list [data-chat-id]:nth-child(4)')?.dataset.chatId === id, research.id);
  } finally { finishSave(); }
  await reordered;
  assert.equal((await api('/bots')).chatSort, 'custom');
  const custom = await order();
  assert.notDeepEqual(custom, before);
  await chat(page, research.id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Star chat', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`[data-chat-id="${id}"]`).dataset.starred === 'true', research.id);
  await chat(page, research.id).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Unstar chat', exact: true }).click();
  await page.waitForFunction(id => document.querySelector(`[data-chat-id="${id}"]`).dataset.starred === 'false', research.id);
  assert.deepEqual(await order(), custom);
  await page.reload();
  await page.waitForFunction(id => document.querySelector('.bot-list [data-chat-id]:nth-child(4)')?.dataset.chatId === id, research.id);
  await page.getByRole('button', { name: 'Sort chats' }).click();
  await page.getByRole('menuitemradio', { name: 'Recent activity', exact: true }).click();
  if (process.env.MARION_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.MARION_SCREENSHOT_DIR, 'desktop.png'), animations: 'disabled' });
  for (const selector of ['.sidebar-toggle', '.details-toggle']) {
    const toggle = page.locator(selector);
    const start = await toggle.getAttribute('aria-expanded');
    for (let click = 0; click < 2; click++) {
      const movement = await toggle.evaluate(async button => {
        const { x, y } = button.getBoundingClientRect();
        button.click();
        let distance = 0;
        const until = performance.now() + 300;
        do {
          await new Promise(requestAnimationFrame);
          const rect = button.getBoundingClientRect();
          distance = Math.max(distance, Math.hypot(rect.x - x, rect.y - y));
        } while (performance.now() < until);
        return distance;
      });
      assert.ok(movement < 0.5, `${selector} moved ${movement}px`);
    }
    assert.equal(await toggle.getAttribute('aria-expanded'), start);
  }

  await page.keyboard.press('Control+,');
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('button', { name: 'Models' }).click();
  await settings.getByText(/host RAM available/).waitFor();
  await settings.getByRole('button', { name: 'Audio' }).click();
  await settings.getByRole('heading', { name: 'Audio' }).waitFor();
  await settings.getByRole('button', { name: 'Done', exact: true }).click();

  let finishUsage;
  const loadingUsage = new Promise(resolve => { finishUsage = resolve; });
  await page.route('**/api/subscriptions/usage?*', async route => {
    const provider = new URL(route.request().url()).searchParams.get('provider');
    await loadingUsage;
    await route.fulfill({ json: { subscriptions: [{
      provider, status: 'ready', plan: 'Test plan',
      windows: Array.from({ length: 4 }, (_, id) => ({ id: String(id), label: `Window ${id + 1}`, usedPercent: 50 })),
    }] } });
  });
  await page.getByRole('button', { name: 'Subscription usage', exact: true }).click();
  const usage = page.getByRole('dialog', { name: 'Subscription usage' });
  const loadingSize = await usage.evaluate(dialog => [dialog.offsetWidth, dialog.offsetHeight]);
  finishUsage();
  await usage.getByRole('status').filter({ hasText: '3 of 3 reporting' }).waitFor();
  assert.deepEqual(await usage.evaluate(dialog => [dialog.offsetWidth, dialog.offsetHeight]), loadingSize);
  await usage.getByRole('button', { name: 'Close', exact: true }).click();
  await page.emulateMedia({ colorScheme: 'dark' });
  await checkAppearance(page, true);
  await page.getByRole('button', { name: 'Research', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Bot settings…' }).click();
  const appearance = page.getByRole('dialog', { name: 'Research settings' });
  await appearance.getByRole('button', { name: 'Change look' }).click();
  await appearance.getByRole('switch', { name: 'Show stem' }).click();
  await appearance.getByRole('button', { name: 'Save changes' }).click();
  await appearance.getByText('Saved', { exact: true }).waitFor();
  assert.equal((await api('/bots')).bots.find(bot => bot.id === research.id).avatarStemColor, null);
  await appearance.getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 780, height: 790 });
  await checkComposer(page, 'Research');
  await page.getByRole('button', { name: /^Model:/ }).click();
  const splitMenu = await page.getByRole('menu', { name: 'Models' }).boundingBox();
  const splitChat = await page.locator('main.chat').boundingBox();
  assert.ok(splitMenu.x >= splitChat.x && splitMenu.x + splitMenu.width <= splitChat.x + splitChat.width);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1390, height: 925 });

  const phone = await browser.newContext(devices['iPhone 15 Pro']);
  await phone.addCookies([auth]);
  const mobile = await phone.newPage();
  mobile.on('pageerror', cause => pageErrors.push(cause.message));
  await mobile.goto(origin);
  const mobileResearch = mobile.getByRole('button', { name: 'Research', exact: true });
  await mobileResearch.waitFor();
  assert.equal(await mobile.locator('main.chat').isVisible(), false);
  if (process.env.MARION_SCREENSHOT_DIR) await mobile.screenshot({ path: join(process.env.MARION_SCREENSHOT_DIR, 'iphone-list.png'), animations: 'disabled' });
  const touch = await phone.newCDPSession(mobile);
  const firstRow = await chat(mobile, operations.id).boundingBox();
  const secondRow = await chat(mobile, research.id).boundingBox();
  const touchX = firstRow.x + firstRow.width / 2;
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touchX, y: firstRow.y + firstRow.height / 2 }] });
  await mobile.locator('.bot-list .is-moving').waitFor();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: touchX, y: secondRow.y + secondRow.height * 0.75 }] });
  const touchOrderSaved = mobile.waitForResponse(response => response.url().endsWith('/api/bots/order') && response.ok());
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await touchOrderSaved;
  await mobile.waitForFunction(() => document.querySelector('.sidebar__featured') === null);
  assert.equal((await api('/bots')).chatSort, 'custom');
  await mobile.getByRole('button', { name: 'Sort chats' }).tap();
  await mobile.getByRole('menuitemradio', { name: 'Recent activity', exact: true }).tap();
  await mobile.locator('.sidebar__featured').waitFor();
  const swipe = async (button, direction) => {
    const { x, y, width, height } = await button.boundingBox();
    const start = x + width / 2;
    const center = y + height / 2;
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: start, y: center }] });
    for (const distance of [20, 50, 85]) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start + direction * distance, y: center }] });
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  };
  await swipe(mobileResearch, 1);
  await mobile.getByRole('button', { name: 'Star Research' }).tap();
  await mobile.waitForFunction(id => document.querySelector(`[data-chat-id="${id}"] .bot-row__star`), research.id);
  assert.equal((await api('/bots')).bots.find(bot => bot.id === research.id).pinned, true);

  await mobileResearch.tap();
  await mobile.getByRole('textbox', { name: 'Message Research' }).waitFor();
  await checkComposer(mobile, 'Research');
  await mobile.getByRole('button', { name: 'Effort: Extra high' }).waitFor();
  if (process.env.MARION_SCREENSHOT_DIR) await mobile.screenshot({ path: join(process.env.MARION_SCREENSHOT_DIR, 'iphone-chat.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Effort: Extra high' }).click();
  await page.getByRole('menuitemradio', { name: 'High', exact: true }).click();
  await mobile.getByRole('button', { name: 'Effort: High' }).waitFor();
  await mobile.getByRole('button', { name: 'Show side panel' }).tap();
  await mobile.getByRole('button', { name: 'Hide side panel' }).tap();
  await mobile.getByRole('button', { name: 'Back to chats' }).tap();
  // The chat list slides back in (iOS-style); swipe once it has landed.
  await mobile.locator('.sidebar').evaluate(sidebar => Promise.allSettled(sidebar.getAnimations().map(animation => animation.finished)));
  await mobile.waitForTimeout(50);

  await swipe(mobileResearch, -1);
  await mobile.getByRole('button', { name: 'Delete Research' }).tap();
  const confirmation = mobile.getByRole('dialog', { name: 'Delete chat' });
  await confirmation.getByRole('button', { name: 'Cancel' }).tap();
  await confirmation.waitFor({ state: 'hidden' });
  await mobileResearch.evaluate(button => Promise.allSettled(button.closest('.chat-swipe').getAnimations({ subtree: true }).map(animation => animation.finished)));
  await swipe(mobileResearch, -1);
  await mobile.getByRole('button', { name: 'Delete Research' }).tap();
  await confirmation.getByRole('button', { name: 'Delete chat', exact: true }).tap();
  await mobileResearch.waitFor({ state: 'hidden' });
  assert.equal((await api('/bots')).bots.some(bot => bot.id === research.id), false);
  await checkAppearance(mobile);
  assert.deepEqual(pageErrors, []);

  if (process.env.WEBKIT_EXECUTABLE) {
    safari = await webkit.launch({ executablePath: process.env.WEBKIT_EXECUTABLE });
    const safariPhone = await safari.newContext(devices['iPhone 15 Pro']);
    await safariPhone.addCookies([auth]);
    const safariPage = await safariPhone.newPage();
    await safariPage.goto(origin);
    await safariPage.getByRole('button', { name: 'Operations', exact: true }).tap();
    await safariPage.getByRole('textbox', { name: 'Message Operations' }).waitFor();
    await safariPage.getByRole('button', { name: 'Back to chats' }).tap();
    await safariPage.getByRole('button', { name: 'Operations', exact: true }).waitFor();
    console.log('PASS: iPhone-sized WebKit navigation.');
  }
  console.log('PASS: composer placement, appearance, model and effort isolation, saved chat order, desktop and touch reordering, dictation, and swipe actions.');
} finally {
  await safari?.close();
  await browser?.close();
  server.kill();
  await stopped;
  inference.close();
  await rm(work, { recursive: true, force: true });
}
