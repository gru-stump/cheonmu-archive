import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TodayPage } from './TodayPage';
import type { DashboardData, NarrativeApi } from '../../api/narrativeApi';

const baseDashboard: DashboardData = {
  krwPerUsd: 1380,
  budget: { dailySpentMicros: 1200, monthlySpentMicros: 8400, reservedMicros: 700, dailyRemainingMicros: 18100, monthlyRemainingMicros: 90900 },
  nextScheduleAt: '2026-08-16T00:30:00.000Z',
  lastSuccessAt: '2026-08-15T05:10:00.000Z',
  failures: [{ id: 'failure-1', occurredAt: '2026-08-15T04:00:00.000Z', code: 'provider_timeout' }],
  queue: [
    { id: 'job-queued', source: 'access', state: 'queued', attemptCount: 0, retryAt: null, leaseExpiresAt: null, failureCode: null, scheduledFor: '2026-08-16T13:14:00Z', createdAt: '2026-08-16T13:14:00Z', completedAt: null, failedAt: null },
    { id: 'job-running', source: 'access', state: 'running', attemptCount: 1, retryAt: null, leaseExpiresAt: '2026-08-16T13:16:00Z', failureCode: null, scheduledFor: '2026-08-16T13:13:00Z', createdAt: '2026-08-16T13:13:00Z', completedAt: null, failedAt: null },
    { id: 'job-retry', source: 'manual', state: 'retry-wait', attemptCount: 2, retryAt: '2026-08-16T13:20:00Z', leaseExpiresAt: null, failureCode: 'worker_retry_scheduled', scheduledFor: '2026-08-16T13:10:00Z', createdAt: '2026-08-16T13:10:00Z', completedAt: null, failedAt: null },
    { id: 'job-dead', source: 'schedule', state: 'failed/dead-letter', attemptCount: 3, retryAt: null, leaseExpiresAt: null, failureCode: 'provider_outcome_unknown', scheduledFor: '2026-08-16T13:00:00Z', createdAt: '2026-08-16T13:00:00Z', completedAt: null, failedAt: '2026-08-16T13:12:00Z' },
  ],
};

describe('TodayPage plain-language owner flow', () => {
  it('explains generation state in Korean with exact Seoul timestamps and hides raw codes', async () => {
    const cancelGenerationJob = vi.fn().mockResolvedValue({ status: 'cancelled' });
    const api = { getDashboard: vi.fn().mockResolvedValue(baseDashboard), cancelGenerationJob } as unknown as NarrativeApi;
    render(<TodayPage api={api} now={() => new Date('2026-08-16T13:20:00Z')} />);

    expect(await screen.findByRole('heading', { name: '이야기 생성 현황' })).toBeInTheDocument();
    expect(screen.getByText('접속 이야기 생성 대기 중')).toBeInTheDocument();
    expect(screen.getByText('접속 이야기 생성 중')).toBeInTheDocument();
    expect(screen.getByText('직접 요청한 이야기 다시 시도 대기 중')).toBeInTheDocument();
    expect(screen.getByText('예약 이야기 생성 중단')).toBeInTheDocument();
    expect(screen.getAllByText('2026.08.16 22:14').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Generation queue|access · queued|provider_outcome_unknown|worker_retry_scheduled/)).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '오늘 사용' })).toHaveTextContent('2원');
    expect(screen.queryByText(/비용 단위|μUSD/)).not.toBeInTheDocument();

    const queued = screen.getByText('접속 이야기 생성 대기 중').closest('li')!;
    expect(within(queued).getByRole('button', { name: '대기 취소' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '대기 취소' })).toHaveLength(1);
    await userEvent.click(within(queued).getByRole('button', { name: '대기 취소' }));
    await waitFor(() => expect(cancelGenerationJob).toHaveBeenCalledWith('job-queued'));
  });

  it('shows an exact maximum cost before creating one access job', async () => {
    const getDashboard = vi.fn().mockResolvedValue({ ...baseDashboard, queue: [] });
    const estimateAccess = vi.fn().mockResolvedValue({ maximumCostMicros: 4200, maximumCostKrw: 6, modelLabel: 'GPT-5 mini' });
    const triggerAccess = vi.fn().mockResolvedValue({ id: 'access-job-1', scheduledFor: '2026-08-16T13:14:00Z', dispatchState: 'started' });
    const api = { getDashboard, estimateAccess, triggerAccess } as unknown as NarrativeApi;
    const user = userEvent.setup();
    render(<TodayPage api={api} />);

    await user.click(await screen.findByRole('button', { name: '접속 이야기 만들기' }));
    expect(await screen.findByRole('dialog', { name: '접속 이야기 비용 확인' })).toHaveTextContent('GPT-5 mini');
    expect(screen.getByRole('dialog')).toHaveTextContent('최대 6원');
    expect(triggerAccess).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '취소' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '접속 이야기 만들기' }));
    await user.click(await screen.findByRole('button', { name: '최대 6원으로 만들기' }));
    await waitFor(() => expect(triggerAccess).toHaveBeenCalledWith({ maximumCostConfirmed: true, confirmedMaximumCostMicros: 4200 }));
    expect(await screen.findByRole('status')).toHaveTextContent('이야기 생성을 시작했습니다');
    expect(getDashboard).toHaveBeenCalledTimes(2);
  });
});
