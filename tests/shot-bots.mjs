export default async function (page, shot) {
  await page.keyboard.press('Meta+,');
  await page.waitForTimeout(600);
  await page.locator('.sheet-row', { hasText: 'General' }).click();
  await page.waitForTimeout(600);
  await page.getByText('Bots can change Marion Agent').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot('bots-section');
  await page.locator('.sheet-row, .sheet-back, button', { hasText: /^General$|Back/ }).first().click().catch(() => {});
  await page.locator('.sheet-row', { hasText: 'Audio' }).click().catch(() => {});
  await page.waitForTimeout(500);
  await shot('audio');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);
  await page.locator('.panel-card--teach button').click();
  await page.waitForTimeout(600);
  await shot('teach');
}
