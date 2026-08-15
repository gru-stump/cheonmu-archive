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
      .mockResolvedValueOnce([{ id: 'archive-1', kind: 'short_dialogue', status: 'archived', title: '보관된 초안', updatedAt: '2026-08-14T03:00:00Z', latestVersionId: 'version-2', continuityLevel: 'pass' }]);
    render(<MemoryRouter><DraftListPage api={{ listDrafts } as unknown as NarrativeApi} /></MemoryRouter>);

    expect(await screen.findByRole('link', { name: /검토 중 초안/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '보관됨' }));

    expect(await screen.findByRole('link', { name: /보관된 초안/ })).toBeInTheDocument();
    expect(listDrafts).toHaveBeenNthCalledWith(1, { status: 'active' });
    expect(listDrafts).toHaveBeenNthCalledWith(2, { status: 'archived' });
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
