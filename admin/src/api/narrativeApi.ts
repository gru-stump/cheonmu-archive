export type DraftStatus = 'queued' | 'generating' | 'generated' | 'reviewing' | 'rejected' | 'archived' | 'approved_private' | 'approved' | 'publishing' | 'published' | 'publish_failed';
export type DraftKind = 'short_dialogue' | 'daily_event' | 'major_event_proposal';
export const archiveSourceStatuses = ['generated', 'reviewing', 'rejected', 'approved_private', 'publish_failed'] as const;
export type ArchiveSourceStatus = (typeof archiveSourceStatuses)[number];

export function isArchiveSourceStatus(status: DraftStatus): status is ArchiveSourceStatus {
  return archiveSourceStatuses.includes(status as ArchiveSourceStatus);
}

export interface ContinuityFinding {
  code: string;
  level: 'pass' | 'review' | 'block';
  message: string;
  sourceIds: string[];
}

export interface DraftVersion {
  id: string;
  versionNumber: number;
  createdAt: string;
  content: { title: string; body: string; canonChangeCandidates: string[]; [key: string]: unknown };
  contextVersionIds: string[];
  continuityLevel: 'pass' | 'review' | 'block' | null;
  continuityFindings: ContinuityFinding[];
}

export interface DraftSummary {
  id: string;
  kind: DraftKind;
  status: DraftStatus;
  title: string;
  updatedAt: string;
  latestVersionId: string | null;
  continuityLevel: DraftVersion['continuityLevel'];
}

export interface DraftDetail extends Omit<DraftSummary, 'updatedAt' | 'continuityLevel'> {
  latestVersionId: string;
  latestVersion: DraftVersion;
  versions: DraftVersion[];
  revisionPricing?: {
    maximumInputTokens: number;
    inputCostMicrosPerMillion: number;
    outputCostMicrosPerMillion: number;
    fixedCostMicros: number;
    maximumRevisionOutputTokens: number;
  };
}

export interface DashboardData {
  budget: {
    dailySpentMicros: number;
    monthlySpentMicros: number;
    reservedMicros: number;
    dailyRemainingMicros: number;
    monthlyRemainingMicros: number;
  };
  nextScheduleAt: string | null;
  lastSuccessAt: string | null;
  failures: Array<{ id: string; occurredAt: string; code: string }>;
}

export type MemoryType = 'canon' | 'continuity' | 'summary' | 'feedback' | 'unresolved';
export interface MemoryHistoryEntry { id: string; content: string; note: string | null; createdAt: string }
export interface MemoryItem {
  id: string;
  memoryType: MemoryType;
  content: string;
  enabled: boolean;
  createdAt: string;
  correctionHistory: MemoryHistoryEntry[];
}
export interface MemoryData {
  fixedCanon: MemoryItem[];
  continuity: MemoryItem[];
  recent: MemoryItem[];
  feedback: MemoryItem[];
  unresolved: MemoryItem[];
}

export type ScheduleType = 'automatic' | 'manual' | 'special';
export interface NarrativeSchedule {
  id: string;
  scheduleKey: string;
  scheduleType: ScheduleType;
  enabled: boolean;
  seoulTime: string;
  weekday: number | null;
  specialDate: string | null;
  minimumIntervalMinutes: number;
  kind: 'short_dialogue' | 'daily_event';
  lastRunAt: string | null;
  nextRunAt: string | null;
}
export type SaveScheduleInput = Omit<NarrativeSchedule, 'id' | 'lastRunAt' | 'nextRunAt'> & { scheduleId?: string };

export interface ProviderSetting {
  providerKey: 'openai' | 'anthropic' | 'fake-local-provider';
  enabled: boolean;
  modelKey: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxRevisionOutputTokens: number;
  inputPriceMicrosPerMillion: number;
  outputPriceMicrosPerMillion: number;
  pricingVerifiedAt: string;
}
export interface NarrativeSettings {
  automationEnabled: boolean;
  pricingValidDays: number;
  providers: ProviderSetting[];
  budget: {
    monthlyLimitMicros: number;
    dailyLimitMicros: number;
    spentMicros: number;
    reservedMicros: number;
    manualCallLimit: number;
    warningThresholdPercent: number;
    riskThresholdPercent: number;
    krwPerUsd: number;
  };
  secrets: Record<'openai' | 'anthropic' | 'github', boolean>;
}
export interface SaveSettingsInput {
  automationEnabled: boolean;
  activeProviderKey: ProviderSetting['providerKey'] | null;
  pricingValidDays: number;
  providers: Array<Omit<ProviderSetting, 'enabled'>>;
  monthlyLimitMicros: number;
  dailyLimitMicros: number;
  manualCallLimit: number;
  warningThresholdPercent: number;
  riskThresholdPercent: number;
  krwPerUsd: number;
}

export interface GenerateInput {
  draftId: string;
  expectedVersionId: string;
  expectedState: 'generated' | 'reviewing';
  mode: 'revise_selection';
  kind: DraftKind;
  revision: { selectedText: string; instruction: string };
  requestedMaxOutputTokens: number;
  maximumCostConfirmed: true;
  confirmedMaximumCostMicros: number;
}

