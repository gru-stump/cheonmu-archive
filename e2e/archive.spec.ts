import { expect, test } from 'playwright/test';

const cheonryeongFullBodyAlt = '흰 머리를 길게 땋고 흰색 의료 가운을 입은 천령의 전신 일러스트';

test('visitor sees public artwork on the archive home page', async ({ page }) => {
  await page.goto('./');
  const artwork = page.getByAltText(cheonryeongFullBodyAlt, { exact: true });

  await expect(artwork).toBeVisible();
  await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
});

test('visitor reads a record and opens its cinematic scene', async ({ page }) => {
  await page.goto('./#/records');
  await page.getByRole('link', { name: '첫 조우', exact: true }).click();
  await page.getByRole('button', { name: '장면 재구성 열기', exact: true }).click();

  await expect(page.getByRole('dialog', { name: '첫 조우 장면 재구성', exact: true })).toBeVisible();
});

test('mobile visitor opens a gallery image', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/archive/gallery');
  const artwork = page.getByAltText(cheonryeongFullBodyAlt, { exact: true });
  await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await artwork.click();

  await expect(page.getByRole('dialog', { name: '천령 전신', exact: true })).toBeVisible();
});
