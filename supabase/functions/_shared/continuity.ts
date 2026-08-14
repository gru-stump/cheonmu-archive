import type { GenerationResult } from '../../../shared/narrative/contracts';

export type FindingLevel = 'pass' | 'review' | 'block';

export interface Finding {
  code: string;
  level: Exclude<FindingLevel, 'pass'>;
  message: string;
  sourceIds: string[];
}

export interface SourceBackedTerm {
  term: string;
  sourceId: string;
}

export interface RevealTerm extends SourceBackedTerm {
  allowedAtRelationshipStage: number;
}

export interface KnownCanonName {
  name: string;
  sourceId: string;
}

export interface ApprovedContinuity {
  id: string;
  sourceId: string;
}

export interface ContinuityContext {
  /** IDs of the actual canon/memory versions selected for this draft. */
  selectedSourceIds: string[];
  currentRelationshipStage: number;
  relationshipSourceId: string;
  forbiddenRevealTerms?: RevealTerm[];
  knownPermanentEntities?: KnownCanonName[];
  knownPermanentSettings?: KnownCanonName[];
  approvedContinuity?: ApprovedContinuity[];
  rejectedMotifs?: SourceBackedTerm[];
  voiceAndTitleSourceIds?: string[];
}

export interface ContinuityCheck {
  level: FindingLevel;
  findings: Finding[];
}

const voiceAndTitleRiskFlags = new Set(['voice-deviation', 'title-deviation', 'voice-title-deviation']);

function normalise(value: string): string {
  return value.trim().toLowerCase();
}

function nonEmptySourceIds(sourceIds: string[]): boolean {
  return sourceIds.length > 0 && sourceIds.every((sourceId) => normalise(sourceId).length > 0);
}

function ensureContinuityContext(context: ContinuityContext): void {
  const sourceIds = [
    context.relationshipSourceId,
    ...(context.voiceAndTitleSourceIds ?? []),
    ...(context.forbiddenRevealTerms ?? []).map(({ sourceId }) => sourceId),
    ...(context.knownPermanentEntities ?? []).map(({ sourceId }) => sourceId),
    ...(context.knownPermanentSettings ?? []).map(({ sourceId }) => sourceId),
    ...(context.approvedContinuity ?? []).map(({ sourceId }) => sourceId),
    ...(context.rejectedMotifs ?? []).map(({ sourceId }) => sourceId),
  ];
  if (
    !nonEmptySourceIds(context.selectedSourceIds)
    || !nonEmptySourceIds(sourceIds)
    || (context.voiceAndTitleSourceIds !== undefined && !nonEmptySourceIds(context.voiceAndTitleSourceIds))
  ) {
    throw new Error('continuity_context_missing_source_ids');
  }
}

function narrativeText(result: GenerationResult): string {
  return [
    result.title,
    result.setting.time,
    result.setting.place,
    result.body,
    result.emotionalStart,
    result.emotionalEnd,
  ].map(normalise).join('\n');
}

function hasKnownName(name: string, known: KnownCanonName[] | undefined): boolean {
  return known?.some((entry) => normalise(entry.name) === name) === true;
}

function levelFor(findings: Finding[]): FindingLevel {
  if (findings.some((finding) => finding.level === 'block')) return 'block';
  return findings.length > 0 ? 'review' : 'pass';
}

function phraseOccurs(text: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'u').test(text);
}

function reviewUnknown(findings: Finding[], code: string, message: string, context: ContinuityContext): void {
  findings.push({ code, level: 'review', message, sourceIds: context.selectedSourceIds });
}

/**
 * Runs deterministic, source-backed hard gates. It always asks for human semantic
 * review because voice, title, POV, and intimacy cannot be verified by these rules.
 */
