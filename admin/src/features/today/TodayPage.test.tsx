import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TodayPage } from './TodayPage';
import { NarrativeApiError, type DashboardData, type NarrativeApi } from '../../api/narrativeApi';

const baseDashboard: DashboardData = {
  krwPerUsd: 1380,
  budget: { dailySpentMicros: 1200, monthlySpentMicros: 8400, dailyUnconfirmedMicros: 0, monthlyUnconfirmedMicros: 0, reservedMicros: 700, dailyRemainingMicros: 18100, monthlyRemainingMicros: 90900 },
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

  it.each([
    ['budget_risk', '설정한 예산 한도에 가까워 생성하지 않았습니다. 예산 설정을 확인해 주세요.'],
    ['stale_provider_pricing', 'AI 요금 정보가 오래되었습니다. 설정에서 모델 정보를 다시 불러와 저장해 주세요.'],
    ['manual_generation_disabled', '설정에서 수동 생성을 켜고 사용할 AI 모델을 확인해 주세요.'],
  ])('explains the access failure %s without blaming an API key', async (code, expectedMessage) => {
    const api = {
      getDashboard: vi.fn().mockResolvedValue({ ...baseDashboard, queue: [] }),
      estimateAccess: vi.fn().mockResolvedValue({ maximumCostMicros: 4200, maximumCostKrw: 6, modelLabel: 'GPT-5 mini' }),
      triggerAccess: vi.fn().mockRejectedValue(new NarrativeApiError(409, code)),
    } as unknown as NarrativeApi;
    const user = userEvent.setup();
    render(<TodayPage api={api} />);

    await user.click(await screen.findByRole('button', { name: '접속 이야기 만들기' }));
    await user.click(await screen.findByRole('button', { name: '최대 6원으로 만들기' }));

    expect(await screen.findByRole('status')).toHaveTextContent(expectedMessage);
    expect(screen.getByRole('status')).not.toHaveTextContent('API 키');
  });

  it('separates an unknown provider charge from confirmed usage', async () => {
    const client = {
      getDashboard: vi.fn().mockResolvedValue({
        ...baseDashboard,
        budget: {
          ...baseDashboard.budget,
          dailySpentMicros: 6_144,
          monthlySpentMicros: 6_144,
          dailyUnconfirmedMicros: 6_144,
          monthlyUnconfirmedMicros: 6_144,
          reservedMicros: 0,
        },
        queue: [{ ...baseDashboard.queue[3], source: 'access', failureCode: 'provider_output_limit', unconfirmedMaximumCostMicros: 6_144 }],
      }),
    } as unknown as NarrativeApi;

    render(<TodayPage api={client} />);

    expect(await screen.findByRole('region', { name: '오늘 사용' })).toHaveTextContent('확정 사용0원');
    expect(screen.getByRole('region', { name: '확인되지 않은 최대 비용' })).toHaveTextContent('8원');
    expect(screen.getByRole('region', { name: '확인되지 않은 최대 비용' })).toHaveTextContent('실제 결제액으로 확정된 금액이 아닙니다');
    const failed = screen.getByText('접속 이야기 생성 중단').closest('li')!;
    expect(failed).toHaveTextContent('확인되지 않은 최대 비용 8원');
  });
});
