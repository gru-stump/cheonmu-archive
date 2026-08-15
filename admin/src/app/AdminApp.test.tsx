import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NarrativeApi } from '../api/narrativeApi';
import type { AuthClient } from '../auth/AuthGate';
import { LocalPreviewApp, localPreviewAuth } from '../preview/LocalPreviewApp';
import { localPreviewApi } from '../preview/localPreviewApi';

const previewDraftId = 'local-preview-draft-rain';

function signedOutClient(): AuthClient {
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
      signInWithOtp: vi.fn(),
      signOut: vi.fn(),
    },
    ownerProfiles: { findByOwnerId: vi.fn() },
  };
}

function previewApi(): NarrativeApi {
  const version = {
    id: 'local-preview-version-rain', versionNumber: 1, createdAt: '2026-08-15T03:00:00Z',
    content: { title: '비 갠 뒤의 약속', body: '천령과 무영은 젖은 처마 아래에서 조용히 웃었다.', canonChangeCandidates: [] },
    contextVersionIds: ['local-preview-canon'], continuityLevel: 'pass' as const, continuityFindings: [],
  };
  const forbidden = vi.fn().mockRejectedValue(new Error('local_preview_read_only'));
  return {
    getDashboard: vi.fn().mockResolvedValue({ budget: { dailySpentMicros: 1200, monthlySpentMicros: 8400, reservedMicros: 300, dailyRemainingMicros: 18800, monthlyRemainingMicros: 91600 }, nextScheduleAt: '2026-08-16T00:00:00Z', lastSuccessAt: '2026-08-15T03:00:00Z', failures: [] }),
    listDrafts: vi.fn().mockResolvedValue([{ id: previewDraftId, kind: 'short_dialogue', status: 'generated', title: '비 갠 뒤의 약속', updatedAt: '2026-08-15T03:00:00Z', latestVersionId: version.id, continuityLevel: 'pass' }]),
    getDraft: vi.fn().mockResolvedValue({ id: previewDraftId, kind: 'short_dialogue', status: 'generated', title: '비 갠 뒤의 약속', latestVersionId: version.id, latestVersion: version, versions: [version] }),
    getMemory: vi.fn().mockResolvedValue({ fixedCanon: [{ id: 'local-preview-canon', memoryType: 'canon', content: '천령과 무영의 유대는 비공개다.', enabled: true, createdAt: '2026-08-01T00:00:00Z', correctionHistory: [] }], continuity: [{ id: 'local-preview-continuity', memoryType: 'continuity', content: '비 오는 날 다시 만나기로 약속했다.', enabled: true, createdAt: '2026-08-14T00:00:00Z', correctionHistory: [] }], recent: [], feedback: [], unresolved: [] }),
    getSchedules: vi.fn().mockResolvedValue({ schedules: [{ id: 'local-preview-schedule', scheduleKey: 'daily', scheduleType: 'automatic', enabled: true, seoulTime: '09:00', weekday: null, specialDate: null, minimumIntervalMinutes: 1440, kind: 'daily_event', lastRunAt: '2026-08-15T00:00:00Z', nextRunAt: '2026-08-16T00:00:00Z' }] }),
    getSettings: vi.fn().mockResolvedValue({ automationEnabled: false, pricingValidDays: 30, providers: [], budget: { monthlyLimitMicros: 100000000, dailyLimitMicros: 20000000, spentMicros: 8400, reservedMicros: 300, manualCallLimit: 3, warningThresholdPercent: 80, riskThresholdPercent: 95, krwPerUsd: 1380 }, secrets: { openai: false, anthropic: false, github: false } }),
    generate: forbidden, saveManualVersion: forbidden, review: forbidden, retryPublish: forbidden,
    archive: forbidden, setMemoryEnabled: forbidden, correctMemory: forbidden,
    saveSchedule: forbidden, saveSettings: forbidden, saveSecret: forbidden,
  } as NarrativeApi;
}

describe('AdminApp local preview composition', () => {
  afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); vi.restoreAllMocks(); });

  it('shows and enters preview with explicitly injected preview auth and API', async () => {
    const api = previewApi();
    const user = userEvent.setup();
    render(<LocalPreviewApp client={signedOutClient()} previewAuth={localPreviewAuth} previewApi={api} />);
    await user.click(await screen.findByRole('button', { name: '둘러보기' }));
    expect(await screen.findByText('로컬 둘러보기 · 저장되지 않음')).toBeInTheDocument();
    expect(screen.queryByLabelText('이메일')).not.toBeInTheDocument();
  });

  it('navigates every preview page and draft detail with all mutations inaccessible', async () => {
    const api = localPreviewApi;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const user = userEvent.setup();
    render(<LocalPreviewApp client={signedOutClient()} previewAuth={localPreviewAuth} previewApi={api} />);
    await user.click(await screen.findByRole('button', { name: '둘러보기' }));

    expect(await screen.findByRole('heading', { name: '오늘' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: '초안' }));
    await user.click(await screen.findByRole('link', { name: /비 갠 뒤의 약속/ }));
    expect((await screen.findAllByText('천령과 무영은 젖은 처마 아래에서 조용히 웃었다.')).length).toBeGreaterThan(0);
    for (const name of ['직접 수정', '부분 AI 수정', '비공개 정사 승인', '승인하고 게시', '거절', '보관']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }

    await user.click(screen.getByRole('link', { name: '기억' }));
    expect(await screen.findByText('비 오는 날 다시 만나기로 약속했다.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /비활성화|활성화|교정 추가/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('link', { name: '일정' }));
    expect(await screen.findByDisplayValue('09:00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '특별일 추가' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'daily 일정 저장' })).toBeDisabled();

    await user.click(screen.getByRole('link', { name: '설정' }));
    const settings = await screen.findByRole('heading', { name: '설정' });
    expect(settings).toBeInTheDocument();
    for (const name of ['설정 저장', 'OpenAI 비밀 저장', 'Anthropic 비밀 저장', 'GitHub 비밀 저장']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByText('로컬 둘러보기 · 저장되지 않음')).toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
