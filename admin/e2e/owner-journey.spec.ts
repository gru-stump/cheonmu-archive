import { expect, test, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  authenticateSeedOwner,
  dispatchGenerationWorker,
  edgePost,
  routeRealNarrativeApi,
  seedOwnerId,
  serviceDelete,
  serviceGet,
  serviceInsert,
  servicePatch,
  startFakeProviderFunctions,
  type LocalOwnerSession,
} from './localOwnerHarness';

const screenshotRoot = path.join('..', '.superpowers', 'sdd', '2026-08-15-cheonmu-narrative-admin', 'screenshots');

async function edgeJson<T>(response: Response, expectedStatus = 200): Promise<T> {
  const body = await response.json().catch(() => ({}));
  expect(response.status, JSON.stringify(body)).toBe(expectedStatus);
  return body as T;
}

async function clearAccessFixture(session: LocalOwnerSession) {
  const jobs = await serviceGet<Array<{ id: string }>>(session.config, `generation_jobs?select=id&schedule_key=eq.${encodeURIComponent(`access:${seedOwnerId}`)}`);
  for (const job of jobs) await servicePatch(session.config, `generation_jobs?id=eq.${job.id}`, { schedule_key: `retired-access-${job.id}` });
  await serviceDelete(session.config, 'schedules?schedule_key=eq.special-date');
}

async function openDraft(page: Page, draftId: string) {
  await page.getByRole('link', { name: '초안' }).click();
  await page.locator(`a[href="/drafts/${draftId}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/drafts/${draftId}$`));
}

async function approvePrivate(page: Page, draftId: string) {
  await openDraft(page, draftId);
  await page.getByRole('button', { name: '비공개 정사 승인' }).click();
  await expect(page.getByRole('status').filter({ hasText: '검토 결과를 저장했습니다.' })).toBeVisible();
}

