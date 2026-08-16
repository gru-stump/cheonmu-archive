import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TodayPage } from './TodayPage';
import type { NarrativeApi } from '../../api/narrativeApi';

describe('TodayPage', () => {
  it('shows daily and monthly spent, reserved and remaining microdollars with schedule outcomes', async () => {
    const api = {
      getDashboard: async () => ({
        budget: {
          dailySpentMicros: 1_200,
          monthlySpentMicros: 8_400,
          reservedMicros: 700,
          dailyRemainingMicros: 18_100,
          monthlyRemainingMicros: 90_900,
        },
        nextScheduleAt: '2026-08-16T00:30:00.000Z',
        lastSuccessAt: '2026-08-15T05:10:00.000Z',
        failures: [
          { id: 'failure-1', occurredAt: '2026-08-15T04:00:00.000Z', code: 'provider_timeout' },
        ],
        queue: [
          { id: 'job-queued', source: 'schedule', state: 'queued', attemptCount: 0, retryAt: null, leaseExpiresAt: null, failureCode: null, scheduledFor: '2026-08-16T00:00:00.000Z' },
          { id: 'job-running', source: 'access', state: 'running', attemptCount: 1, retryAt: null, leaseExpiresAt: '2026-08-16T00:01:30.000Z', failureCode: null, scheduledFor: '2026-08-16T00:00:00.000Z' },
          { id: 'job-retry', source: 'manual', state: 'retry-wait', attemptCount: 2, retryAt: '2026-08-16T00:05:00.000Z', leaseExpiresAt: null, failureCode: 'worker_retry_scheduled', scheduledFor: '2026-08-16T00:00:00.000Z' },
          { id: 'job-dead', source: 'schedule', state: 'failed/dead-letter', attemptCount: 3, retryAt: null, leaseExpiresAt: null, failureCode: 'provider_outcome_unknown', scheduledFor: '2026-08-16T00:00:00.000Z' },
        ],
      }),
    } as NarrativeApi;

    render(<TodayPage api={api} />);

    expect(await screen.findByText('1,200 μUSD')).toBeInTheDocument();
    expect(screen.getByText('8,400 μUSD')).toBeInTheDocument();
    expect(screen.getByText('700 μUSD')).toBeInTheDocument();
    expect(screen.getByText('18,100 μUSD')).toBeInTheDocument();
    expect(screen.getByText('90,900 μUSD')).toBeInTheDocument();
    expect(screen.getByText(/2026\. 8\. 16\..*오전 9:30/)).toBeInTheDocument();
    expect(screen.getByText(/2026\. 8\. 15\..*오후 2:10/)).toBeInTheDocument();
    expect(screen.getByText('provider_timeout')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /generation queue/i })).toBeInTheDocument();
    expect(screen.getByText('schedule · queued · attempt 0')).toBeInTheDocument();
    expect(screen.getByText('access · running · attempt 1')).toBeInTheDocument();
    expect(screen.getByText('manual · retry-wait · attempt 2')).toBeInTheDocument();
    expect(screen.getByText(/worker_retry_scheduled/)).toBeInTheDocument();
    expect(screen.getByText('schedule · failed/dead-letter · attempt 3')).toBeInTheDocument();
    expect(screen.getByText(/provider_outcome_unknown/)).toBeInTheDocument();
    expect(screen.getByText(/lease.*2026\. 8\. 16/)).toBeInTheDocument();
    expect(screen.getByText(/retry.*2026\. 8\. 16/)).toBeInTheDocument();
  });

  it('queues access only after the owner explicitly requests it and refreshes the dashboard', async () => {
    const dashboard = {
      budget: { dailySpentMicros: 0, monthlySpentMicros: 0, reservedMicros: 0, dailyRemainingMicros: 100, monthlyRemainingMicros: 100 },
      nextScheduleAt: null, lastSuccessAt: null, failures: [], queue: [],
    };
    const getDashboard = vi.fn().mockResolvedValue(dashboard);
    const triggerAccess = vi.fn().mockResolvedValue({ id: 'access-job-1', scheduledFor: '2026-08-16T09:00:00Z' });
    const api = { getDashboard, triggerAccess } as unknown as NarrativeApi;

    render(<TodayPage api={api} />);
    await screen.findByRole('button', { name: '접속 생성 요청' });

    expect(triggerAccess).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '접속 생성 요청' }));

    expect(await screen.findByRole('status')).toHaveTextContent('access-job-1');
    expect(triggerAccess).toHaveBeenCalledTimes(1);
    expect(getDashboard).toHaveBeenCalledTimes(2);
  });
});
