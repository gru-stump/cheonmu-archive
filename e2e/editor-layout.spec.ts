import { expect, test } from 'playwright/test';

for (const viewport of [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
]) {
  test(`${viewport.name} editor stays readable without horizontal overflow`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto('./');
    await page.getByRole('button', { name: '첫 조우 편집' }).click();

    const shell = page.locator('.editor-shell');
    const form = page.locator('.editor-form-pane');
    const preview = page.locator('.editor-preview-pane');
    await expect(shell).toBeVisible();
    await expect(form).toBeVisible();
    await expect(preview).toBeVisible();
    await expect(form.getByRole('button', { name: '저장' })).toBeVisible();

    const geometry = await page.evaluate(() => {
      const formPane = document.querySelector<HTMLElement>('.editor-form-pane')!;
      const previewPane = document.querySelector<HTMLElement>('.editor-preview-pane')!;
      const formRect = formPane.getBoundingClientRect();
      const previewRect = previewPane.getBoundingClientRect();
      const clippedControls = Array.from(formPane.querySelectorAll<HTMLElement>('input, button, textarea, select'))
        .filter((control) => control.getClientRects().length > 0)
        .filter((control) => {
          const rect = control.getBoundingClientRect();
          return rect.width <= 0
            || rect.height <= 0
            || rect.left < formRect.left - 1
            || rect.right > formRect.right + 1
            || control.scrollWidth > control.clientWidth + 1;
        })
        .map((control) => control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName);
      const inputFontSizes = Array.from(formPane.querySelectorAll<HTMLElement>('input, textarea, select'))
        .filter((control) => control.getClientRects().length > 0)
        .map((control) => Number.parseFloat(getComputedStyle(control).fontSize));

      return {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        shellScrollWidth: document.querySelector<HTMLElement>('.editor-shell')!.scrollWidth,
        shellClientWidth: document.querySelector<HTMLElement>('.editor-shell')!.clientWidth,
        formScrollWidth: formPane.scrollWidth,
        formClientWidth: formPane.clientWidth,
        previewScrollWidth: previewPane.scrollWidth,
        previewClientWidth: previewPane.clientWidth,
        formTop: formRect.top,
        formBottom: formRect.bottom,
        previewTop: previewRect.top,
        clippedControls,
        inputFontSizes,
      };
    });

    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth + 1);
    expect(geometry.shellScrollWidth).toBeLessThanOrEqual(geometry.shellClientWidth + 1);
    expect(geometry.formScrollWidth).toBeLessThanOrEqual(geometry.formClientWidth + 1);
    expect(geometry.previewScrollWidth).toBeLessThanOrEqual(geometry.previewClientWidth + 1);
    expect(geometry.clippedControls).toEqual([]);
    expect(geometry.inputFontSizes.length).toBeGreaterThan(0);
    expect(Math.min(...geometry.inputFontSizes)).toBeGreaterThanOrEqual(14);
    if (viewport.width >= 700) {
      expect(Math.abs(geometry.formTop - geometry.previewTop)).toBeLessThan(2);
    } else {
      expect(geometry.previewTop).toBeGreaterThanOrEqual(geometry.formBottom - 1);
    }

    await testInfo.attach('geometry', {
      body: JSON.stringify({ viewport, ...geometry }, null, 2),
      contentType: 'application/json',
    });
    console.info(`${viewport.name} geometry ${JSON.stringify(geometry)}`);
    await page.screenshot({ path: testInfo.outputPath(`${viewport.name}-${viewport.width}x${viewport.height}.png`), fullPage: true });
  });
}
