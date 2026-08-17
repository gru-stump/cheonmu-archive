export type ProviderCatalogKey = 'openai' | 'anthropic';

export interface ProviderCatalogEntry {
  id: string;
  providerKey: ProviderCatalogKey;
  label: string;
  description: string;
  quality: 'standard' | 'high';
  speed: 'fast' | 'balanced';
  cost: 'low' | 'medium' | 'high';
  recommended: boolean;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRevisionOutputTokens: number;
  inputPriceMicrosPerMillion: number;
  outputPriceMicrosPerMillion: number;
  sourceUrl: string;
  verifiedAt: string;
}

export type AvailableCatalogEntry = ProviderCatalogEntry & {
  availability: 'available' | 'unverified';
};

export const providerCatalog: readonly ProviderCatalogEntry[] = [
  {
    id: 'gpt-5-mini',
    providerKey: 'openai',
    label: 'GPT-5 mini',
    description: '비용과 속도의 균형이 좋아 일상 대화 생성에 권장합니다.',
    quality: 'standard',
    speed: 'fast',
    cost: 'low',
    recommended: true,
    maxInputTokens: 4_000,
    maxOutputTokens: 8_000,
    maxRevisionOutputTokens: 2_000,
    inputPriceMicrosPerMillion: 250_000,
    outputPriceMicrosPerMillion: 2_000_000,
    sourceUrl: 'https://developers.openai.com/api/docs/models/gpt-5-mini',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'claude-haiku-4-5-20251001',
    providerKey: 'anthropic',
    label: 'Claude Haiku 4.5',
    description: '짧은 대화와 빠른 초안 생성에 적합한 절약형 모델입니다.',
    quality: 'standard',
    speed: 'fast',
    cost: 'low',
    recommended: true,
    maxInputTokens: 4_000,
    maxOutputTokens: 4_000,
    maxRevisionOutputTokens: 2_000,
    inputPriceMicrosPerMillion: 1_000_000,
    outputPriceMicrosPerMillion: 5_000_000,
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    verifiedAt: '2026-08-16',
  },
  {
    id: 'claude-sonnet-4-5-20250929',
    providerKey: 'anthropic',
    label: 'Claude Sonnet 4.5',
    description: '복잡한 장면과 긴 맥락에 적합하지만 비용이 더 높습니다.',
    quality: 'high',
    speed: 'balanced',
    cost: 'high',
    recommended: false,
    maxInputTokens: 4_000,
    maxOutputTokens: 4_000,
    maxRevisionOutputTokens: 2_000,
    inputPriceMicrosPerMillion: 3_000_000,
    outputPriceMicrosPerMillion: 15_000_000,
    sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
    verifiedAt: '2026-08-16',
  },
] as const;

export function catalogModels(providerKey: ProviderCatalogKey, liveIds: readonly string[] | null): AvailableCatalogEntry[] {
  const entries = providerCatalog.filter((entry) => entry.providerKey === providerKey);
  if (liveIds === null) return entries.map((entry) => ({ ...entry, availability: 'unverified' }));
  const availableIds = new Set(liveIds);
  return entries.filter((entry) => availableIds.has(entry.id)).map((entry) => ({ ...entry, availability: 'available' }));
}

export function estimateMaximumGenerationMicros(entry: Pick<ProviderCatalogEntry,
  'maxInputTokens' | 'maxOutputTokens' | 'inputPriceMicrosPerMillion' | 'outputPriceMicrosPerMillion'>) {
  return Math.ceil(
    (entry.maxInputTokens * entry.inputPriceMicrosPerMillion
      + entry.maxOutputTokens * entry.outputPriceMicrosPerMillion) / 1_000_000,
  );
}
