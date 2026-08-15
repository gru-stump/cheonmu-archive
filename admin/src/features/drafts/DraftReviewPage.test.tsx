import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DraftDetail, NarrativeApi } from '../../api/narrativeApi';
import { NarrativeApiError } from '../../api/narrativeApi';
import { DraftReviewPage } from './DraftReviewPage';

const detail: DraftDetail = {
  id: 'draft-1',
  kind: 'short_dialogue',
  status: 'generated',
  title: '빗소리 아래',
  latestVersionId: 'version-2',
  latestVersion: {
    id: 'version-2',
    versionNumber: 2,
    createdAt: '2026-08-15T03:00:00.000Z',
    content: {
      title: '빗소리 아래',
      body: '천령은 처마 아래에 섰다.\n무영은 말없이 우산을 기울였다.',
      canonChangeCandidates: ['두 사람이 우산을 함께 씀'],
    },
    contextVersionIds: ['canon-v7', 'memory-v3'],
    continuityLevel: 'review',
    continuityFindings: [{ code: 'voice_check', level: 'review', message: '호칭 확인 필요', sourceIds: ['canon-v7'] }],
  },
  versions: [
    { id: 'version-1', versionNumber: 1, createdAt: '2026-08-15T02:00:00.000Z', content: { title: '초안', body: '이전 본문', canonChangeCandidates: [] }, contextVersionIds: ['canon-v7'], continuityLevel: 'review', continuityFindings: [] },
    { id: 'version-2', versionNumber: 2, createdAt: '2026-08-15T03:00:00.000Z', content: { title: '빗소리 아래', body: '천령은 처마 아래에 섰다.\n무영은 말없이 우산을 기울였다.', canonChangeCandidates: ['두 사람이 우산을 함께 씀'] }, contextVersionIds: ['canon-v7', 'memory-v3'], continuityLevel: 'review', continuityFindings: [{ code: 'voice_check', level: 'review', message: '호칭 확인 필요', sourceIds: ['canon-v7'] }] },
  ],
};

function api(overrides: Partial<NarrativeApi> = {}): NarrativeApi {
  return {
    getDashboard: vi.fn(),
    listDrafts: vi.fn(),
    getDraft: vi.fn().mockResolvedValue(detail),
    generate: vi.fn(),
    saveManualVersion: vi.fn(),
    review: vi.fn(),
    retryPublish: vi.fn(),
    archive: vi.fn(),
    ...overrides,
  } as NarrativeApi;
}

describe('DraftReviewPage', () => {
  it('shows final text, findings with sources, context, canon candidates, and full history', async () => {
    render(<DraftReviewPage api={api()} draftId="draft-1" />);

    expect(await screen.findByRole('heading', { name: '빗소리 아래' })).toBeInTheDocument();
    expect(screen.getByText('호칭 확인 필요')).toBeInTheDocument();
    expect(screen.getAllByText('canon-v7').length).toBeGreaterThan(0);
    expect(screen.getByText('memory-v3')).toBeInTheDocument();
    expect(screen.getByText('두 사람이 우산을 함께 씀')).toBeInTheDocument();
    expect(screen.getByText('버전 1')).toBeInTheDocument();
    expect(screen.getByText('버전 2')).toBeInTheDocument();
  });

  it('sends the expected version and preserves local edits after a stale 409', async () => {
    const review = vi.fn().mockRejectedValue(new NarrativeApiError(409, 'stale_review'));
    const user = userEvent.setup();
    render(<DraftReviewPage api={api({ review })} draftId="draft-1" />);

    await screen.findByRole('heading', { name: '빗소리 아래' });
    await user.click(screen.getByRole('button', { name: '직접 수정' }));
    const dialog = screen.getByRole('dialog', { name: '직접 수정' });
    const editor = within(dialog).getByRole('textbox', { name: '최종 본문' });
    await user.clear(editor);
    await user.type(editor, '내가 고친 본문');
    await user.click(within(dialog).getByRole('button', { name: '새 버전 저장' }));
    await user.click(screen.getByRole('button', { name: '비공개 정사 승인' }));

    expect(review).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'draft-1', expectedVersionId: 'version-2', action: 'approve_private' }));
    expect(screen.getByRole('alert')).toHaveTextContent('새 버전이 있습니다');
    expect(screen.getByDisplayValue('내가 고친 본문')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '새로 불러오기' })).toBeInTheDocument();
  });

  it('requires and submits a confirmed focused revision without overwriting the selected version', async () => {
    const generate = vi.fn().mockResolvedValue({ draftId: 'draft-1', versionId: 'version-3', status: 'generated', continuityLevel: 'review' });
    const user = userEvent.setup();
    render(<DraftReviewPage api={api({ generate })} draftId="draft-1" />);
    await screen.findByRole('heading', { name: '빗소리 아래' });

    await user.click(screen.getByRole('button', { name: '부분 AI 수정' }));
    const dialog = screen.getByRole('dialog', { name: '부분 AI 수정' });
    await user.type(within(dialog).getByLabelText('선택한 구절'), '무영은 말없이 우산을 기울였다.');
    await user.type(within(dialog).getByLabelText('수정 지시'), '조금 더 다정한 말투로');
    await user.clear(within(dialog).getByLabelText('최대 출력 토큰'));
    await user.type(within(dialog).getByLabelText('최대 출력 토큰'), '128');
    expect(within(dialog).getByText(/예상 최대 비용.*μUSD/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: /최대 비용을 확인했습니다/ }));
    await user.click(within(dialog).getByRole('button', { name: '새 버전 생성' }));

    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      draftId: 'draft-1', expectedVersionId: 'version-2', mode: 'revise_selection',
      revision: { selectedText: '무영은 말없이 우산을 기울였다.', instruction: '조금 더 다정한 말투로' },
      requestedMaxOutputTokens: 128,
      maximumCostConfirmed: true,
    }));
  });

  it('keeps blocked latest versions inspectable and reject-only', async () => {
    const blocked = { ...detail, latestVersion: { ...detail.latestVersion, continuityLevel: 'block' as const }, status: 'reviewing' as const };
    render(<DraftReviewPage api={api({ getDraft: vi.fn().mockResolvedValue(blocked) })} draftId="draft-1" />);

    expect(await screen.findByText('차단된 버전')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '거절' })).toBeInTheDocument();
    for (const name of ['직접 수정', '부분 AI 수정', '비공개 정사 승인', '승인하고 게시', '보관']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('closes its modal dialog with Escape and restores focus', async () => {
    const user = userEvent.setup();
    render(<DraftReviewPage api={api()} draftId="draft-1" />);
    const trigger = await screen.findByRole('button', { name: '직접 수정' });
    await user.click(trigger);
    expect(screen.getByRole('dialog', { name: '직접 수정' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '직접 수정' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
