import type { DraftDetail, DraftVersion, MemoryData, NarrativeApi, NarrativeSchedule, NarrativeSettings } from '../api/narrativeApi';

const createdAt = '2026-08-15T03:00:00.000Z';
const longBody = `비가 그친 뒤에도 처마 끝에서는 물방울이 천천히 떨어졌다.

천령은 젖은 소매를 털며 무영 쪽으로 반 걸음 물러섰다. “오늘은 네가 먼저 말해.”

무영은 대답 대신 따뜻한 찻잔을 밀어 두었다. 오래된 약속을 서두르지 않는 방식이었다.

두 사람 사이에 남은 빗소리는 말보다 조용했고, 그래서 더 오래 기억될 것 같았다.`;

function version(id: string, body = longBody, level: DraftVersion['continuityLevel'] = 'pass'): DraftVersion {
  return {
    id: `${id}-v1`, versionNumber: 1, createdAt,
    content: { title: id === 'e2e-blocked-draft' ? '금지된 이름' : '비 갠 뒤의 약속', body, canonChangeCandidates: level === 'block' ? ['공개 전 핵심 비밀'] : [] },
    contextVersionIds: ['canon-cheonryeong-voice-v3', 'continuity-rain-promise-v2'],
    continuityLevel: level,
    continuityFindings: level === 'block' ? [{ code: 'SECRET_EARLY', level: 'block', message: '아직 공개할 수 없는 핵심 비밀입니다.', sourceIds: ['canon-secret-order-v4'] }] : [],
  };
}

function makeDraft(id: string, title: string, level: DraftVersion['continuityLevel'] = 'pass', status: DraftDetail['status'] = 'generated'): DraftDetail {
  const initial = version(id, longBody, level);
  return { id, kind: 'short_dialogue', status, title, latestVersionId: initial.id, latestVersion: initial, versions: [initial] };
}

export interface E2EFixtureStore {
  drafts: Map<string, DraftDetail>;
  schedules: NarrativeSchedule[];
  privateApprovals: number;
  publishJobs: number;
}

