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

const CANON_CONTEXT_SOURCE = 'canon-context';
const voiceAndTitleRiskFlags = new Set(['voice-deviation', 'title-deviation', 'voice-title-deviation']);

function normalise(value: string): string {
  return value.trim().toLowerCase();
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

function metadataValues(values: string[], prefix: string): string[] {
  const normalisedPrefix = `${prefix}:`;
  return values
    .map(normalise)
    .filter((value) => value.startsWith(normalisedPrefix))
    .map((value) => value.slice(normalisedPrefix.length).trim())
    .filter(Boolean);
}

function hasKnownName(name: string, known: KnownCanonName[] | undefined): boolean {
  return known?.some((entry) => normalise(entry.name) === name) === true;
}

function levelFor(findings: Finding[]): FindingLevel {
  if (findings.some((finding) => finding.level === 'block')) return 'block';
  return findings.length > 0 ? 'review' : 'pass';
}

/**
 * Runs policy-only, deterministic continuity checks. Lexical checks are deliberately
 * limited to terms supplied by source-backed canon or feedback records.
 */
export function checkContinuity(result: GenerationResult, context: ContinuityContext): ContinuityCheck {
  const findings: Finding[] = [];
  const candidateValues = result.canonChangeCandidates;
  const text = narrativeText(result);
  const riskFlags = result.riskFlags.map(normalise);

  for (const stage of metadataValues(candidateValues, 'relationship-stage')) {
    const proposedStage = Number(stage);
    if (Number.isFinite(proposedStage) && proposedStage > context.currentRelationshipStage) {
      findings.push({
        code: 'relationship_stage_advance',
        level: 'block',
        message: `Proposed relationship stage ${proposedStage} exceeds approved stage ${context.currentRelationshipStage}.`,
        sourceIds: [context.relationshipSourceId],
      });
    }
  }

  if (riskFlags.includes('relationship-stage-advance')) {
    findings.push({
      code: 'relationship_stage_advance',
      level: 'block',
      message: 'Generated metadata reports a relationship-stage advancement.',
      sourceIds: [context.relationshipSourceId],
    });
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

  for (const entity of metadataValues(candidateValues, 'permanent-entity')) {
    if (!hasKnownName(entity, context.knownPermanentEntities)) {
      findings.push({
        code: 'unknown_permanent_entity',
        level: 'block',
        message: `Permanent entity "${entity}" is not present in the selected canon.`,
        sourceIds: [CANON_CONTEXT_SOURCE],
      });
    }
  }

  for (const setting of metadataValues(candidateValues, 'permanent-setting')) {
    if (!hasKnownName(setting, context.knownPermanentSettings)) {
      findings.push({
        code: 'unknown_permanent_setting',
        level: 'block',
        message: `Permanent setting "${setting}" is not present in the selected canon.`,
        sourceIds: [CANON_CONTEXT_SOURCE],
      });
    }
  }

  const approvedById = new Map((context.approvedContinuity ?? []).map((entry) => [normalise(entry.id), entry]));
  for (const conflictId of metadataValues(candidateValues, 'continuity-conflict')) {
    const approved = approvedById.get(conflictId);
    if (approved) {
      findings.push({
        code: 'approved_continuity_conflict',
        level: 'block',
        message: `Generated metadata conflicts with approved continuity "${approved.id}".`,
        sourceIds: [approved.sourceId],
      });
    }
  }

  for (const motif of context.rejectedMotifs ?? []) {
    if (text.includes(normalise(motif.term)) || riskFlags.includes(`rejected-motif:${normalise(motif.term)}`)) {
      findings.push({
        code: 'rejected_motif',
        level: 'block',
        message: `Rejected motif "${motif.term}" appears in the generated draft.`,
        sourceIds: [motif.sourceId],
      });
    }
  }

  if (riskFlags.some((flag) => voiceAndTitleRiskFlags.has(flag))) {
    findings.push({
      code: 'voice_or_title_deviation',
      level: 'review',
      message: 'Generated metadata reports a voice or title deviation that needs review.',
      sourceIds: context.voiceAndTitleSourceIds ?? [context.relationshipSourceId],
    });
  }

  return { level: levelFor(findings), findings };
}
