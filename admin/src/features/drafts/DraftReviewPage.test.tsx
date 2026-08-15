import { render, screen, waitFor, within } from '@testing-library/react';
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

  it('keeps a manual edit and exposes keyboard conflict recovery inside its active dialog', async () => {
    const saveManualVersion = vi.fn().mockRejectedValue(new NarrativeApiError(409, 'stale_manual_version'));
    const getDraft = vi.fn().mockResolvedValue(detail);
    const user = userEvent.setup();
    render(<DraftReviewPage api={api({ getDraft, saveManualVersion })} draftId="draft-1" />);

    await screen.findByRole('heading', { name: '빗소리 아래' });
    await user.click(screen.getByRole('button', { name: '직접 수정' }));
    const dialog = screen.getByRole('dialog', { name: '직접 수정' });
    const editor = within(dialog).getByRole('textbox', { name: '최종 본문' });
    await user.clear(editor);
    await user.type(editor, '내가 고친 본문');
    await user.click(within(dialog).getByRole('button', { name: '새 버전 저장' }));

    expect(saveManualVersion).toHaveBeenCalledWith(expect.objectContaining({ draftId: 'draft-1', expectedVersionId: 'version-2' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('새 버전이 있습니다');
    expect(within(dialog).getByDisplayValue('내가 고친 본문')).toBeInTheDocument();
    const reload = within(dialog).getByRole('button', { name: '새로 불러오기' });
    expect(within(dialog).getByRole('button', { name: '새 버전 저장' })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: '닫기' })).toHaveFocus();
    await user.tab();
    expect(reload).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(getDraft).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog', { name: '직접 수정' })).not.toBeInTheDocument();
  });

  it('keeps focused-revision inputs and exposes keyboard conflict recovery after generate returns 409', async () => {
    const generate = vi.fn().mockRejectedValue(new NarrativeApiError(409, 'stale_revision'));
    const getDraft = vi.fn()
      .mockResolvedValueOnce(detail)
      .mockResolvedValueOnce({ ...detail, revisionPricing: { maximumInputTokens: 2048, inputCostMicrosPerMillion: 10, outputCostMicrosPerMillion: 20, fixedCostMicros: 30, maximumRevisionOutputTokens: 512 } });
    const user = userEvent.setup();
    render(<DraftReviewPage api={api({ getDraft, generate })} draftId="draft-1" />);
    await screen.findByRole('heading', { name: '빗소리 아래' });

    await user.click(screen.getByRole('button', { name: '부분 AI 수정' }));
    const dialog = screen.getByRole('dialog', { name: '부분 AI 수정' });
    await user.type(within(dialog).getByLabelText('선택한 구절'), '선택 구절');
    await user.type(within(dialog).getByLabelText('수정 지시'), '말투만 수정');
    await user.click(within(dialog).getByRole('checkbox', { name: /최대 비용을 확인했습니다/ }));
    await user.click(within(dialog).getByRole('button', { name: '새 버전 생성' }));

    expect(within(dialog).getByRole('alert')).toHaveTextContent('새 버전이 있습니다');
    expect(within(dialog).getByDisplayValue('선택 구절')).toBeInTheDocument();
    expect(within(dialog).getByDisplayValue('말투만 수정')).toBeInTheDocument();
    const reload = within(dialog).getByRole('button', { name: '새로 불러오기' });
    expect(within(dialog).getByRole('button', { name: '새 버전 생성' })).toHaveFocus();
    await user.tab();
    expect(within(dialog).getByRole('button', { name: '닫기' })).toHaveFocus();
    await user.tab();
    expect(reload).toHaveFocus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(getDraft).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('dialog', { name: '부분 AI 수정' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '부분 AI 수정' }));
    expect(within(screen.getByRole('dialog', { name: '부분 AI 수정' })).getByRole('checkbox', { name: /최대 비용을 확인했습니다/ })).not.toBeChecked();
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
    await user.click(screen.getByRole('button', { name: '부분 AI 수정' }));
    expect(within(screen.getByRole('dialog', { name: '부분 AI 수정' })).getByRole('checkbox', { name: /최대 비용을 확인했습니다/ })).not.toBeChecked();
  });

  it('binds maximum-cost confirmation to the exact revision request and invalidates it on reopen', async () => {
    const user = userEvent.setup();
    render(<DraftReviewPage api={api()} draftId="draft-1" />);
    await screen.findByRole('heading', { name: '빗소리 아래' });

    const trigger = screen.getByRole('button', { name: '부분 AI 수정' });
    await user.click(trigger);
    let dialog = screen.getByRole('dialog', { name: '부분 AI 수정' });
    const selection = within(dialog).getByLabelText('선택한 구절');
    const instruction = within(dialog).getByLabelText('수정 지시');
    const confirmation = within(dialog).getByRole('checkbox', { name: /최대 비용을 확인했습니다/ });
    await user.type(selection, '선택 구절');
    await user.type(instruction, '말투 수정');
    await user.click(confirmation);
    expect(confirmation).toBeChecked();

    await user.type(selection, ' 추가');
    expect(confirmation).not.toBeChecked();
    await user.click(confirmation);
    await user.type(instruction, ' 추가');
    expect(confirmation).not.toBeChecked();
    await user.click(confirmation);
    await user.clear(within(dialog).getByLabelText('최대 출력 토큰'));
    await user.type(within(dialog).getByLabelText('최대 출력 토큰'), '64');
    expect(confirmation).not.toBeChecked();
    await user.click(confirmation);
    await user.click(within(dialog).getByRole('button', { name: '닫기' }));
    await user.click(trigger);
    dialog = screen.getByRole('dialog', { name: '부분 AI 수정' });
    expect(within(dialog).getByRole('checkbox', { name: /최대 비용을 확인했습니다/ })).not.toBeChecked();
  });

  it('keeps freshly generated blocked latest versions inspectable and routes rejection through generated submission', async () => {
    const blocked = { ...detail, latestVersion: { ...detail.latestVersion, continuityLevel: 'block' as const }, status: 'generated' as const };
    const review = vi.fn().mockResolvedValue({ draftId: 'draft-1', versionId: 'version-2', status: 'rejected' as const });
    const user = userEvent.setup();
    render(<DraftReviewPage api={api({ getDraft: vi.fn().mockResolvedValue(blocked), review })} draftId="draft-1" />);

    expect(await screen.findByText('차단된 버전')).toBeInTheDocument();
    for (const name of ['직접 수정', '부분 AI 수정', '비공개 정사 승인', '승인하고 게시', '보관']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    await user.click(screen.getByRole('button', { name: '거절' }));
    const dialog = screen.getByRole('dialog', { name: '거절' });
    await user.type(within(dialog).getByLabelText('거절 사유'), '연속성 차단');
    await user.click(within(dialog).getByRole('button', { name: '거절 확정' }));
    expect(review).toHaveBeenCalledWith(expect.objectContaining({ expectedState: 'generated', action: 'reject', reason: '연속성 차단' }));
  });

  it.each(['queued', 'generating', 'approved', 'publishing', 'published', 'archived'] as const)(
    'does not offer archive while status is %s',
    async (status) => {
      render(<DraftReviewPage api={api({ getDraft: vi.fn().mockResolvedValue({ ...detail, status }) })} draftId="draft-1" />);
      await screen.findByRole('heading', { name: '빗소리 아래' });
      expect(screen.queryByRole('button', { name: '보관' })).not.toBeInTheDocument();
    },
  );

  it.each(['generated', 'reviewing', 'rejected', 'approved_private', 'publish_failed'] as const)(
    'offers archive only in the safe source status %s',
    async (status) => {
      render(<DraftReviewPage api={api({ getDraft: vi.fn().mockResolvedValue({ ...detail, status }) })} draftId="draft-1" />);
      await screen.findByRole('heading', { name: '빗소리 아래' });
      expect(screen.getByRole('button', { name: '보관' })).toBeInTheDocument();
    },
  );

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
