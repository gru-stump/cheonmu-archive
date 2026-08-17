import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NarrativeApi } from '../../api/narrativeApi';
import { MemoryRouter } from 'react-router-dom';
import { DraftListPage } from './DraftListPage';

describe('DraftListPage', () => {
  it('switches from active drafts to the archived listing', async () => {
    const listDrafts = vi.fn()
      .mockResolvedValueOnce([{ id: 'active-1', kind: 'short_dialogue', status: 'generated', title: '검토 중 초안', updatedAt: '2026-08-15T03:00:00Z', latestVersionId: 'version-1', continuityLevel: 'review' }])
      .mockResolvedValueOnce([{ id: 'rejected-1', kind: 'short_dialogue', status: 'rejected', title: '거절된 초안', updatedAt: '2026-08-17T01:28:00Z', latestVersionId: 'version-r', continuityLevel: 'review' }])
      .mockResolvedValueOnce([{ id: 'archive-1', kind: 'short_dialogue', status: 'archived', title: '보관된 초안', updatedAt: '2026-08-14T03:00:00Z', latestVersionId: 'version-2', continuityLevel: 'pass' }]);
    render(<MemoryRouter><DraftListPage api={{ listDrafts } as unknown as NarrativeApi} /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: /검토 중 초안/ })).toBeInTheDocument();
    expect(screen.getByText('짧은 대화')).toBeInTheDocument();
    expect(screen.getByText('새 초안')).toBeInTheDocument();
    expect(screen.getByText(/검토가 필요한 초안 · 1편/)).toBeInTheDocument();
    expect(screen.getByText('이어짐 확인 필요')).toBeInTheDocument();
    expect(screen.getByText('2026.08.15 12:00')).toBeInTheDocument();
    expect(screen.queryByText(/short_dialogue|generated|continuity|review/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '거절됨' }));
    expect(await screen.findByRole('link', { name: /거절된 초안/ })).toBeInTheDocument();
    expect(screen.getByLabelText('상태: 거절됨')).toBeInTheDocument();
    expect(screen.getByText('거절 사유 반영됨')).toBeInTheDocument();
    expect(screen.queryByText('이어짐 확인 필요')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '보관됨' }));

    expect(await screen.findByRole('link', { name: /보관된 초안/ })).toBeInTheDocument();
    expect(listDrafts).toHaveBeenNthCalledWith(1, { status: 'active' });
    expect(listDrafts).toHaveBeenNthCalledWith(2, { status: 'rejected' });
    expect(listDrafts).toHaveBeenNthCalledWith(3, { status: 'archived' });
  });

  it('retries the real list request and recovers from an initial route error', async () => {
    const listDrafts = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce([{ id: 'draft-1', kind: 'short_dialogue', status: 'generated', title: '회복된 초안', updatedAt: '2026-08-15T03:00:00Z', latestVersionId: 'version-1', continuityLevel: 'pass' }]);
    render(<MemoryRouter><DraftListPage api={{ listDrafts } as unknown as NarrativeApi} /></MemoryRouter>);

    expect(await screen.findByRole('alert')).toHaveTextContent('초안 목록을 불러오지 못했습니다.');
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));

    expect(await screen.findByRole('link', { name: /회복된 초안/ })).toBeInTheDocument();
    expect(listDrafts).toHaveBeenCalledTimes(2);
  });
});
