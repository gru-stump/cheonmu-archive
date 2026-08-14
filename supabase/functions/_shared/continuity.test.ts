import { describe, expect, it } from 'vitest';
import type { GenerationResult } from '../../../shared/narrative/contracts';
import { checkContinuity, type ContinuityContext } from './continuity';

const baseResult: GenerationResult = {
  title: 'Routine report',
  kind: 'short_dialogue',
  setting: { time: 'night', place: 'medical center' },
  body: 'A quiet exchange ends without a new promise.',
  emotionalStart: 'guarded',
  emotionalEnd: 'steady',
  continuityUsed: ['CM-07'],
  continuityCandidates: [],
  canonChangeCandidates: [],
  unresolvedCallbacks: [],
  riskFlags: [],
};

const stage7Context: ContinuityContext = {
  selectedSourceIds: ['canon-v1', 'relationship-profile'],
  currentRelationshipStage: 7,
  relationshipSourceId: 'relationship-profile',
  forbiddenRevealTerms: [{ term: 'immortal origin', sourceId: 'reveal-plan-age-origin', allowedAtRelationshipStage: 9 }],
  knownPermanentEntities: [{ name: 'special disaster agency', sourceId: 'WF-01' }],
  knownPermanentSettings: [{ name: 'medical center', sourceId: 'WF-03' }],
  approvedContinuity: [{ id: 'CM-07', sourceId: 'CM-07' }],
  rejectedMotifs: [{ term: 'waiting at the platform', sourceId: 'feedback-no-waiting' }],
  voiceAndTitleSourceIds: ['relationship-profile'],
};

describe('checkContinuity', () => {
  it('blocks direct naming of a secret before its source-backed reveal gate', () => {
    const result = checkContinuity(
      { ...baseResult, body: 'He confirms the immortal origin in plain words.' },
      stage7Context,
    );

    expect(result.level).toBe('block');
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'forbidden_reveal_term', level: 'block', sourceIds: ['reveal-plan-age-origin'] }));
  });

  it('blocks metadata that advances the relationship beyond the approved stage', () => {
    const result = checkContinuity(
      { ...baseResult, canonChangeCandidates: ['relationship-stage:8'] },
      stage7Context,
    );

    expect(result.level).toBe('block');
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'relationship_stage_advance', level: 'block', sourceIds: ['relationship-profile'] }));
  });

  it('blocks a provider-reported relationship advancement risk', () => {
    const result = checkContinuity(
      { ...baseResult, riskFlags: ['relationship-stage-advance'] },
      stage7Context,
    );

    expect(result.level).toBe('block');
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'relationship_stage_advance', level: 'block', sourceIds: ['relationship-profile'] }));
  });

  it('blocks unsupported permanent entities and settings from structured candidates', () => {
    const result = checkContinuity(
      {
        ...baseResult,
        canonChangeCandidates: ['permanent-entity:Fourth Response Unit', 'permanent-setting:underground palace'],
      },
      stage7Context,
    );

    expect(result.level).toBe('block');
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unknown_permanent_entity', level: 'block', sourceIds: ['canon-v1', 'relationship-profile'] }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unknown_permanent_setting', level: 'block', sourceIds: ['canon-v1', 'relationship-profile'] }));
  });

  it('blocks conflicts with an approved continuity record and rejected motifs', () => {
    const result = checkContinuity(
      {
        ...baseResult,
        body: 'They are waiting at the platform again.',
        canonChangeCandidates: ['continuity-conflict:CM-07'],
      },
      stage7Context,
    );

    expect(result.level).toBe('block');
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'approved_continuity_conflict', level: 'block', sourceIds: ['CM-07'] }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'possible_rejected_motif', level: 'review', sourceIds: ['feedback-no-waiting'] }));
  });

  it('marks voice and title deviations for review without blocking a draft', () => {
    const result = checkContinuity(
      { ...baseResult, riskFlags: ['voice-deviation', 'title-deviation'] },
      stage7Context,
    );

    expect(result).toEqual({
      level: 'review',
      findings: [
        {
          code: 'voice_or_title_deviation',
          level: 'review',
          message: 'Generated metadata reports a voice or title deviation that needs review.',
          sourceIds: ['relationship-profile'],
        },
        {
          code: 'manual_semantic_review',
          level: 'review',
          message: 'Voice, title, POV, and intimacy require manual semantic review.',
          sourceIds: ['canon-v1', 'relationship-profile'],
        },
      ],
    });
  });

  it('requires manual semantic review when deterministic hard checks find no violation', () => {
    expect(checkContinuity(baseResult, stage7Context)).toEqual({
      level: 'review',
      findings: [{
        code: 'manual_semantic_review',
        level: 'review',
        message: 'Voice, title, POV, and intimacy require manual semantic review.',
        sourceIds: ['canon-v1', 'relationship-profile'],
      }],
    });
  });

  it('reviews unrecognized or malformed metadata instead of silently passing it', () => {
    const result = checkContinuity({
      ...baseResult,
      canonChangeCandidates: ['relationship-stage:eight', 'new-canon:unknown'],
      riskFlags: ['unmodeled-provider-risk'],
    }, stage7Context);

    expect(result.level).toBe('review');
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'malformed_relationship_stage', level: 'review' }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unknown_canon_change_candidate', level: 'review' }));
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unknown_risk_flag', level: 'review' }));
  });

  it('reviews an unrecognized continuity reference instead of discarding it', () => {
    const result = checkContinuity(
      { ...baseResult, canonChangeCandidates: ['continuity-conflict:missing-record'] },
      stage7Context,
    );

    expect(result.level).toBe('review');
    expect(result.findings).toContainEqual(expect.objectContaining({ code: 'unknown_continuity_reference', level: 'review' }));
  });

  it('does not treat a rejected motif substring as a hard violation', () => {
    const result = checkContinuity(
      { ...baseResult, body: 'They completed emergency training before sunrise.' },
      { ...stage7Context, rejectedMotifs: [{ term: 'rain', sourceId: 'feedback-no-rain' }] },
    );

    expect(result.findings.map((finding) => finding.code)).not.toContain('rejected_motif');
    expect(result.findings.map((finding) => finding.code)).not.toContain('possible_rejected_motif');
  });

  it('reviews lexical rejected motifs but blocks structured evidence', () => {
    const lexical = checkContinuity(
      { ...baseResult, body: 'Rain falls beyond the window.' },
      { ...stage7Context, rejectedMotifs: [{ term: 'rain', sourceId: 'feedback-no-rain' }] },
    );
    const structured = checkContinuity(
      { ...baseResult, riskFlags: ['rejected-motif:rain'] },
      { ...stage7Context, rejectedMotifs: [{ term: 'rain', sourceId: 'feedback-no-rain' }] },
    );

    expect(lexical.level).toBe('review');
    expect(lexical.findings).toContainEqual(expect.objectContaining({ code: 'possible_rejected_motif', level: 'review' }));
    expect(structured.level).toBe('block');
    expect(structured.findings).toContainEqual(expect.objectContaining({ code: 'rejected_motif', level: 'block' }));
  });

  it('rejects contexts without real selected source IDs', () => {
    expect(() => checkContinuity(baseResult, { ...stage7Context, selectedSourceIds: [] })).toThrow('continuity_context_missing_source_ids');
  });
});
