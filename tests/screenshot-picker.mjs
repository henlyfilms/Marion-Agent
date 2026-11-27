import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { clock, dividerLabel } from '../web/src/lib/time.ts';
import { isScreenshotShortcut, listedTotal, SCREENSHOT_SHORTCUT_LABEL, moreInPastHour, pastHourQuery, PAST_HOUR_MS, recentQuery, RECENT_SHOTS, screenshotsPath } from '../web/src/lib/screenshots.ts';

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

  // ⇧⌘S shows the three newest; "Past hour" lists the others from the last 60 minutes.
  const now = Date.now();
  const minutesAgo = (minutes) => new Date(now - minutes * 60_000);
  const recent = [['Screenshot a.png', 2], ['Screenshot b.png', 9], ['Screenshot c.png', 20], ['Screenshot d.png', 41], ['Screenshot e.png', 58], ['Screenshot old.png', 75]];
  for (const [name, minutes] of recent) {
    await writeFile(join(shots, name), png);
    await utimes(join(shots, name), minutesAgo(minutes), minutesAgo(minutes));
  }
  assert.equal(RECENT_SHOTS, 3);
  assert.equal(PAST_HOUR_MS, 3_600_000);
  assert.equal(screenshotsPath(recentQuery()), '/api/screenshots?limit=3&offset=0');
  const quick = await listScreenshots(recentQuery().limit, 0, undefined, now);
  assert.deepEqual(quick.items.map(entry => entry.name), ['Screenshot a.png', 'Screenshot b.png', 'Screenshot c.png']);
  assert.equal(quick.pastHour, 5, 'five screenshots from the last 60 minutes');
  assert.equal(moreInPastHour(quick), 2, 'two more than the quick view shows');

  const hourQuery = pastHourQuery(now, 24);
  assert.deepEqual(hourQuery, { limit: 24, offset: 3, since: now - PAST_HOUR_MS });
  assert.equal(screenshotsPath(hourQuery), `/api/screenshots?limit=24&offset=3&since=${now - PAST_HOUR_MS}`);
  const hour = await listScreenshots(hourQuery.limit, hourQuery.offset, hourQuery.since, now);
  assert.deepEqual(hour.items.map(entry => entry.name), ['Screenshot d.png', 'Screenshot e.png'], 'older than an hour is left out');
  assert.equal(hour.total, 5);
  assert.equal(listedTotal(hour, true), 2, 'the past-hour view counts (and pages through) only the ones not already shown');
  assert.equal(listedTotal(hour, false), 5);
  assert.equal(listedTotal({ total: 1 }, true), 0);
  const paged = pastHourQuery(now, 1, 1);
  assert.deepEqual((await listScreenshots(paged.limit, paged.offset, paged.since, now)).items.map(entry => entry.name), ['Screenshot e.png']);

  // Clean empty state: nothing else from the past hour when the three shown are all there is.
  const later = now + 50 * 60_000;
  const lateQuery = pastHourQuery(later, 24);
  const none = await listScreenshots(lateQuery.limit, lateQuery.offset, lateQuery.since, later);
  assert.equal(none.items.length, 0);
  assert.equal(moreInPastHour(none), 0);
  assert.equal(moreInPastHour({ pastHour: 2 }), 0);
  console.log('PASS: the shortcut shows the 3 newest screenshots and "Past hour" lists the rest from the last 60 minutes.');

  // ⇧⌘S on a Mac, Ctrl+Shift+S elsewhere (Node reports the host platform), also on layouts where S moves.
  const mac = SCREENSHOT_SHORTCUT_LABEL === '⇧⌘S';
  const press = (over) => ({ metaKey: mac, ctrlKey: !mac, shiftKey: true, altKey: false, code: 'KeyS', key: 'S', ...over });
  assert.equal(isScreenshotShortcut(press()), true);
  assert.equal(isScreenshotShortcut(press({ metaKey: !mac, ctrlKey: mac })), false, 'the other platform’s modifier does not count');
  assert.equal(isScreenshotShortcut(press({ code: 'Semicolon', key: 's' })), true, 'Dvorak: the S letter, not the S key');
  assert.equal(isScreenshotShortcut(press({ code: 'KeyS', key: 'o' })), false);
  assert.equal(isScreenshotShortcut(press({ key: 'ы' })), true, 'non-Latin layouts fall back to the physical key');
  assert.equal(isScreenshotShortcut(press({ shiftKey: false, key: 's' })), false);
  assert.equal(isScreenshotShortcut(press({ altKey: true })), false);
  console.log(`PASS: the shortcut matches ${SCREENSHOT_SHORTCUT_LABEL} on any keyboard layout, and past-hour counts skip the three already shown.`);
} finally {
  await rm(root, { recursive: true, force: true });
}
