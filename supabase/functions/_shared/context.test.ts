import { describe, expect, it } from 'vitest';
import { selectNarrativeContext, type NarrativeMemory } from './context';

const memories: NarrativeMemory[] = [
  {
    versionId: 'feedback-v2', memoryType: 'feedback', content: 'Tone note', tokenCount: 100,
    blocking: false, status: 'approved', updatedAt: '2026-08-14T00:00:00.000Z',
  },
  {
    versionId: 'recent-v4', memoryType: 'summary', content: 'Recent approved summary', tokenCount: 100,
    status: 'approved', updatedAt: '2026-08-13T00:00:00.000Z',
  },
  {
    versionId: 'promise-v3', memoryType: 'continuity', content: 'Treatment promise', tokenCount: 100,
    status: 'approved', tags: ['치료실'], updatedAt: '2026-08-12T00:00:00.000Z',
  },
  {
    versionId: 'canon-v1', memoryType: 'canon', content: 'Fixed canon', tokenCount: 100,
    status: 'approved', updatedAt: '2026-08-11T00:00:00.000Z',
  },
];

describe('selectNarrativeContext', () => {
  it('orders fixed canon, tagged approved continuity, recent summaries, and optional feedback deterministically', () => {
    expect(selectNarrativeContext({ memories, tokenBudget: 500, tags: ['치료실'] }).versionIds).toEqual([
      'canon-v1',
      'promise-v3',
      'recent-v4',
      'feedback-v2',
    ]);
  });

  it('keeps blocking feedback ahead of continuity and trims only the tail at the token budget', () => {
    const selection = selectNarrativeContext({
      memories: [
        ...memories,
        {
          versionId: 'block-v5', memoryType: 'feedback', content: 'Must preserve injury cost', tokenCount: 100,
          blocking: true, status: 'approved', updatedAt: '2026-08-15T00:00:00.000Z',
        },
      ],
      tokenBudget: 300,
      tags: ['치료실'],
    });

    expect(selection.versionIds).toEqual(['canon-v1', 'block-v5', 'promise-v3']);
    expect(selection.fixedCanon.map((memory) => memory.versionId)).toEqual(['canon-v1']);
    expect(selection.feedback.map((memory) => memory.versionId)).toEqual(['block-v5']);
    expect(selection.recent).toEqual([]);
  });
});
