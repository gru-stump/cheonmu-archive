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

    expect(result).toMatchObject({
      level: 'block',
      findings: [{ code: 'forbidden_reveal_term', level: 'block', sourceIds: ['reveal-plan-age-origin'] }],
    });
  });

  it('blocks metadata that advances the relationship beyond the approved stage', () => {
    const result = checkContinuity(
      { ...baseResult, canonChangeCandidates: ['relationship-stage:8'] },
      stage7Context,
    );

    expect(result).toMatchObject({
      level: 'block',
      findings: [{ code: 'relationship_stage_advance', level: 'block', sourceIds: ['relationship-profile'] }],
    });
  });

  it('blocks a provider-reported relationship advancement risk', () => {
    const result = checkContinuity(
      { ...baseResult, riskFlags: ['relationship-stage-advance'] },
      stage7Context,
    );

    expect(result).toMatchObject({
      level: 'block',
      findings: [{ code: 'relationship_stage_advance', level: 'block', sourceIds: ['relationship-profile'] }],
    });
  });

  it('blocks unsupported permanent entities and settings from structured candidates', () => {
    const result = checkContinuity(
      {
        ...baseResult,
        canonChangeCandidates: ['permanent-entity:Fourth Response Unit', 'permanent-setting:underground palace'],
      },
      stage7Context,
    );

    expect(result).toMatchObject({
      level: 'block',
      findings: [
        { code: 'unknown_permanent_entity', level: 'block', sourceIds: ['canon-context'] },
        { code: 'unknown_permanent_setting', level: 'block', sourceIds: ['canon-context'] },
      ],
    });
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

    expect(result).toMatchObject({
      level: 'block',
      findings: [
        { code: 'approved_continuity_conflict', level: 'block', sourceIds: ['CM-07'] },
        { code: 'rejected_motif', level: 'block', sourceIds: ['feedback-no-waiting'] },
      ],
    });
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
      ],
    });
  });

  it('passes when structured metadata and policy terms remain within canon', () => {
    expect(checkContinuity(baseResult, stage7Context)).toEqual({ level: 'pass', findings: [] });
  });
});
