import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
  });
});
