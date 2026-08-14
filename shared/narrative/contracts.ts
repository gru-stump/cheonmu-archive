import { z } from 'zod';

export const draftKinds = ['short_dialogue', 'daily_event', 'major_event_proposal'] as const;
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
export type DraftStatus = typeof draftStatuses[number];

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costMicros?: number;
}

export interface GenerationRequest {
  kind: DraftKind;
  seed?: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  contextVersionIds: string[];
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