export interface ReviewInput {
  draftId: string;
  expectedVersionId: string;
  expectedState: 'generated' | 'reviewing';
  action: 'reject' | 'approve_private' | 'approve_public';
  reason?: string;
}

export interface NarrativeApi {
  getDashboard(): Promise<DashboardData>;
  listDrafts(input?: { status?: DraftStatus | 'active' }): Promise<DraftSummary[]>;
  getDraft(draftId: string): Promise<DraftDetail>;
  generate(input: GenerateInput): Promise<{ draftId: string; versionId: string; status: 'generated'; continuityLevel: 'pass' | 'review' | 'block' }>;
  saveManualVersion(input: { draftId: string; expectedVersionId: string; expectedState: 'generated' | 'reviewing'; content: DraftVersion['content'] }): Promise<{ version: DraftVersion }>;
  review(input: ReviewInput): Promise<{ draftId: string; versionId: string; status: 'rejected' | 'approved_private' | 'approved' }>;
  retryPublish(input: { draftId: string; expectedVersionId: string; expectedState: 'publish_failed' }): Promise<{ status: 'publishing' }>;
  archive(input: { draftId: string; expectedVersionId: string; expectedState: ArchiveSourceStatus }): Promise<{ status: 'archived' }>;
  getMemory(): Promise<MemoryData>;
  setMemoryEnabled(input: { memoryId: string; enabled: boolean }): Promise<{ enabled: boolean }>;
  correctMemory(input: { memoryId: string; content: string; note: string }): Promise<{ memoryId: string }>;
  getSchedules(): Promise<{ schedules: NarrativeSchedule[] }>;
  saveSchedule(input: SaveScheduleInput): Promise<{ scheduleId: string }>;
  getSettings(): Promise<NarrativeSettings>;
  saveSettings(input: SaveSettingsInput): Promise<{ saved: true }>;
  saveSecret(input: { kind: 'openai' | 'anthropic' | 'github'; value: string }): Promise<{ configured: boolean }>;
}

export class NarrativeApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
    this.name = 'NarrativeApiError';
  }
}

type ApiConfig = { tokenProvider(): Promise<string | null>; fetch?: typeof globalThis.fetch };

export function createNarrativeApi({ tokenProvider, fetch = globalThis.fetch }: ApiConfig): NarrativeApi {
  const request = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
    const token = await tokenProvider();
    if (!token) throw new NarrativeApiError(401, 'authentication_required');
    const response = await fetch(`/api/narrative/${path}`, {
      ...init,
      headers: { accept: 'application/json', authorization: `Bearer ${token}`, ...(init.body ? { 'content-type': 'application/json' } : {}), ...init.headers },
    });
    const data = await response.json().catch(() => ({})) as { error?: string };
    if (!response.ok) throw new NarrativeApiError(response.status, data.error ?? 'request_failed');
    return data as T;
  };
  const post = <T>(path: string, body: unknown) => request<T>(path, { method: 'POST', body: JSON.stringify(body) });

  return {
    getDashboard: () => request<DashboardData>('dashboard'),
    listDrafts: async (input = {}) => {
      const result = await request<{ drafts: DraftSummary[] }>(`drafts${input.status ? `?status=${encodeURIComponent(input.status)}` : ''}`);
      return result.drafts;
    },
    getDraft: (draftId) => request<DraftDetail>(`drafts/${encodeURIComponent(draftId)}`),
    generate: (input) => input.mode === 'revise_selection'
      ? post('generate', input)
      : Promise.reject(new NarrativeApiError(400, 'unsupported_generation_mode')),
    saveManualVersion: (input) => post(`drafts/${encodeURIComponent(input.draftId)}/manual-version`, input),
    review: (input) => post(`drafts/${encodeURIComponent(input.draftId)}/review`, input),
    retryPublish: (input) => post(`drafts/${encodeURIComponent(input.draftId)}/retry-publish`, input),
    archive: (input) => isArchiveSourceStatus(input.expectedState)
      ? post(`drafts/${encodeURIComponent(input.draftId)}/archive`, input)
      : Promise.reject(new NarrativeApiError(400, 'invalid_archive_state')),
    getMemory: () => request<MemoryData>('memory'),
    setMemoryEnabled: (input) => post(`memory/${encodeURIComponent(input.memoryId)}/enabled`, input),
    correctMemory: (input) => post(`memory/${encodeURIComponent(input.memoryId)}/corrections`, input),
    getSchedules: () => request<{ schedules: NarrativeSchedule[] }>('schedules'),
    saveSchedule: (input) => post(`schedules${input.scheduleId ? `/${encodeURIComponent(input.scheduleId)}` : ''}`, input),
    getSettings: () => request<NarrativeSettings>('settings'),
    saveSettings: (input) => post('settings', input),
    saveSecret: (input) => post('settings/secret', input),
  };
}
