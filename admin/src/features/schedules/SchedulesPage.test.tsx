import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NarrativeApi } from '../../api/narrativeApi';
import { SchedulesPage } from './SchedulesPage';

function api() {
  return {
    getSchedules: vi.fn().mockResolvedValue({ schedules: [
      { id: 'daily-1', scheduleKey: 'daily', scheduleType: 'automatic', enabled: true, seoulTime: '09:00', weekday: null, specialDate: null, minimumIntervalMinutes: 60, kind: 'daily_event', lastRunAt: '2026-08-14T00:00:00Z', nextRunAt: '2026-08-15T00:00:00Z' },
      { id: 'special-1', scheduleKey: 'birthday', scheduleType: 'special', enabled: true, seoulTime: '21:30', weekday: null, specialDate: '2026-09-07', minimumIntervalMinutes: 1440, kind: 'short_dialogue', lastRunAt: null, nextRunAt: '2026-09-07T12:30:00Z' },
    ] }),
    saveSchedule: vi.fn().mockResolvedValue({ scheduleId: 'daily-1' }),
  } as unknown as NarrativeApi;
}

describe('SchedulesPage', () => {
  it('shows editable Seoul time, special dates, minimum interval, last run, and next run', async () => {
    render(<SchedulesPage api={api()} />);

    expect(await screen.findByRole('heading', { name: '일정' })).toBeInTheDocument();
    expect(screen.getByDisplayValue('09:00')).toBeInTheDocument();
    expect(screen.getByDisplayValue('2026-09-07')).toBeInTheDocument();
    expect(screen.getAllByText('최소 간격(분)').length).toBeGreaterThan(0);
    expect(screen.getByText(/2026\. 8\. 14\. 오전 9:00/)).toBeInTheDocument();
    expect(screen.getByText(/2026\. 9\. 7\. 오후 9:30/)).toBeInTheDocument();
  });

  it('saves the displayed local time without converting it in the browser', async () => {
    const client = api();
    const user = userEvent.setup();
    render(<SchedulesPage api={client} />);
    const time = await screen.findByLabelText('daily 서울 실행 시각');
    await user.clear(time);
    await user.type(time, '10:15');
    await user.click(screen.getByRole('button', { name: 'daily 일정 저장' }));

    await waitFor(() => expect(client.saveSchedule).toHaveBeenCalledWith(expect.objectContaining({
      scheduleId: 'daily-1', seoulTime: '10:15', minimumIntervalMinutes: 60,
    })));
  });

  it('reports saved state separately when the authoritative refresh fails', async () => {
    const client = api();
    client.getSchedules = vi.fn().mockResolvedValueOnce(await api().getSchedules()).mockRejectedValueOnce(new Error('refresh failed'));
    const user = userEvent.setup();
    render(<SchedulesPage api={client} />);

    await user.click(await screen.findByRole('button', { name: 'daily 일정 저장' }));

    expect(await screen.findByRole('status')).toHaveTextContent('저장했지만 최신 일정을 불러오지 못했습니다');
    expect(screen.queryByText(/일정을 저장하지 못했습니다/)).not.toBeInTheDocument();
  });

  it('disables every schedule mutation control in read-only preview', async () => {
    const { container } = render(<SchedulesPage api={api()} readOnly />);
    await screen.findByDisplayValue('09:00');

    for (const control of container.querySelectorAll('input, select, button')) expect(control).toBeDisabled();
  });

  it('retries the real schedules request and recovers from an initial route error', async () => {
    const client = api();
    client.getSchedules = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(await api().getSchedules());
    render(<SchedulesPage api={client} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('일정을 불러오지 못했습니다.');
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));

    expect(await screen.findByDisplayValue('09:00')).toBeInTheDocument();
    expect(client.getSchedules).toHaveBeenCalledTimes(2);
  });
});
