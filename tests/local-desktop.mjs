import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { desktop } from '../server/dist/desktop.js';

const base = process.argv[2] ?? 'http://127.0.0.1:8787';
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE || undefined,
  args: ['--no-sandbox'],
});
const botIds = [];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000 });
const container = id => `marion-desktop-${id}`;
const name = `Desktop smoke ${Date.now()}`;

try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const request = context.request;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  assert.equal((await request.get(base + '/api/health')).status(), 200);
  assert.equal((await request.get(base + '/api/bots')).status(), 401);
  await page.goto(base);
  await page.getByRole('heading', { name: 'Marion Agent' }).waitFor();
  await page.getByRole('textbox', { name: 'Email', exact: true }).fill(`local-desktop-${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Continue with email' }).click();
  await page.getByRole('textbox', { name: 'Message Barry' }).waitFor();
  const api = async (path, method = 'GET', data) => {
    const response = await request.fetch(base + '/api' + path, {
      method, headers: { 'Content-Type': 'application/json' }, data,
    });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response;
  };
  const { bots } = await (await api('/bots')).json();
  const primary = bots.find(bot => bot.name === 'Barry').id;
  botIds.push(primary);

  const retry = async (check, label) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    assert.fail(label);
  };
  const wake = async botId => {
    await api('/computer/ensure', 'POST', { botId });
    await retry(async () => {
      const { computer } = await (await api('/computer')).json();
      assert.notEqual(computer.status, 'error', computer.error);
      const screenshot = await api(`/bots/${botId}/screenshot`);
      return screenshot.status() === 200 && (await screenshot.body()).length > 1000;
    }, 'desktop never produced a screenshot');
  };

  await page.getByText("Bot's computer", { exact: true }).click();
  const viewer = page.getByRole('dialog', { name: "Barry's computer" });
  await viewer.getByRole('button', { name: 'Wake computer' }).click();
  await viewer.getByText('Watching', { exact: true }).waitFor({ timeout: 30_000 });
  await viewer.getByRole('button', { name: 'Take control' }).click();
  await viewer.getByRole('button', { name: "I'm done" }).waitFor();
  docker('exec', '-d', container(primary), 'xterm', '-T', 'Marion smoke input',
    '-e', 'bash', '-c', 'IFS= read -r value; printf "%s" "$value" > /workspace/input.txt');
  docker('exec', container(primary), 'xdotool', 'search', '--sync', '--onlyvisible', '--name', 'Marion smoke input', 'windowfocus');
  await page.keyboard.type('viewer keyboard');
  await page.keyboard.press('Enter');
  await retry(async () => {
    const value = await desktop.bash(primary, 'cat /workspace/input.txt', 5);
    return value.exit_code === 0 && value.output === 'viewer keyboard';
  }, 'keyboard input did not reach the desktop');
  await viewer.getByRole('button', { name: "I'm done" }).click();
  await viewer.getByText('Watching', { exact: true }).waitFor();
  await viewer.getByRole('button', { name: 'Close computer' }).click();

  const created = await api('/bots', 'POST', { name });
  const { bot: second } = await created.json();
  botIds.push(second.id);
  await wake(second.id);
  docker('exec', '-d', container(second.id), 'chromium', '--no-sandbox', '--no-first-run',
    '--disable-dev-shm-usage', '--user-data-dir=/workspace/profiles/smoke', 'about:blank');
  await retry(async () => {
    const search = await desktop.bash(second.id, "xdotool search --onlyvisible --class chromium", 5);
    return search.exit_code === 0 && Boolean(search.output.trim());
  }, 'Chromium did not open inside the second desktop');

  const library = `/workspace/files/${primary}`;
  assert.equal((await desktop.bash(primary, `mkdir -p ${library}`)).exit_code, 0);
  await desktop.save(primary, `${library}/proof.txt`, Buffer.from('desktop smoke'));
  const list = await (await api(`/bots/${primary}/files`)).json();
  assert.ok(list.files.some(file => file.name === 'proof.txt'));
  const download = async () => (await api(`/bots/${primary}/files/download`, 'POST', { path: 'proof.txt' })).text();
  assert.equal(await download(), 'desktop smoke');
  docker('exec', container(second.id), 'test', '!', '-e', `${library}/proof.txt`);
  assert.notEqual(docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', container(primary)),
    docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', container(second.id)));

  await api('/computer/suspend', 'POST');
  assert.equal((await api(`/bots/${primary}/screenshot`)).status(), 204);
  assert.equal((await api(`/bots/${second.id}/screenshot`)).status(), 204);
  await wake(primary);
  assert.equal(await download(), 'desktop smoke');
  assert.deepEqual(errors, []);
  console.log('PASS: built site, sign-in, desktop viewer and control, two isolated workspaces, Library download and persistence after suspend.');
} finally {
  await browser.close();
  if (process.env.CLEANUP_TEST_DESKTOPS === '1') {
    for (const id of botIds) {
      const resource = container(id);
      for (const args of [['rm', '-f', resource], ['volume', 'rm', resource], ['network', 'rm', resource]]) {
        try { execFileSync('docker', args, { stdio: 'ignore', timeout: 15_000 }); } catch { /* may not have been created */ }
      }
    }
  }
}
