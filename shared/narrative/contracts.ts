import { z } from 'zod';

export const draftKinds = ['short_dialogue', 'daily_event', 'major_event_proposal'] as const;
export const generationModes = ['new', 'revise_selection', 'major_event_scene_plan', 'major_event_draft'] as const;
export const draftStatuses = [
  'queued',
  'generating',
  'generated',
  'reviewing',
  'rejected',
  'archived',
  'approved_private',
  'approved',
  'publishing',
  'published',
  'publish_failed',
] as const;

export type DraftKind = typeof draftKinds[number];
export type GenerationMode = typeof generationModes[number];
export type DraftStatus = typeof draftStatuses[number];

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costMicros?: number;
}

export interface GenerationRequest {
  kind: DraftKind;
  mode: GenerationMode;
  modelKey: string;
  seed?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  contextVersionIds: string[];
  contextMemories: Array<{
    versionId: string;
    memoryType: 'canon' | 'feedback' | 'continuity' | 'summary';
    content: string;
    tokenCount: number;
    claims?: Array<{
      id: string;
      sourceId: string;
      sourcePriority: number;
      status: 'confirmed' | 'unresolved' | 'conflicting' | 'request-only';
      revealStage: number;
      text: string;
    }>;
    continuityFacts?: {
      relationshipStage?: number;
      forbiddenReveals?: Array<{ term: string; allowedAtRelationshipStage: number }>;
      permanentEntities?: string[];
      permanentSettings?: string[];
      continuityId?: string;
      rejectedMotifs?: string[];
      voiceAndTitleRules?: boolean;
    };
  }>;
  revision?: { selectedText: string; instruction: string };
}

const resultSchema = z.object({
  title: z.string().min(1),
  kind: z.enum(draftKinds),
  setting: z.object({ time: z.string(), place: z.string() }),
  body: z.string().min(1),
  emotionalStart: z.string().min(1),
  emotionalEnd: z.string().min(1),
  continuityUsed: z.array(z.string()),
  continuityCandidates: z.array(z.string()),
  canonChangeCandidates: z.array(z.string()),
  unresolvedCallbacks: z.array(z.string()),
  riskFlags: z.array(z.string()),
});

export type GenerationResult = z.infer<typeof resultSchema>;

export const parseGenerationResult = (value: unknown): GenerationResult => resultSchema.parse(value);
