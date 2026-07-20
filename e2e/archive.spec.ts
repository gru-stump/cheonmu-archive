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

test('long cinematic prose opens as one compact scrolling reading view', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('./#/records/first-contact');
  await page.getByRole('button', { name: '장면 재구성 열기', exact: true }).click();

  const sceneText = page.locator('.cinematic-scene__text');
  await expect(sceneText).toContainText('격리문이 닫히기 직전');
  await expect(sceneText).toContainText('그 판단을 의심할 힘이 남아 있지 않았다');
  await expect(page.getByRole('button', { name: '다음 장면' })).toHaveCount(0);

  const proseStyle = await sceneText.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: Number.parseFloat(style.lineHeight),
      textAlign: style.textAlign,
      width: element.getBoundingClientRect().width,
      viewportWidth: document.documentElement.clientWidth,
    };
  });

  expect(proseStyle.fontSize).toBeGreaterThanOrEqual(15);
  expect(proseStyle.fontSize).toBeLessThanOrEqual(17);
  expect(proseStyle.lineHeight).toBeGreaterThanOrEqual(proseStyle.fontSize * 1.8);
  expect(proseStyle.textAlign).toBe('left');
  expect(proseStyle.width).toBeLessThan(proseStyle.viewportWidth);

  const readingView = await page.locator('.cinematic-scene').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(readingView.scrollHeight).toBeGreaterThan(readingView.clientHeight);
});

test('mobile visitor opens a gallery image', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/archive/gallery');
  const artwork = page.getByAltText(cheonryeongFullBodyAlt, { exact: true });
  await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await artwork.click();

  await expect(page.getByRole('dialog', { name: '천령 전신', exact: true })).toBeVisible();
});
