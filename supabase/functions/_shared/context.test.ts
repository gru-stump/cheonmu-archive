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

  it('throws context_budget_too_small instead of dropping fixed canon or blocking feedback', () => {
    expect(() => selectNarrativeContext({
      memories: [
        { ...memories[3], tokenCount: 200 },
        { ...memories[0], versionId: 'blocking-v3', blocking: true, tokenCount: 200 },
      ],
      tokenBudget: 300,
      tags: [],
    })).toThrow('context_budget_too_small');
  });

  it('exposes only allowed claims at the current relationship stage', () => {
    const selection = selectNarrativeContext({
      memories: [{
        versionId: 'canon-claims-v1', memoryType: 'canon', content: 'unfiltered prose', tokenCount: 100,
        status: 'approved',
        claims: [
          { id: 'confirmed-now', sourceId: 'root', sourcePriority: 1, status: 'confirmed', revealStage: 7, text: 'allowed' },
          { id: 'unresolved-now', sourceId: 'unresolved', sourcePriority: 4, status: 'unresolved', revealStage: 7, text: 'blocked unresolved' },
          { id: 'future', sourceId: 'world', sourcePriority: 3, status: 'confirmed', revealStage: 8, text: 'blocked future' },
          { id: 'approved-request', sourceId: 'request', sourcePriority: 5, status: 'request-only', revealStage: 7, text: 'allowed request' },
        ],
      }],
      tokenBudget: 200,
      tags: [],
      currentRelationshipStage: 7,
      requestApprovedClaimIds: ['approved-request'],
    });

    expect(selection.fixedCanon[0].content).toBe('allowed\nallowed request');
    expect(selection.claims.map((claim) => claim.id)).toEqual(['confirmed-now', 'approved-request']);
  });
});
