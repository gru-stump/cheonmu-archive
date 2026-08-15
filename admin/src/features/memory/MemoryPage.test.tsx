import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NarrativeApi } from '../../api/narrativeApi';
import { MemoryPage } from './MemoryPage';

const memory = {
  fixedCanon: [{ id: 'canon-1', memoryType: 'canon', content: '고정된 관계 단계', enabled: true, createdAt: '2026-08-01T00:00:00Z', correctionHistory: [] }],
  continuity: [{ id: 'continuity-1', memoryType: 'continuity', content: '치료실의 약속', enabled: true, createdAt: '2026-08-02T00:00:00Z', correctionHistory: [{ id: 'continuity-old', content: '이전 약속', note: '표현 교정', createdAt: '2026-08-01T00:00:00Z' }] }],
  recent: [{ id: 'recent-1', memoryType: 'summary', content: '최근 귀환', enabled: true, createdAt: '2026-08-03T00:00:00Z', correctionHistory: [] }],
  feedback: [{ id: 'feedback-1', memoryType: 'feedback', content: '현대식 농담 금지', enabled: true, createdAt: '2026-08-04T00:00:00Z', correctionHistory: [] }],
  unresolved: [{ id: 'callback-1', memoryType: 'unresolved', content: '돌려주지 못한 비녀', enabled: false, createdAt: '2026-08-05T00:00:00Z', correctionHistory: [] }],
} as const;

function api() {
  return {
    getMemory: vi.fn().mockResolvedValue(memory),
    setMemoryEnabled: vi.fn().mockResolvedValue({ enabled: false }),
    correctMemory: vi.fn().mockResolvedValue({ memoryId: 'continuity-2' }),
  } as unknown as NarrativeApi;
}

describe('MemoryPage', () => {
  it('keeps fixed canon read-only and separates every memory class with correction history', async () => {
    render(<MemoryPage api={api()} />);

    const canon = await screen.findByRole('region', { name: '고정 정사' });
    expect(within(canon).getByText('고정된 관계 단계')).toBeInTheDocument();
    expect(within(canon).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: '연속성 장부' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '최근 기억' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '금지·피드백 기억' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '미회수 요소' })).toBeInTheDocument();
    expect(screen.getByText('이전 약속')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /삭제/ })).not.toBeInTheDocument();
  });

  it('uses enable/disable and appends a correction instead of editing content in place', async () => {
    const client = api();
    const user = userEvent.setup();
    render(<MemoryPage api={client} />);

    await user.click(await screen.findByRole('button', { name: '치료실의 약속 비활성화' }));
    expect(client.setMemoryEnabled).toHaveBeenCalledWith({ memoryId: 'continuity-1', enabled: false });

    await user.click(screen.getByRole('button', { name: '치료실의 약속 교정 추가' }));
    await user.type(screen.getByLabelText('교정 내용'), '치료실에서 다시 만나기로 한 약속');
    await user.type(screen.getByLabelText('교정 사유'), '장소를 명확히 함');
    await user.click(screen.getByRole('button', { name: '교정 이력 저장' }));

    await waitFor(() => expect(client.correctMemory).toHaveBeenCalledWith({
      memoryId: 'continuity-1', content: '치료실에서 다시 만나기로 한 약속', note: '장소를 명확히 함',
    }));
  });

  it('distinguishes a successful mutation from a failed authoritative refresh', async () => {
    const client = api();
    client.getMemory = vi.fn().mockResolvedValueOnce(memory).mockRejectedValueOnce(new Error('refresh failed'));
    const user = userEvent.setup();
    render(<MemoryPage api={client} />);

    await user.click(await screen.findByRole('button', { name: '치료실의 약속 비활성화' }));

    expect(await screen.findByRole('status')).toHaveTextContent('저장했지만 최신 기억을 불러오지 못했습니다');
    expect(screen.queryByText('기억 사용 상태를 저장하지 못했습니다.')).not.toBeInTheDocument();
  });
});
