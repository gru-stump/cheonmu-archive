import type { DraftDetail, NarrativeApi } from '../api/narrativeApi';

const draftId = 'local-preview-draft-rain';
const version = {
  id: 'local-preview-version-rain',
  versionNumber: 2,
  createdAt: '2026-08-15T03:00:00.000Z',
  content: {
    title: '비 갠 뒤의 약속',
    body: '천령과 무영은 젖은 처마 아래에서 조용히 웃었다.',
    canonChangeCandidates: [],
  },
  contextVersionIds: ['local-preview-canon'],
  continuityLevel: 'pass' as const,
  continuityFindings: [],
};
const detail: DraftDetail = {
  id: draftId,
  kind: 'short_dialogue',
  status: 'generated',
  title: '비 갠 뒤의 약속',
  latestVersionId: version.id,
  latestVersion: version,
  versions: [version],
};

const readOnly = async (): Promise<never> => { throw new Error('local_preview_read_only'); };

export const localPreviewApi: NarrativeApi = {
  getDashboard: async () => ({
    krwPerUsd: 1_380,
    budget: { dailySpentMicros: 1_200, monthlySpentMicros: 8_400, reservedMicros: 300, dailyRemainingMicros: 18_800, monthlyRemainingMicros: 91_600 },
    nextScheduleAt: '2026-08-16T00:00:00.000Z',
    lastSuccessAt: '2026-08-15T03:00:00.000Z',
    failures: [],
    queue: [{ id: 'local-preview-worker', source: 'schedule', state: 'queued', attemptCount: 0, retryAt: null, leaseExpiresAt: null, failureCode: null, scheduledFor: '2026-08-16T00:00:00.000Z' }],
  }),
  estimateAccess: async () => ({ maximumCostMicros: 4_200, maximumCostKrw: 6, modelLabel: '둘러보기용 모델' }),
  triggerAccess: readOnly,
  cancelGenerationJob: readOnly,
  listDrafts: async () => [{ id: draftId, kind: 'short_dialogue', status: 'generated', title: detail.title, updatedAt: version.createdAt, latestVersionId: version.id, continuityLevel: 'pass' }],
  getDraft: async (requestedId) => requestedId === draftId ? detail : Promise.reject(new Error('local_preview_draft_not_found')),
  getMemory: async () => ({
    fixedCanon: [{ id: 'local-preview-canon', memoryType: 'canon', content: '천령과 무영의 유대는 비공개다.', enabled: true, createdAt: '2026-08-01T00:00:00.000Z', correctionHistory: [] }],
    continuity: [{ id: 'local-preview-continuity', memoryType: 'continuity', content: '비 오는 날 다시 만나기로 약속했다.', enabled: true, createdAt: '2026-08-14T00:00:00.000Z', correctionHistory: [] }],
    recent: [{ id: 'local-preview-recent', memoryType: 'summary', content: '두 사람은 처마 아래에서 비를 피했다.', enabled: true, createdAt: '2026-08-15T00:00:00.000Z', correctionHistory: [] }],
    feedback: [{ id: 'local-preview-feedback', memoryType: 'feedback', content: '현대식 농담은 사용하지 않는다.', enabled: true, createdAt: '2026-08-15T00:00:00.000Z', correctionHistory: [] }],
    unresolved: [{ id: 'local-preview-unresolved', memoryType: 'unresolved', content: '젖은 매듭 장식의 출처가 남아 있다.', enabled: true, createdAt: '2026-08-15T00:00:00.000Z', correctionHistory: [] }],
  }),
  getSchedules: async () => ({ schedules: [{ id: 'local-preview-schedule', scheduleKey: 'daily', scheduleType: 'automatic', enabled: true, seoulTime: '09:00', weekday: null, specialDate: null, minimumIntervalMinutes: 1_440, kind: 'daily_event', lastRunAt: '2026-08-15T00:00:00.000Z', nextRunAt: '2026-08-16T00:00:00.000Z' }] }),
  getSettings: async () => ({ manualGenerationEnabled: true, scheduleAutomationEnabled: false, pricingValidDays: 30, providers: [{ providerKey: 'fake-local-provider', enabled: true, modelKey: 'fake-local-model', maxInputTokens: 4096, maxOutputTokens: 1024, maxRevisionOutputTokens: 256, inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0, pricingVerifiedAt: '2026-08-16' }], budget: { monthlyLimitMicros: 100_000_000, dailyLimitMicros: 20_000_000, spentMicros: 8_400, reservedMicros: 300, manualCallLimit: 3, warningThresholdPercent: 80, riskThresholdPercent: 95, krwPerUsd: 1_380 }, secrets: { openai: false, anthropic: false, github: false } }),
  generate: readOnly,
  saveManualVersion: readOnly,
  review: readOnly,
  retryPublish: readOnly,
  archive: readOnly, restore: readOnly, reopenRejected: readOnly,
  setMemoryEnabled: readOnly,
  correctMemory: readOnly,
  saveSchedule: readOnly,
  saveSettings: readOnly,
  saveSecret: readOnly,
  deleteSecret: readOnly,
  listModels: async (providerKey) => ({ providerKey, configured: false, live: false, models: [{
    id: providerKey === 'openai' ? 'gpt-5-mini' : 'claude-sonnet-4-5',
    label: providerKey === 'openai' ? 'GPT-5 mini' : 'Claude Sonnet 4.5',
    description: '비용과 품질의 균형이 좋은 추천 모델입니다.', quality: 'standard', speed: 'fast', cost: 'low', recommended: true,
    availability: 'unverified', maxInputTokens: 16_384, maxOutputTokens: 2_048, maxRevisionOutputTokens: 512,
    inputPriceMicrosPerMillion: 1_000_000, outputPriceMicrosPerMillion: 4_000_000, pricingVerifiedAt: '2026-08-16',
  }] }),
};
