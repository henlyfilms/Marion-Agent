// Teach by recording: upload a video (SHOT_VIDEO=path/to.webm), check key moments, history and reopen.
export default async function (page, shot) {
  await page.locator('.panel-card--teach button').click();
  await page.waitForTimeout(500);
  await page.locator('.teach-modal input[type=file]').setInputFiles(process.env.SHOT_VIDEO);
  await page.waitForSelector('.teach-modal__frames img', { timeout: 30000 });
  await page.waitForTimeout(1500);
  await shot('teach-review');
  console.log('frames', await page.locator('.teach-modal__frames img').count());
  await page.locator('.teach-modal .modal__close').click();
  await page.waitForTimeout(600);
  await page.locator('.panel-card--teach button').click();
  await page.waitForSelector('.teach-history__row', { timeout: 5000 });
  await shot('teach-history');
  console.log('history rows', await page.locator('.teach-history__row').count());
  await page.locator('.teach-history__open').first().click();
  await page.waitForSelector('.teach-modal__frames img');
  console.log('reopened frames', await page.locator('.teach-modal__frames img').count());
}