export function createE2EFixture() {
  const store: E2EFixtureStore = {
    drafts: new Map([
      ['e2e-access-draft', makeDraft('e2e-access-draft', '비 갠 뒤의 약속')],
      ['e2e-blocked-draft', makeDraft('e2e-blocked-draft', '금지된 이름', 'block')],
      ['e2e-reviewing-draft', makeDraft('e2e-reviewing-draft', '찻잔 가장자리', 'review', 'reviewing')],
      ['e2e-published-draft', makeDraft('e2e-published-draft', '돌아온 새벽', 'pass', 'published')],
    ]),
    schedules: [{ id: 'schedule-daily', scheduleKey: 'daily', scheduleType: 'automatic', enabled: true, seoulTime: '09:00', weekday: null, specialDate: null, minimumIntervalMinutes: 1440, kind: 'daily_event', lastRunAt: createdAt, nextRunAt: '2026-08-16T00:00:00.000Z' }],
    privateApprovals: 0,
    publishJobs: 0,
  };
  const memory: MemoryData = {
    fixedCanon: [{ id: 'canon-1', memoryType: 'canon', content: '천령은 감정을 단정하기보다 행동으로 드러낸다.', enabled: true, createdAt, correctionHistory: [] }],
    continuity: [{ id: 'continuity-1', memoryType: 'continuity', content: '비 오는 날 다시 만나기로 약속했다.', enabled: true, createdAt, correctionHistory: [{ id: 'history-1', content: '다시 만나기로 했다.', note: '날씨 맥락 보강', createdAt }] }],
    recent: [{ id: 'recent-1', memoryType: 'summary', content: '두 사람은 임무 뒤 처마 아래에서 쉬었다.', enabled: true, createdAt, correctionHistory: [] }],
    feedback: [{ id: 'feedback-1', memoryType: 'feedback', content: '현대식 농담은 사용하지 않는다.', enabled: true, createdAt, correctionHistory: [] }],
    unresolved: [{ id: 'unresolved-1', memoryType: 'unresolved', content: '젖은 매듭 장식의 출처가 남아 있다.', enabled: false, createdAt, correctionHistory: [] }],
  };
  const settings: NarrativeSettings = {
    manualGenerationEnabled: true, scheduleAutomationEnabled: false, pricingValidDays: 30,
    providers: [{ providerKey: 'fake-local-provider', enabled: true, modelKey: 'deterministic-local', maxInputTokens: 4096, maxOutputTokens: 1024, maxRevisionOutputTokens: 256, inputPriceMicrosPerMillion: 1000, outputPriceMicrosPerMillion: 2000, pricingVerifiedAt: '2026-08-15' }],
    budget: { monthlyLimitMicros: 100_000_000, dailyLimitMicros: 20_000_000, spentMicros: 2_700, reservedMicros: 0, manualCallLimit: 3, warningThresholdPercent: 80, riskThresholdPercent: 95, krwPerUsd: 1380 },
    secrets: { openai: false, anthropic: false, github: false },
  };
  const api: NarrativeApi = {
    getDashboard: async () => ({ budget: { dailySpentMicros: 2_700, monthlySpentMicros: 18_400, reservedMicros: 0, dailyRemainingMicros: 19_997_300, monthlyRemainingMicros: 99_981_600 }, nextScheduleAt: '2026-08-16T00:00:00.000Z', lastSuccessAt: createdAt, failures: [] }),
    listDrafts: async () => [...store.drafts.values()].filter((draft) => draft.status !== 'archived').map((draft) => ({ id: draft.id, kind: draft.kind, status: draft.status, title: draft.title, updatedAt: draft.latestVersion.createdAt, latestVersionId: draft.latestVersionId, continuityLevel: draft.latestVersion.continuityLevel })),
    getDraft: async (id) => {
      const draft = store.drafts.get(id);
      if (!draft) throw new Error('draft_not_found');
      return structuredClone(draft);
    },
    generate: async (input) => {
      const draftId = 'draftId' in input ? input.draftId : `e2e-manual-${store.drafts.size + 1}`;
      if (!('draftId' in input)) {
        const draft = makeDraft(draftId, input.title);
        draft.kind = input.kind;
        store.drafts.set(draftId, draft);
      }
      return { draftId, versionId: store.drafts.get(draftId)!.latestVersionId, status: 'generated', continuityLevel: 'pass' };
    },
    saveManualVersion: async (input) => {
      const draft = store.drafts.get(input.draftId)!;
      const next: DraftVersion = { ...draft.latestVersion, id: `${draft.id}-v${draft.versions.length + 1}`, versionNumber: draft.versions.length + 1, content: input.content, createdAt: '2026-08-15T03:10:00.000Z' };
      draft.latestVersion = next; draft.latestVersionId = next.id; draft.versions.push(next); draft.status = 'reviewing';
      return { version: structuredClone(next) };
    },
    review: async (input) => {
      const draft = store.drafts.get(input.draftId)!;
      draft.status = input.action === 'reject' ? 'rejected' : input.action === 'approve_private' ? 'approved_private' : 'approved';
      if (input.action === 'approve_private') store.privateApprovals += 1;
      if (input.action === 'approve_public') store.publishJobs += 1;
      return { draftId: draft.id, versionId: draft.latestVersionId, status: draft.status as 'rejected' | 'approved_private' | 'approved' };
    },
    retryPublish: async () => ({ status: 'publishing' }), archive: async () => ({ status: 'archived' }), restore: async () => ({ status: 'generated' }),
    getMemory: async () => structuredClone(memory), setMemoryEnabled: async ({ enabled }) => ({ enabled }), correctMemory: async ({ memoryId }) => ({ memoryId }),
    getSchedules: async () => ({ schedules: structuredClone(store.schedules) }),
    saveSchedule: async (input) => {
      const id = input.scheduleId ?? `schedule-special-${store.schedules.length}`;
      const row: NarrativeSchedule = { ...input, id, lastRunAt: null, nextRunAt: input.specialDate ? `${input.specialDate}T00:00:00.000Z` : null };
      const index = store.schedules.findIndex((item) => item.id === id);
      if (index >= 0) store.schedules[index] = row; else store.schedules.push(row);
      return { scheduleId: id };
    },
    getSettings: async () => structuredClone(settings), saveSettings: async () => ({ saved: true }), saveSecret: async () => ({ configured: true }),
  };
  const createRejectDraft = () => {
    if (!store.drafts.has('e2e-reject-draft')) store.drafts.set('e2e-reject-draft', makeDraft('e2e-reject-draft', '등불 아래의 농담'));
  };
  return { api, store, createRejectDraft };
}
