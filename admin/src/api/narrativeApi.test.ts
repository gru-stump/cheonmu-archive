import { describe, expect, it, vi } from 'vitest';
import { createNarrativeApi, NarrativeApiError } from './narrativeApi';

describe('NarrativeApi', () => {
  it('uses only same-origin routes with the current owner bearer token', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ drafts: [] }));
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await api.listDrafts();

    expect(fetch).toHaveBeenCalledWith('/api/narrative/drafts', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer owner-token' }),
    }));
  });

  it('sends immutable-version and focused-revision concurrency fields', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({ version: { id: 'v3' } }))
      .mockResolvedValueOnce(Response.json({ draftId: 'd1', versionId: 'v4', status: 'generated', continuityLevel: 'review' }));
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await api.saveManualVersion({ draftId: 'd1', expectedVersionId: 'v2', expectedState: 'reviewing', content: { title: '제목', body: '수정문', canonChangeCandidates: [] } });
    await api.generate({ draftId: 'd1', expectedVersionId: 'v3', expectedState: 'reviewing', mode: 'revise_selection', kind: 'short_dialogue', revision: { selectedText: '선택', instruction: '수정' }, requestedMaxOutputTokens: 128, maximumCostConfirmed: true, confirmedMaximumCostMicros: 321 });

    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({ expectedVersionId: 'v2', expectedState: 'reviewing' });
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      expectedVersionId: 'v3', requestedMaxOutputTokens: 128, maximumCostConfirmed: true, confirmedMaximumCostMicros: 321,
      revision: { selectedText: '선택', instruction: '수정' },
    });
  });

  it('surfaces a stable 409 conflict without retrying or fetching replacement data', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ error: 'stale_review' }, { status: 409 }));
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await expect(api.review({ draftId: 'd1', expectedVersionId: 'v2', expectedState: 'generated', action: 'approve_private' }))
      .rejects.toEqual(new NarrativeApiError(409, 'stale_review'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects unsupported generation modes before a browser request is sent', async () => {
    const fetch = vi.fn();
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await expect(api.generate({
      draftId: 'd1', mode: 'new', kind: 'short_dialogue', seed: 'seed',
    } as never)).rejects.toEqual(new NarrativeApiError(400, 'unsupported_generation_mode'));
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unsafe archive source states before a browser request is sent', async () => {
    const fetch = vi.fn();
    const api = createNarrativeApi({ tokenProvider: async () => 'owner-token', fetch });

    await expect(api.archive({ draftId: 'd1', expectedVersionId: 'v2', expectedState: 'publishing' } as never))
      .rejects.toEqual(new NarrativeApiError(400, 'invalid_archive_state'));
    expect(fetch).not.toHaveBeenCalled();
  });
});
