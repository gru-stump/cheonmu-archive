import { readFileSync } from 'node:fs';
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

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`sidecar prose reader follows scroll direction at ${viewport.width}px`, async ({ page }) => {
    const finalProseSentence = readFileSync(
      new URL('../src/content/scenes/first-contact.md', import.meta.url),
      'utf8',
    ).trim().split(/(?:\r?\n){2,}/).at(-1)!;
    const summarySentence = readFileSync(
      new URL('../src/content/records/01-first-contact.md', import.meta.url),
      'utf8',
    ).split('---').at(-1)!.trim().split('\n')[0].replaceAll('**', '');
    await page.setViewportSize(viewport);
    await page.goto('./#/records/first-contact');

    const detail = page.locator('.record-detail');
    await expect(page.getByText(summarySentence, { exact: true })).toBeVisible();
    await expect(detail).not.toContainText(finalProseSentence);

    await page.locator('.cinematic-entry button').click();
    const reader = page.locator('.cinematic-scene');
    const prose = page.locator('.cinematic-scene__text--prose');
    const header = page.locator('.cinematic-scene__header');
    await expect(prose).toContainText(finalProseSentence);
    await expect(page.locator('.cinematic-scene__controls')).toHaveCount(0);

    await reader.evaluate((element) => {
      element.scrollTop = 500;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(header).toHaveClass(/cinematic-scene__header--hidden/);

    await reader.evaluate((element) => {
      element.scrollTop = 300;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(header).not.toHaveClass(/cinematic-scene__header--hidden/);

    const fontSize = await prose.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(15);
    expect(fontSize).toBeLessThanOrEqual(17);
  });
}

test('mobile visitor opens a gallery image', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('./#/archive/gallery');
  const artwork = page.getByAltText(cheonryeongFullBodyAlt, { exact: true });
  await expect.poll(() => artwork.evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await artwork.click();

  await expect(page.getByRole('dialog', { name: '천령 전신', exact: true })).toBeVisible();
});

const forbiddenWorldLabels = [
  '천령은 인외',
  '인외 의사',
  '피는 독이자 약',
  '흰 백사',
  '실제 나이 불명',
  '독과 약으로',
];

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`visitor uses the indexed world archive at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto('./#/world');

    const topNavigation = page.locator('.archive-navigation');
    const topNavigationLinks = topNavigation.getByRole('link');
    await expect(topNavigationLinks).toHaveText([
      '천무',
      '기록철',
      '세계관',
      '아카이브',
    ]);
    if (viewport.width === 390) {
      const railBounds = await page.locator('.archive-rail').boundingBox();
      const navigationBounds = await topNavigation.boundingBox();
      const linkBounds = await topNavigationLinks.evaluateAll((links) => links.map((link) => {
        const bounds = link.getBoundingClientRect();
        return {
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          left: bounds.left,
        };
      }));
      const [documentOverflow, navigationOverflow, railOverflow] = await Promise.all([
        page.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          scrollWidth: document.documentElement.scrollWidth,
        })),
        topNavigation.evaluate((navigation) => ({
          clientWidth: navigation.clientWidth,
          scrollWidth: navigation.scrollWidth,
        })),
        page.locator('.archive-rail').evaluate((rail) => ({
          clientWidth: rail.clientWidth,
          scrollWidth: rail.scrollWidth,
        })),
      ]);

      expect(railBounds).not.toBeNull();
      expect(navigationBounds).not.toBeNull();
      await expect(topNavigationLinks).toHaveCount(4);
      for (const link of await topNavigationLinks.all()) {
        await expect(link).toBeVisible();
      }
      for (const bounds of linkBounds) {
        expect(bounds.top).toBeGreaterThanOrEqual(navigationBounds!.y);
        expect(bounds.bottom).toBeLessThanOrEqual(navigationBounds!.y + navigationBounds!.height);
        expect(bounds.left).toBeGreaterThanOrEqual(navigationBounds!.x);
        expect(bounds.right).toBeLessThanOrEqual(navigationBounds!.x + navigationBounds!.width);
        expect(bounds.top).toBeGreaterThanOrEqual(railBounds!.y);
        expect(bounds.bottom).toBeLessThanOrEqual(railBounds!.y + railBounds!.height);
        expect(bounds.left).toBeGreaterThanOrEqual(railBounds!.x);
        expect(bounds.right).toBeLessThanOrEqual(railBounds!.x + railBounds!.width);
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(viewport.height);
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(viewport.width);
      }
      expect(documentOverflow.scrollWidth).toBeLessThanOrEqual(documentOverflow.clientWidth);
      expect(navigationOverflow.scrollWidth).toBeLessThanOrEqual(navigationOverflow.clientWidth);
      expect(railOverflow.scrollWidth).toBeLessThanOrEqual(railOverflow.clientWidth);
    }
    await expect(page.locator('.world-document')).toContainText('WF-01');
    await expect(page.getByRole('heading', { name: '특수재난관리청' })).toBeVisible();

    const indexToggle = page.getByRole('button', { name: '분류 색인' });
    if (viewport.width === 390) {
      await expect(indexToggle).toHaveAttribute('aria-expanded', 'false');
      for (const link of await topNavigationLinks.all()) {
        await page.keyboard.press('Tab');
        await expect(link).toBeFocused();
      }
      await page.keyboard.press('Tab');
      await expect(indexToggle).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(indexToggle).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: /WF-01.*특수재난관리청/ })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: /WF-02.*특수기동대/ })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(indexToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('heading', { name: '특수기동대' })).toBeFocused();
      await indexToggle.click();
      await expect(indexToggle).toHaveAttribute('aria-expanded', 'true');
    }

    await page.getByRole('link', { name: /OB-01.*반복 관측 이상/ }).click();
    if (viewport.width === 390) {
      await expect(indexToggle).toHaveAttribute('aria-expanded', 'false');
    }
    await expect(page.locator('.world-document')).toContainText('OB-01');
    await page.getByRole('link', { name: 'CM-05', exact: true }).click();
    await expect(page).toHaveURL(/#\/records\/fracture$/);
    await expect(page.getByRole('heading', { name: '균열' })).toBeVisible();

    await page.goto('./#/world/cheonryeong-restricted');
    const worldPage = page.locator('.world-page');
    await expect(worldPage).toContainText('신원 기록 일부 불일치.');
    await expect(worldPage).toContainText('특정 오염 상황에서 비정상 반응 관측.');
    await expect(worldPage).toContainText('추가 기록 확인 후 해금');
    for (const forbiddenLabel of forbiddenWorldLabels) {
      await expect(worldPage).not.toContainText(forbiddenLabel);
    }

    if (viewport.width === 390) {
      await indexToggle.click();
      await page.getByRole('link', { name: /WF-02.*특수기동대/ }).click();
      await expect(indexToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(page.locator('.world-document')).toContainText('WF-02');
    }
  });
}
