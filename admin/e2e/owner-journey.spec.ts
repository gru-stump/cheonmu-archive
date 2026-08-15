import { expect, test, type Browser, type Page } from '@playwright/test';
import path from 'node:path';

const screenshotRoot = path.join('..', '.superpowers', 'sdd', '2026-08-15-cheonmu-narrative-admin', 'screenshots');

async function returnToJourney(page: Page) {
  await page.evaluate(() => {
    window.history.pushState({}, '', '/__e2e');
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
  await expect(page.getByRole('heading', { name: '소유자 여정' })).toBeVisible();
}

test('desktop owner journey preserves reservation, private approval, rejection, schedule, and major-event order', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/__e2e');
  await expect(page.getByLabel('상태: 소유자 세션 · E2E')).toBeVisible();
  await expect(page.getByText('최소 생성 간격 경과')).toBeVisible();

  await page.getByRole('button', { name: '접속 생성 시작' }).click();
  await expect(page.getByRole('status').filter({ hasText: '예산 4,200 μUSD 예약' })).toBeVisible();
  await page.getByRole('button', { name: '생성 완료 및 정산' }).click();
  await expect(page.getByRole('status').filter({ hasText: '실제 2,700 μUSD 정산 · 예약 1,500 μUSD 해제' })).toBeVisible();
  await page.getByRole('link', { name: '생성된 짧은 대화 검토' }).click();

  await page.getByRole('button', { name: '직접 수정' }).click();
  const editor = page.getByRole('textbox', { name: '최종 본문' });
  await editor.fill('천령은 빗소리를 듣다가 한 줄을 고쳤다.\n무영은 대답 대신 찻잔을 밀어 두었다.');
  await page.getByRole('button', { name: '새 버전 저장' }).click();
  await expect(page.getByRole('status').filter({ hasText: '새 버전을 저장했습니다.' })).toBeVisible();
  await page.getByRole('button', { name: '비공개 정사 승인' }).click();
  await expect(page.getByRole('status').filter({ hasText: '검토 결과를 저장했습니다.' })).toBeVisible();

  await returnToJourney(page);
  await expect(page.getByText('게시 작업 0건')).toBeVisible();
  await expect(page.getByText('비공개 승인 1건')).toBeVisible();
  await page.getByRole('button', { name: '다른 초안 생성' }).click();
  await page.getByRole('link', { name: '거절할 초안 검토' }).click();
  await page.getByRole('button', { name: '거절' }).click();
  await page.getByLabel('거절 사유').fill('현대식 표현이 인물의 말투와 맞지 않습니다.');
  await page.getByRole('button', { name: '거절 확정' }).click();
  await expect(page.getByRole('status').filter({ hasText: '검토 결과를 저장했습니다.' })).toBeVisible();

  await page.getByRole('link', { name: '일정' }).click();
  await page.getByRole('button', { name: '특별일 추가' }).click();
  await page.getByLabel('특별일').fill('2026-10-03');
  await page.getByRole('button', { name: 'special-date 일정 저장' }).click();
  await expect(page.getByRole('status').filter({ hasText: '일정을 저장했습니다.' })).toBeVisible();
  await expect(page.getByLabel('특별일')).toHaveValue('2026-10-03');

  await returnToJourney(page);
  const scenePlan = page.getByRole('button', { name: '장면 계획 생성' });
  const approvePlan = page.getByRole('button', { name: '장면 계획 승인' });
  const generateDraft = page.getByRole('button', { name: '본문 생성' });
  await expect(scenePlan).toBeDisabled();
  await expect(approvePlan).toBeDisabled();
  await expect(generateDraft).toBeDisabled();
  await page.getByRole('button', { name: '사건 제안 승인' }).click();
  await expect(scenePlan).toBeEnabled();
  await scenePlan.click();
  await expect(approvePlan).toBeEnabled();
  await approvePlan.click();
  await expect(generateDraft).toBeEnabled();
  await generateDraft.click();
  await expect(page.getByRole('status').filter({ hasText: '중대 사건 본문이 비공개 초안으로 생성되었습니다.' })).toBeVisible();
});

test('mobile review keeps actions reachable, traps/restores focus, announces changes, and does not cover prose', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/drafts/e2e-access-draft');
  const disclosure = page.locator('.review-actions__more > summary', { hasText: '작업' });
  await expect(disclosure).toBeVisible();
  await disclosure.click();
  const manual = page.getByRole('button', { name: '직접 수정' });
  await manual.focus();
  await expect(manual).toBeFocused();
  await manual.click();
  await expect(page.getByRole('dialog', { name: '직접 수정' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: '최종 본문' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: '닫기' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(manual).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => manual.evaluate((node) => getComputedStyle(node).transitionDuration)).toBe('0s');
  await page.getByRole('button', { name: '비공개 정사 승인' }).click();
  await expect(page.getByRole('status').filter({ hasText: '검토 결과를 저장했습니다.' })).toBeVisible();
  await page.locator('.draft-body').evaluate((node) => node.scrollIntoView({ block: 'end' }));
  const proseEnd = await page.locator('.draft-body').boundingBox();
  const actionBar = await page.locator('.review-actions').boundingBox();
  expect(proseEnd).not.toBeNull();
  expect(actionBar).not.toBeNull();
  expect(proseEnd!.y + proseEnd!.height).toBeLessThanOrEqual(actionBar!.y);
});

async function captureViewport(browser: Browser, width: number, height: number, suffix: string) {
  const views = [
    ['today', '/'], ['draft-index', '/drafts'], ['draft-review', '/drafts/e2e-access-draft'],
    ['memory', '/memory'], ['schedules', '/schedules'], ['settings', '/settings'],
    ['loading', '/__e2e/visual/loading'], ['empty', '/__e2e/visual/empty'], ['error', '/__e2e/visual/error'],
    ['success', '/__e2e/visual/success'], ['blocked', '/drafts/e2e-blocked-draft'],
    ['read-only', '/__e2e/visual/read-only'], ['focus', '/__e2e/visual/focus'],
  ] as const;
  for (const [name, url] of views) {
    const page = await browser.newPage({ baseURL: 'http://127.0.0.1:4184', viewport: { width, height } });
    try {
      await page.goto(url);
      await expect(page.locator('.admin-shell')).toBeVisible();
      if (name === 'blocked') {
        await expect(page.getByRole('button', { name: '거절' })).toBeVisible();
        await expect(page.getByRole('button', { name: '승인하고 게시' })).toHaveCount(0);
      }
      await page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      });
      await page.evaluate(() => window.scrollTo(0, 0));
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      await page.screenshot({ animations: 'disabled' });
      await page.screenshot({ path: path.join(screenshotRoot, `${name}-${suffix}.png`), animations: 'disabled' });
    } finally {
      await page.close();
    }
  }
}

test('captures and guards desktop acceptance views', async ({ browser }) => {
  await captureViewport(browser, 1440, 1000, '1440x1000');
});

test('captures and guards mobile acceptance views without clipping', async ({ browser }) => {
  await captureViewport(browser, 390, 844, '390x844');
});
