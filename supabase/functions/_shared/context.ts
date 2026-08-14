export type NarrativeMemoryType = 'canon' | 'feedback' | 'continuity' | 'summary';

export interface NarrativeMemory {
  versionId: string;
  memoryType: NarrativeMemoryType;
  content: string;
  tokenCount: number;
  status: string;
  tags?: string[];
  blocking?: boolean;
  updatedAt?: string;
}

export interface NarrativeContextInput {
  memories: NarrativeMemory[];
  tokenBudget: number;
  tags?: string[];
}

export interface ContextSelection {
  versionIds: string[];
  fixedCanon: NarrativeMemory[];
  continuity: NarrativeMemory[];
  recent: NarrativeMemory[];
  feedback: NarrativeMemory[];
  tokenCount: number;
}

function stableMemoryOrder(left: NarrativeMemory, right: NarrativeMemory): number {
  const leftTime = left.updatedAt ?? '';
  const rightTime = right.updatedAt ?? '';
  return rightTime.localeCompare(leftTime) || left.versionId.localeCompare(right.versionId);
}

function hasRequestedTag(memory: NarrativeMemory, tags: string[]): boolean {
  return tags.length > 0 && memory.tags?.some((tag) => tags.includes(tag)) === true;
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
  const requestedTags = input.tags ?? [];
  const memories = [...input.memories].sort(stableMemoryOrder);
  const fixedCanon = memories.filter((memory) => memory.memoryType === 'canon');
  const blockingFeedback = memories.filter((memory) => memory.memoryType === 'feedback' && memory.blocking === true);
  const taggedContinuity = memories.filter((memory) => (
    memory.memoryType === 'continuity'
    && memory.status === 'approved'
    && hasRequestedTag(memory, requestedTags)
  ));
  const recent = memories.filter((memory) => memory.memoryType === 'summary' && memory.status === 'approved');
  const optionalFeedback = memories.filter((memory) => memory.memoryType === 'feedback' && memory.blocking !== true);
  const selected = selectWithinBudget(
    [...fixedCanon, ...blockingFeedback, ...taggedContinuity, ...recent, ...optionalFeedback],
    Math.max(0, input.tokenBudget),
  );

  return {
    versionIds: selected.map((memory) => memory.versionId),
    fixedCanon: selected.filter((memory) => memory.memoryType === 'canon'),
    continuity: selected.filter((memory) => memory.memoryType === 'continuity'),
    recent: selected.filter((memory) => memory.memoryType === 'summary'),
    feedback: selected.filter((memory) => memory.memoryType === 'feedback'),
    tokenCount: selected.reduce((total, memory) => total + Math.max(0, memory.tokenCount), 0),
  };
}