export function checkContinuity(result: GenerationResult, context: ContinuityContext): ContinuityCheck {
  ensureContinuityContext(context);
  const findings: Finding[] = [];
  const text = narrativeText(result);
  const approvedById = new Map((context.approvedContinuity ?? []).map((entry) => [normalise(entry.id), entry]));
  const motifsByTerm = new Map((context.rejectedMotifs ?? []).map((entry) => [normalise(entry.term), entry]));

  for (const rawCandidate of result.canonChangeCandidates) {
    const candidate = normalise(rawCandidate);
    if (candidate.startsWith('relationship-stage:')) {
      const stageText = candidate.slice('relationship-stage:'.length).trim();
      const proposedStage = Number(stageText);
      if (!Number.isSafeInteger(proposedStage) || proposedStage < 0) {
        reviewUnknown(findings, 'malformed_relationship_stage', `Relationship stage "${rawCandidate}" is malformed.`, context);
      } else if (proposedStage > context.currentRelationshipStage) {
        findings.push({
          code: 'relationship_stage_advance',
          level: 'block',
          message: `Proposed relationship stage ${proposedStage} exceeds approved stage ${context.currentRelationshipStage}.`,
          sourceIds: [context.relationshipSourceId],
        });
      }
    } else if (candidate.startsWith('permanent-entity:')) {
      const entity = candidate.slice('permanent-entity:'.length).trim();
      if (!entity) reviewUnknown(findings, 'malformed_permanent_entity', 'Permanent entity metadata is empty.', context);
      else if (!hasKnownName(entity, context.knownPermanentEntities)) {
        findings.push({
          code: 'unknown_permanent_entity',
          level: 'block',
          message: `Permanent entity "${entity}" is not present in the selected canon.`,
          sourceIds: context.selectedSourceIds,
        });
      }
    } else if (candidate.startsWith('permanent-setting:')) {
      const setting = candidate.slice('permanent-setting:'.length).trim();
      if (!setting) reviewUnknown(findings, 'malformed_permanent_setting', 'Permanent setting metadata is empty.', context);
      else if (!hasKnownName(setting, context.knownPermanentSettings)) {
        findings.push({
          code: 'unknown_permanent_setting',
          level: 'block',
          message: `Permanent setting "${setting}" is not present in the selected canon.`,
          sourceIds: context.selectedSourceIds,
        });
      }
    } else if (candidate.startsWith('continuity-conflict:')) {
      const conflictId = candidate.slice('continuity-conflict:'.length).trim();
      const approved = approvedById.get(conflictId);
      if (approved) {
        findings.push({
          code: 'approved_continuity_conflict',
          level: 'block',
          message: `Generated metadata conflicts with approved continuity "${approved.id}".`,
          sourceIds: [approved.sourceId],
        });
      } else {
        reviewUnknown(findings, 'unknown_continuity_reference', `Continuity reference "${rawCandidate}" is not selected and approved.`, context);
      }
    } else {
      reviewUnknown(findings, 'unknown_canon_change_candidate', `Canon change metadata "${rawCandidate}" is not recognized.`, context);
    }
  }

  for (const reveal of context.forbiddenRevealTerms ?? []) {
    if (context.currentRelationshipStage < reveal.allowedAtRelationshipStage && text.includes(normalise(reveal.term))) {
      findings.push({
        code: 'forbidden_reveal_term',
        level: 'block',
        message: `Direct reveal term "${reveal.term}" is not allowed at the current stage.`,
        sourceIds: [reveal.sourceId],
      });
    }
  }

  let reportsVoiceOrTitleDeviation = false;
  for (const rawRiskFlag of result.riskFlags) {
    const riskFlag = normalise(rawRiskFlag);
    if (riskFlag === 'relationship-stage-advance') {
      findings.push({
        code: 'relationship_stage_advance',
        level: 'block',
        message: 'Generated metadata reports a relationship-stage advancement.',
        sourceIds: [context.relationshipSourceId],
      });
    } else if (voiceAndTitleRiskFlags.has(riskFlag)) {
      reportsVoiceOrTitleDeviation = true;
    } else if (riskFlag.startsWith('rejected-motif:')) {
      const term = riskFlag.slice('rejected-motif:'.length).trim();
      const motif = motifsByTerm.get(term);
      if (!motif) reviewUnknown(findings, 'unknown_risk_flag', `Risk flag "${rawRiskFlag}" is not source-backed.`, context);
      else findings.push({
        code: 'rejected_motif',
        level: 'block',
        message: `Generated metadata reports rejected motif "${motif.term}".`,
        sourceIds: [motif.sourceId],
      });
    } else {
      reviewUnknown(findings, 'unknown_risk_flag', `Risk flag "${rawRiskFlag}" is not recognized.`, context);
    }
  }

  for (const motif of context.rejectedMotifs ?? []) {
    if (phraseOccurs(text, normalise(motif.term))) {
      findings.push({
        code: 'possible_rejected_motif',
        level: 'review',
        message: `Generated prose may contain rejected motif "${motif.term}"; quoted or negated context needs review.`,
        sourceIds: [motif.sourceId],
      });
    }
  }

  if (reportsVoiceOrTitleDeviation) {
    findings.push({
      code: 'voice_or_title_deviation',
      level: 'review',
      message: 'Generated metadata reports a voice or title deviation that needs review.',
      sourceIds: context.voiceAndTitleSourceIds ?? [context.relationshipSourceId],
    });
  }

  findings.push({
    code: 'manual_semantic_review',
    level: 'review',
    message: 'Voice, title, POV, and intimacy require manual semantic review.',
    sourceIds: context.selectedSourceIds,
  });

  return { level: levelFor(findings), findings };
}
