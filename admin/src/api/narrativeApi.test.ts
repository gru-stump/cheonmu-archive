import { describe, expect, it, vi } from 'vitest';
import { createNarrativeApi, NarrativeApiError } from './narrativeApi';

describe('NarrativeApi', () => {
  it('uses only same-origin routes with the current owner bearer token', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ drafts: [] }));
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await api.listDrafts();

    expect(fetch).toHaveBeenCalledWith('/api/narrative/drafts', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer owner-token' }),
    }));
  });

  it('sends immutable-version and focused-revision concurrency fields', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ version: { id: 'v3' } }))
      .mockResolvedValueOnce(Response.json({ draftId: 'd1', versionId: 'v4', status: 'generated', continuityLevel: 'review' }));
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await api.saveManualVersion({ draftId: 'd1', expectedVersionId: 'v2', expectedState: 'reviewing', content: { title: '제목', body: '수정문', canonChangeCandidates: [] } });
    await api.generate({ draftId: 'd1', expectedVersionId: 'v3', expectedState: 'reviewing', mode: 'revise_selection', kind: 'short_dialogue', revision: { selectedText: '선택', instruction: '수정' }, requestedMaxOutputTokens: 128, maximumCostConfirmed: true, confirmedMaximumCostMicros: 321 });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ expectedVersionId: 'v2', expectedState: 'reviewing' });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      expectedVersionId: 'v3', requestedMaxOutputTokens: 128, maximumCostConfirmed: true, confirmedMaximumCostMicros: 321,
      revision: { selectedText: '선택', instruction: '수정' },
    });
  });

  it.each([
    [{ mode: 'new', kind: 'short_dialogue', title: '새 대화', seed: '비', tags: ['약속'] }, 'new'],
    [{ draftId: 'major-1', mode: 'major_event_scene_plan' }, 'major_event_scene_plan'],
    [{ draftId: 'major-1', mode: 'major_event_draft' }, 'major_event_draft'],
  ] as const)('sends an owner manual %s request through the authenticated same-origin boundary', async (command, mode) => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ draftId: 'd1', versionId: 'v1', status: 'generated', continuityLevel: 'review' }));
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await api.generate(command as never);

    expect(fetch).toHaveBeenCalledWith('/api/narrative/generate', expect.objectContaining({
      method: 'POST', body: JSON.stringify(command), headers: expect.objectContaining({ authorization: 'Bearer owner-token' }),
    }));
    expect(mode).toBe(command.mode);
  });

  it('surfaces a stable 409 conflict without retrying or fetching replacement data', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: 'stale_review' }, { status: 409 }));
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await expect(api.review({ draftId: 'd1', expectedVersionId: 'v2', expectedState: 'generated', action: 'approve_private' }))
      .rejects.toEqual(new NarrativeApiError(409, 'stale_review'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported generation modes before a browser request is sent', async () => {
    const fetch = vi.fn();
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await expect(api.generate({
      draftId: 'd1', mode: 'browser_owned_mode', kind: 'short_dialogue', seed: 'seed',
    } as never)).rejects.toEqual(new NarrativeApiError(400, 'unsupported_generation_mode'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unsafe archive source states before a browser request is sent', async () => {
    const fetch = vi.fn();
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await expect(api.archive({ draftId: 'd1', expectedVersionId: 'v2', expectedState: 'publishing' } as never))
      .rejects.toEqual(new NarrativeApiError(400, 'invalid_archive_state'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends archived restore through the authenticated same-origin boundary with the exact version', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'approved_private' }));
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await api.restore({ draftId: 'd1', expectedVersionId: 'v2' });

    expect(fetch).toHaveBeenCalledWith('/api/narrative/drafts/d1/restore', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ draftId: 'd1', expectedVersionId: 'v2' }),
      headers: expect.objectContaining({ authorization: 'Bearer owner-token' }),
    }));
  });

  it('keeps publish retry selectors on the authenticated same-origin server boundary', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ status: 'published' }));
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await api.retryPublish({ draftId: 'd1', expectedVersionId: 'v2', expectedState: 'publish_failed' });

    expect(fetch).toHaveBeenCalledWith('/api/narrative/drafts/d1/retry-publish', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ draftId: 'd1', expectedVersionId: 'v2', expectedState: 'publish_failed' }),
      headers: expect.objectContaining({ authorization: 'Bearer owner-token' }),
    }));
  });

  it('keeps every Task 3 read and mutation on the authenticated same-origin boundary', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ fixedCanon: [], continuity: [], recent: [], feedback: [], unresolved: [] }))
      .mockResolvedValueOnce(Response.json({ schedules: [] }))
      .mockResolvedValueOnce(Response.json({ providers: [], budget: {}, secrets: {} }))
      .mockResolvedValueOnce(Response.json({ enabled: false }))
      .mockResolvedValueOnce(Response.json({ memoryId: 'memory-2' }))
      .mockResolvedValueOnce(Response.json({ scheduleId: 'schedule-1' }))
      .mockResolvedValueOnce(Response.json({ saved: true }))
      .mockResolvedValueOnce(Response.json({ configured: true }));
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await api.getMemory();
    await api.getSchedules();
    await api.getSettings();
    await api.setMemoryEnabled({ memoryId: 'memory-1', enabled: false });
    await api.correctMemory({ memoryId: 'memory-1', content: '교정본', note: '사유' });
    await api.saveSchedule({ scheduleId: 'schedule-1', scheduleKey: 'daily', scheduleType: 'automatic', enabled: true, seoulTime: '09:00', weekday: null, specialDate: null, minimumIntervalMinutes: 60, kind: 'daily_event' });
    await api.saveSettings({ manualGenerationEnabled: true, scheduleAutomationEnabled: false, activeProviderKey: 'openai', pricingValidDays: 30, providers: [], monthlyLimitMicros: 10_000_000, dailyLimitMicros: 1_000_000, manualCallLimit: 3, warningThresholdPercent: 80, riskThresholdPercent: 95, krwPerUsd: 1380 });
    await api.saveSecret({ kind: 'github', value: 'one-time-value' });

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      '/api/narrative/memory', '/api/narrative/schedules', '/api/narrative/settings',
      '/api/narrative/memory/memory-1/enabled', '/api/narrative/memory/memory-1/corrections',
      '/api/narrative/schedules/schedule-1', '/api/narrative/settings', '/api/narrative/settings/secret',
    ]);
    expect(fetch.mock.calls.every(([, init]) => new Headers(init?.headers).get('authorization') === 'Bearer owner-token')).toBe(true);
  });
});
