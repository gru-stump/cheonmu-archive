import { expect, test } from 'playwright/test';

const cheonryeongFullBodyAlt = '흰 머리를 길게 땋고 흰색 의료 가운을 입은 천령의 전신 일러스트';

test('visitor sees public artwork on the archive home page', async ({ page }) => {
  await page.goto('./');
  const artwork = page.getByAltText(cheonryeongFullBodyAlt, { exact: true });

  await expect(artwork).toBeVisible();
  await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
});

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
]) {
  test(`Muyeong home caption stays inside the portrait panel at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./');

    const portraits = page.locator('.home-portraits');
    const caption = page.locator('.home-portrait--muyeong figcaption');
    await expect(portraits).toBeVisible();
    await expect(caption).toBeVisible();
    const [portraitsBounds, captionBounds] = await Promise.all([
      portraits.boundingBox(),
      caption.boundingBox(),
    ]);

    expect(portraitsBounds).not.toBeNull();
    expect(captionBounds).not.toBeNull();
    expect(captionBounds!.x).toBeGreaterThanOrEqual(portraitsBounds!.x);
    expect(captionBounds!.x + captionBounds!.width).toBeLessThanOrEqual(portraitsBounds!.x + portraitsBounds!.width);
    expect(captionBounds!.y).toBeGreaterThanOrEqual(portraitsBounds!.y);
    expect(captionBounds!.y + captionBounds!.height).toBeLessThanOrEqual(portraitsBounds!.y + portraitsBounds!.height);
  });
}

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
