import { describe, expect, it, vi } from 'vitest';
import { localPreviewApi } from './localPreviewApi';

describe('localPreviewApi', () => {
  it('serves deterministic Korean fixtures without network access', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    await expect(localPreviewApi.getDraft('local-preview-draft-rain')).resolves.toMatchObject({
      title: '비 갠 뒤의 약속',
      latestVersion: { content: { body: expect.stringContaining('천령과 무영') } },
    });
    await expect(localPreviewApi.getMemory()).resolves.toMatchObject({
      continuity: [{ content: '비 오는 날 다시 만나기로 약속했다.' }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('fails every mutation locally without making a network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const calls = [
      localPreviewApi.generate({} as never),
      localPreviewApi.saveManualVersion({} as never),
      localPreviewApi.review({} as never),
      localPreviewApi.retryPublish({} as never),
      localPreviewApi.archive({} as never),
      localPreviewApi.setMemoryEnabled({} as never),
      localPreviewApi.correctMemory({} as never),
      localPreviewApi.saveSchedule({} as never),
      localPreviewApi.saveSettings({} as never),
      localPreviewApi.saveSecret({} as never),
    ];

    const results = await Promise.allSettled(calls);
    expect(results).toHaveLength(10);
    for (const result of results) {
      expect(result).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: 'local_preview_read_only' }) });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