async function ownerGenerate<T>(page: Page, session: LocalOwnerSession, value: unknown, expectedStatus = 200): Promise<T> {
  const result = await page.evaluate(async ({ accessToken, value }) => {
    const response = await fetch('/api/narrative/generate', {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(value),
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }, { accessToken: session.accessToken, value });
  expect(result.status, JSON.stringify(result.body)).toBe(expectedStatus);
  return result.body as T;
}

test('authenticated owner journey persists budget, private approval, rejection feedback, special date, and major-event order', async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const session = await authenticateSeedOwner(page);
  await routeRealNarrativeApi(page, session);
  await clearAccessFixture(session);
  await serviceDelete(session.config, `budget_entries?owner_id=eq.${seedOwnerId}`);
  await servicePatch(session.config, 'provider_settings?id=eq.12000000-0000-0000-0000-000000000001', {
    max_input_tokens: 4096, max_output_tokens: 1024, max_revision_output_tokens: 256,
    input_cost_micros_per_million: 0, output_cost_micros_per_million: 1_477_540, fixed_cost_micros: 2_686,
  });
  const functions = await startFakeProviderFunctions();
  let accessJobId: string | null = null;
  let rejectedDraftId = '';
  let rejectedReason = '';
  try {
    await page.goto('/?real-owner=1');
    await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible();
    await expect(page.getByLabel('상태: 소유자 세션 · E2E')).toHaveCount(0);
    await servicePatch(session.config, `narrative_admin_settings?owner_id=eq.${seedOwnerId}`, { schedule_automation_enabled: true, manual_call_limit: 10 });

    const accessJob = await edgeJson<{ id: string }>(await edgePost(session, 'run-schedules', { action: 'access' }), 202);
    accessJobId = accessJob.id;
    const accessDraftId = randomUUID();
    await serviceInsert(session.config, 'drafts', { id: accessDraftId, owner_id: seedOwnerId, kind: 'short_dialogue', status: 'queued', title: 'E2E 접속 대화' });
    await servicePatch(session.config, `generation_jobs?id=eq.${accessJob.id}`, { draft_id: accessDraftId });
    const [persistedJob] = await serviceGet<Array<{ id: string; draft_id: string }>>(session.config, `generation_jobs?select=id,draft_id&id=eq.${accessJob.id}`);
    expect(persistedJob?.draft_id).toBe(accessDraftId);
    const generationResponsePromise = dispatchGenerationWorker(session);
    await expect.poll(async () => {
      const pending = await serviceGet<Array<{ amount_micros: number }>>(session.config, `budget_entries?select=amount_micros&generation_job_id=eq.${accessJob.id}&entry_type=eq.reservation`);
      return pending[0]?.amount_micros ?? null;
    }).toBe(4_200);
    await page.reload();
    const reservationSection = page.locator('.admin-section').filter({ has: page.getByRole('heading', { name: '예약 비용' }) });
    await expect(reservationSection).toContainText('4,200 μUSD');
    const generated = await edgeJson<{ outcome: string; jobId: string }>(await generationResponsePromise, 202);
    expect(generated).toEqual({ outcome: 'completed', jobId: accessJob.id });
    const generatedVersions = await serviceGet<Array<{ continuity_level: string }>>(
      session.config,
      `draft_versions?select=continuity_level&generation_job_id=eq.${accessJob.id}`,
    );
    expect(generatedVersions).toEqual([{ continuity_level: 'review' }]);
    await page.reload();
    await expect(page.locator('.admin-section').filter({ has: page.getByRole('heading', { name: '일일 예산' }) })).toContainText('2,700 μUSD');
    await expect(page.locator('.admin-section').filter({ has: page.getByRole('heading', { name: '예약 비용' }) })).toContainText('0 μUSD');

    await openDraft(page, persistedJob!.draft_id);
    const originalBody = await page.locator('.draft-body').textContent();
    await page.getByRole('button', { name: '직접 수정' }).click();
    await page.getByRole('textbox', { name: '최종 본문' }).fill('천령은 빗소리를 듣다가 한 줄을 고쳤다.\n무영은 대답 대신 찻잔을 밀어 두었다.');
    await page.getByRole('button', { name: '새 버전 저장' }).click();
    await expect(page.getByRole('status').filter({ hasText: '새 버전을 저장했습니다.' })).toBeVisible();
    await page.getByRole('button', { name: '비공개 정사 승인' }).click();
    await expect(page.getByRole('status').filter({ hasText: '검토 결과를 저장했습니다.' })).toBeVisible();

    const accessDraft = await serviceGet<Array<{ status: string }>>(session.config, `drafts?select=status&id=eq.${persistedJob!.draft_id}`);
    const accessVersions = await serviceGet<Array<{ version_number: number; content: { body: string } }>>(session.config, `draft_versions?select=version_number,content&draft_id=eq.${persistedJob!.draft_id}&order=version_number.asc`);
    const publishJobs = await serviceGet<unknown[]>(session.config, `publish_jobs?select=id&draft_id=eq.${persistedJob!.draft_id}`);
    const ledger = await serviceGet<Array<{ entry_type: string; amount_micros: number; usage_json: { inputTokens?: number; outputTokens?: number } | null }>>(session.config, `budget_entries?select=entry_type,amount_micros,usage_json&generation_job_id=eq.${accessJob.id}&order=created_at.asc`);
    expect(accessDraft).toEqual([{ status: 'approved_private' }]);
    expect(accessVersions).toHaveLength(2);
    expect(accessVersions[0]?.content.body).toBe(originalBody);
    expect(accessVersions[1]?.content.body).toContain('한 줄을 고쳤다');
    expect(publishJobs).toEqual([]);
    expect(ledger.map((entry) => entry.entry_type)).toEqual(['reservation', 'reconciliation']);
    expect(ledger.map((entry) => Number(entry.amount_micros))).toEqual([4_200, -1_500]);
    expect(ledger.reduce((sum, entry) => sum + Number(entry.amount_micros), 0)).toBe(2_700);
    expect(ledger[1]?.usage_json).toEqual({ inputTokens: 14, outputTokens: 9 });

    const archiveVersionCount = accessVersions.length;
    const archiveMemoryIds = await serviceGet<Array<{ id: string }>>(session.config, `memory_items?select=id&owner_id=eq.${seedOwnerId}&order=id.asc`);
    await openDraft(page, persistedJob!.draft_id);
    await page.getByRole('button', { name: '보관' }).click();
    await expect(page.getByRole('status').filter({ hasText: '초안을 보관했습니다.' })).toBeVisible();
    await page.getByRole('link', { name: '초안' }).click();
    await expect(page.locator(`a[href="/drafts/${persistedJob!.draft_id}"]`)).toHaveCount(0);
    await page.getByRole('button', { name: '보관됨' }).click();
    await page.locator(`a[href="/drafts/${persistedJob!.draft_id}"]`).click();
    await page.getByRole('button', { name: '복원' }).click();
    await expect(page.getByRole('status').filter({ hasText: '초안을 approved_private 상태로 복원했습니다.' })).toBeVisible();
    expect(await serviceGet(session.config, `drafts?select=status&id=eq.${persistedJob!.draft_id}`)).toEqual([{ status: 'approved_private' }]);
    expect(await serviceGet(session.config, `draft_versions?select=id&draft_id=eq.${persistedJob!.draft_id}`)).toHaveLength(archiveVersionCount);
    expect(await serviceGet(session.config, `publish_jobs?select=id&draft_id=eq.${persistedJob!.draft_id}`)).toEqual([]);
    expect(await serviceGet(session.config, `memory_items?select=id&owner_id=eq.${seedOwnerId}&order=id.asc`)).toEqual(archiveMemoryIds);
    expect(await serviceGet(session.config, `audit_events?select=event_type&entity_id=eq.${persistedJob!.draft_id}&event_type=in.(draft_archived,draft_restored)&order=created_at.asc`)).toEqual([{ event_type: 'draft_archived' }, { event_type: 'draft_restored' }]);

    const canonBeforeReject = await serviceGet<Array<{ id: string }>>(session.config, 'memory_items?select=id&memory_type=eq.canon&order=id.asc');
    const rejectedGenerated = await ownerGenerate<{ draftId: string; versionId: string; continuityLevel: string }>(page, session, {
      mode: 'new',
      kind: 'short_dialogue',
      title: `E2E 거절 대화 ${randomUUID()}`,
      seed: '인물의 반응을 더 선명하게',
      tags: ['거절', '대화'],
    });
    rejectedDraftId = rejectedGenerated.draftId;
    rejectedReason = `인물의 반응을 더 선명하게 다듬어 주세요. (${rejectedDraftId})`;
    expect(rejectedGenerated.continuityLevel).toBe('review');
    await openDraft(page, rejectedDraftId);
    await page.getByRole('button', { name: '거절' }).click();
    await page.getByRole('textbox', { name: '거절 사유' }).fill(rejectedReason);
    await page.getByRole('button', { name: '거절 확정' }).click();
    await expect(page.getByRole('status').filter({ hasText: '검토 결과를 저장했습니다.' })).toBeVisible();

    await page.getByRole('link', { name: '일정' }).click();
    await page.getByLabel('daily-local-fixture 서울 실행 시각').fill('10:15');
    await page.getByRole('button', { name: 'daily-local-fixture 일정 저장' }).click();
    await expect(page.getByRole('status').filter({ hasText: '일정을 저장했습니다.' })).toBeVisible();
    const schedule = await serviceGet<Array<{ seoul_time: string }>>(session.config, 'schedules?select=seoul_time&schedule_key=eq.daily-local-fixture');
    expect(schedule[0]?.seoul_time).toMatch(/^10:15/);
    await page.getByRole('button', { name: '특별일 추가' }).click();
    const specialScheduleForm = page.locator('.schedule-row').filter({ has: page.getByRole('heading', { name: 'special-date' }) });
    await expect(specialScheduleForm).toBeVisible();
    await specialScheduleForm.getByLabel('special-date 서울 실행 시각').fill('18:45');
    await specialScheduleForm.getByLabel('특별일').fill('2026-10-03');
    await specialScheduleForm.getByRole('checkbox', { name: '활성' }).check();
    const specialSaveResponsePromise = page.waitForResponse((response) =>
      new URL(response.url()).pathname === '/api/narrative/schedules' && response.request().method() === 'POST');
    await specialScheduleForm.getByRole('button', { name: 'special-date 일정 저장' }).click();
    const specialSaveResponse = await specialSaveResponsePromise;
    expect(specialSaveResponse.status(), await specialSaveResponse.text()).toBe(200);
    await expect(page.getByRole('status').filter({ hasText: '일정을 저장했습니다.' })).toBeVisible();
    await expect(page.getByLabel('special-date 서울 실행 시각')).toHaveValue('18:45');
    await expect(page.getByLabel('특별일')).toHaveValue('2026-10-03');

    const rejectedDraftEvidence = await serviceGet<Array<{ status: string }>>(session.config, `drafts?select=status&id=eq.${rejectedDraftId}`);
    const rejectedJobEvidence = await serviceGet<Array<{ draft_id: string; status: string }>>(session.config, `generation_jobs?select=draft_id,status&draft_id=eq.${rejectedDraftId}&payload->>source=eq.manual`);
    const rejectedFeedbackEvidence = await serviceGet<Array<{ memory_type: string; status: string; content: string; source_draft_version_id: string }>>(
      session.config,
      `memory_items?select=memory_type,status,content,source_draft_version_id&content=eq.${encodeURIComponent(rejectedReason)}`,
    );
    const rejectedReviewEvidence = await serviceGet<Array<{ action: string; reason: string; resulting_state: string; draft_version_id: string }>>(
      session.config,
      `draft_review_actions?select=action,reason,resulting_state,draft_version_id&draft_id=eq.${rejectedDraftId}`,
    );
    const specialScheduleEvidence = await serviceGet<Array<{
      schedule_key: string;
      schedule_type: string;
      enabled: boolean;
      seoul_time: string;
      special_date: string;
      minimum_interval_minutes: number;
      payload: { kind?: string };
    }>>(
      session.config,
      'schedules?select=schedule_key,schedule_type,enabled,seoul_time,special_date,minimum_interval_minutes,payload&schedule_key=eq.special-date',
    );
    expect(rejectedDraftId).not.toBe(persistedJob!.draft_id);
    expect.soft(rejectedDraftEvidence).toEqual([{ status: 'rejected' }]);
    expect.soft(rejectedJobEvidence).toEqual([{ draft_id: rejectedDraftId, status: 'completed' }]);
    expect.soft(rejectedFeedbackEvidence).toEqual([
      expect.objectContaining({
        memory_type: 'feedback',
        status: 'active',
        content: rejectedReason,
        source_draft_version_id: rejectedGenerated.versionId,
      }),
    ]);
    expect.soft(rejectedReviewEvidence).toEqual([{
      action: 'reject',
      reason: rejectedReason,
      resulting_state: 'rejected',
      draft_version_id: rejectedGenerated.versionId,
    }]);
    expect.soft(specialScheduleEvidence).toEqual([
      expect.objectContaining({
        schedule_key: 'special-date',
        schedule_type: 'special',
        enabled: true,
        seoul_time: expect.stringMatching(/^18:45/),
        special_date: '2026-10-03',
        minimum_interval_minutes: 1440,
        payload: expect.objectContaining({ kind: 'short_dialogue' }),
      }),
    ]);
    expect(await serviceGet(session.config, `publish_jobs?select=id&draft_id=eq.${rejectedDraftId}`)).toEqual([]);
    expect(await serviceGet(session.config, `memory_items?select=memory_type&source_draft_version_id=eq.${rejectedGenerated.versionId}`)).toEqual([{ memory_type: 'feedback' }]);
    expect(await serviceGet(session.config, 'memory_items?select=id&memory_type=eq.canon&order=id.asc')).toEqual(canonBeforeReject);

    const proposalGenerated = await ownerGenerate<{ draftId: string; versionId: string }>(page, session, {
      mode: 'new', kind: 'major_event_proposal', title: 'E2E 중대 사건',
      seed: '봉인의 균열과 두 사람의 선택', tags: ['중대 사건', '봉인'],
    });
    const majorDraftId = proposalGenerated.draftId;
    await ownerGenerate(page, session, { draftId: majorDraftId, mode: 'major_event_scene_plan' }, 409);
    await approvePrivate(page, majorDraftId);
    expect(await serviceGet(session.config, `major_event_workflows?select=phase&draft_id=eq.${majorDraftId}`)).toEqual([{ phase: 'proposal_approved' }]);

    await ownerGenerate(page, session, { draftId: majorDraftId, mode: 'major_event_scene_plan' });
    await approvePrivate(page, majorDraftId);
    expect(await serviceGet(session.config, `major_event_workflows?select=phase&draft_id=eq.${majorDraftId}`)).toEqual([{ phase: 'scene_plan_approved' }]);

    await ownerGenerate(page, session, { draftId: majorDraftId, mode: 'major_event_draft' });
    await approvePrivate(page, majorDraftId);
    expect(await serviceGet(session.config, `major_event_workflows?select=phase&draft_id=eq.${majorDraftId}`)).toEqual([{ phase: 'final_approved' }]);
    expect(await serviceGet(session.config, `publish_jobs?select=id&draft_id=eq.${majorDraftId}`)).toEqual([]);
    const majorVersions = await serviceGet<Array<{ version_number: number }>>(session.config, `draft_versions?select=version_number&draft_id=eq.${majorDraftId}&order=version_number.asc`);
    expect(majorVersions.map((version) => version.version_number)).toEqual([1, 2, 3]);
  } finally {
    if (accessJobId) await servicePatch(session.config, `generation_jobs?id=eq.${accessJobId}`, { schedule_key: `retired-access-${accessJobId}` }).catch(() => undefined);
    await servicePatch(session.config, 'provider_settings?id=eq.12000000-0000-0000-0000-000000000001', {
      max_input_tokens: 4096, max_output_tokens: 1024, max_revision_output_tokens: 256,
      input_cost_micros_per_million: 0, output_cost_micros_per_million: 0, fixed_cost_micros: 100,
    }).catch(() => undefined);
    await servicePatch(session.config, `narrative_admin_settings?owner_id=eq.${seedOwnerId}`, { schedule_automation_enabled: false, manual_call_limit: 3 }).catch(() => undefined);
    await serviceDelete(session.config, 'schedules?schedule_key=eq.special-date').catch(() => undefined);
    await functions.stop();
  }
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

test('private styles stay scoped and compact toggles expose keyboard-reachable 44px targets', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/__e2e/visual/accessibility');
  const outside = page.getByTestId('outside-admin-heading');
  await expect(outside).toBeVisible();
  expect(await outside.evaluate((node) => getComputedStyle(node).display)).toBe('block');

  for (const target of await page.locator('.admin-shell .control-target').all()) {
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
  await page.getByRole('checkbox', { name: '수동 생성 허용' }).focus();
  await expect(page.getByRole('checkbox', { name: '수동 생성 허용' })).toBeFocused();
  await page.getByRole('checkbox', { name: '자동 일정 허용' }).focus();
  await expect(page.getByRole('checkbox', { name: '자동 일정 허용' })).toBeFocused();
  const provider = page.getByRole('radio', { name: '로컬 테스트 활성 제공자' });
  await provider.focus();
  await expect(provider).toBeFocused();
});

test('read-only mutation controls are disabled without over-fading their labels or values', async ({ page }) => {
  await page.goto('/__e2e/visual/read-only-settings');
  const controls = page.locator('.settings-form :is(input, select, textarea, button)');
  expect(await controls.count()).toBeGreaterThan(10);
  for (const control of await controls.all()) {
    await expect(control).toBeDisabled();
    expect(Number(await control.evaluate((node) => getComputedStyle(node).opacity))).toBeGreaterThanOrEqual(0.55);
  }
});

test('settings field grid is two-column on desktop and one-column on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/settings');
  const desktopFields = await page.locator('.budget-fields .settings-field').all();
  expect(desktopFields.length).toBeGreaterThanOrEqual(6);
  const desktopFirst = await desktopFields[0]!.boundingBox();
  const desktopSecond = await desktopFields[1]!.boundingBox();
  expect(desktopFirst).not.toBeNull(); expect(desktopSecond).not.toBeNull();
  expect(Math.abs(desktopFirst!.y - desktopSecond!.y)).toBeLessThan(4);
  expect(desktopSecond!.x).toBeGreaterThan(desktopFirst!.x + desktopFirst!.width);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileFirst = await desktopFields[0]!.boundingBox();
  const mobileSecond = await desktopFields[1]!.boundingBox();
  expect(mobileFirst).not.toBeNull(); expect(mobileSecond).not.toBeNull();
  expect(mobileSecond!.y).toBeGreaterThan(mobileFirst!.y + mobileFirst!.height);
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
      if (name === 'settings') {
        await page.getByLabel('월간 예산 USD').evaluate((node) => {
          node.scrollIntoView({ block: 'start' });
          window.scrollBy(0, -140);
        });
        await expect(page.getByLabel('월간 예산 USD')).toBeInViewport();
        await expect(page.getByRole('heading', { name: '비밀 연결' })).toBeInViewport();
      } else if (name === 'schedules' && suffix === '390x844') {
        await page.locator('.schedule-form').first().locator('dl').evaluate((node) => {
          window.scrollTo(0, Math.max(0, node.getBoundingClientRect().top + window.scrollY - 560));
        });
        await expect(page.locator('.schedule-form').first().locator('dl')).toBeInViewport();
        await expect(page.locator('.schedule-form').first().getByRole('button', { name: /일정 저장/ })).toBeInViewport();
      } else await page.evaluate(() => window.scrollTo(0, 0));
      if (suffix === '390x844') {
        const rail = await page.locator('.admin-shell__rail').boundingBox();
        const brand = await page.locator('.admin-shell__brand').boundingBox();
        const nav = await page.locator('.admin-shell__nav').boundingBox();
        expect(rail).not.toBeNull(); expect(brand).not.toBeNull(); expect(nav).not.toBeNull();
        expect(rail!.height).toBeGreaterThanOrEqual(108);
        expect(brand!.width).toBeGreaterThan(180);
        expect(nav!.y).toBeGreaterThanOrEqual(rail!.y + 60);
      }
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
