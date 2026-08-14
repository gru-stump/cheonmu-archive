export type NarrativeMemoryType = 'canon' | 'feedback' | 'continuity' | 'summary';
export type NarrativeClaimStatus = 'confirmed' | 'unresolved' | 'conflicting' | 'request-only';

export interface NarrativeClaim {
  id: string;
  sourceId: string;
  sourcePriority: number;
  status: NarrativeClaimStatus;
  revealStage: number;
  text: string;
}

export interface NarrativeMemory {
  versionId: string;
  memoryType: NarrativeMemoryType;
  content: string;
  tokenCount: number;
  status: string;
  tags?: string[];
  blocking?: boolean;
  updatedAt?: string;
  claims?: NarrativeClaim[];
}

export interface NarrativeContextInput {
  memories: NarrativeMemory[];
  tokenBudget: number;
  tags?: string[];
  currentRelationshipStage?: number;
  requestApprovedClaimIds?: string[];
}

export interface ContextSelection {
  versionIds: string[];
  fixedCanon: NarrativeMemory[];
  continuity: NarrativeMemory[];
  recent: NarrativeMemory[];
  feedback: NarrativeMemory[];
  claims: NarrativeClaim[];
  tokenCount: number;
}

function stableMemoryOrder(left: NarrativeMemory, right: NarrativeMemory): number {
  return (right.updatedAt ?? '').localeCompare(left.updatedAt ?? '') || left.versionId.localeCompare(right.versionId);
}

function hasRequestedTag(memory: NarrativeMemory, tags: string[]): boolean {
  return tags.length > 0 && memory.tags?.some((tag) => tags.includes(tag)) === true;
}

function allowedMemory(memory: NarrativeMemory, input: NarrativeContextInput): NarrativeMemory | undefined {
  if (!memory.claims) return memory;
  const stage = input.currentRelationshipStage ?? 0;
  const approvedRequests = new Set(input.requestApprovedClaimIds ?? []);
  const claims = memory.claims.filter((claim) => claim.revealStage <= stage && (claim.status === 'confirmed' || (claim.status === 'request-only' && approvedRequests.has(claim.id))));
  if (claims.length === 0) return undefined;
  return { ...memory, claims, content: claims.map((claim) => claim.text).join('\n') };
}

function selectWithinBudget(memories: NarrativeMemory[], tokenBudget: number): NarrativeMemory[] {
  const selected: NarrativeMemory[] = [];
  let used = 0;
  for (const memory of memories) {
    const tokens = Math.max(0, memory.tokenCount);
    if (used + tokens > tokenBudget) break;
    selected.push(memory);
    used += tokens;
  }
  return selected;
}

export function selectNarrativeContext(input: NarrativeContextInput): ContextSelection {
  const tokenBudget = Math.max(0, input.tokenBudget);
  const requestedTags = input.tags ?? [];
  const memories = input.memories.map((memory) => allowedMemory(memory, input)).filter((memory): memory is NarrativeMemory => memory !== undefined).sort(stableMemoryOrder);
  const fixedCanon = memories.filter((memory) => memory.memoryType === 'canon');
  const blockingFeedback = memories.filter((memory) => memory.memoryType === 'feedback' && memory.blocking === true);
  const mandatory = [...fixedCanon, ...blockingFeedback];
  const mandatoryTokens = mandatory.reduce((total, memory) => total + Math.max(0, memory.tokenCount), 0);
  if (mandatoryTokens > tokenBudget) throw new Error('context_budget_too_small');
  const taggedContinuity = memories.filter((memory) => memory.memoryType === 'continuity' && memory.status === 'approved' && hasRequestedTag(memory, requestedTags));
  const recent = memories.filter((memory) => memory.memoryType === 'summary' && memory.status === 'approved');
  const optionalFeedback = memories.filter((memory) => memory.memoryType === 'feedback' && memory.blocking !== true);
  const selected = [...mandatory, ...selectWithinBudget([...taggedContinuity, ...recent, ...optionalFeedback], tokenBudget - mandatoryTokens)];
  return {
    versionIds: selected.map((memory) => memory.versionId),
    fixedCanon: selected.filter((memory) => memory.memoryType === 'canon'),
    continuity: selected.filter((memory) => memory.memoryType === 'continuity'),
    recent: selected.filter((memory) => memory.memoryType === 'summary'),
    feedback: selected.filter((memory) => memory.memoryType === 'feedback'),
    claims: selected.flatMap((memory) => memory.claims ?? []),
    tokenCount: selected.reduce((total, memory) => total + Math.max(0, memory.tokenCount), 0),
  };
}
