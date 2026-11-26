import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clock, dividerLabel } from '../web/src/lib/time.ts';

const parent = fileURLToPath(new URL('./out/', import.meta.url));
await mkdir(parent, { recursive: true });
const root = await mkdtemp(join(parent, 'screenshots-'));
try {
  // Stub the macOS preference with a folder owned by this fixture.
  const shots = join(root, 'Capture Folder');
  await mkdir(shots);
  await writeFile(join(root, 'defaults'), '#!/bin/sh\nprintf "%s\\n" "$MARION_SCREENSHOT_FIXTURE"\n', { mode: 0o755 });
  process.env.PATH = `${root}:${process.env.PATH}`;
  process.env.MARION_SCREENSHOT_FIXTURE = shots;
  process.env.DB_PATH = ':memory:';
  const { listScreenshots, screenshotImage } = await import('../server/dist/features/screenshots.js');

  const first = 'First.png';
  const second = 'Second.jpg';
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aC5sAAAAASUVORK5CYII=', 'base64');
  await writeFile(join(shots, first), png);
  await writeFile(join(shots, second), 'second fixture');
  await writeFile(join(shots, 'notes.txt'), 'not a screenshot');
  await writeFile(join(shots, 'empty.png'), '');
  await symlink(first, join(shots, 'link.png'));
  const today = new Date(2026, 10, 25, 9, 2);
  const earlier = new Date(2026, 10, 25, 8);
  await utimes(join(shots, first), today, today);
  await utimes(join(shots, second), earlier, earlier);

  const page = await listScreenshots(1, 0);
  assert.equal(page.total, 2);
  assert.equal(page.items[0].name, first);
  assert.equal((await listScreenshots(1, 1)).items[0].name, second);
  const image = await screenshotImage(first, false);
  assert.equal(image.type, 'image/png');
  assert.deepEqual(image.body, png);
  for (const name of ['../First.png', 'link.png', 'notes.txt', 'empty.png']) {
    assert.equal(await screenshotImage(name, false), null, name);
  }
  assert.equal(dividerLabel(page.items[0].at, +today), `Today ${clock(+today)}`);
  console.log('PASS: screenshots page newest first, show same-day timestamps, and only serve eligible files.');
} finally {
  await rm(root, { recursive: true, force: true });
}
