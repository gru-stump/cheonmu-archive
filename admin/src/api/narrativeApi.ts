export type DraftStatus = 'queued' | 'generating' | 'generated' | 'reviewing' | 'rejected' | 'archived' | 'approved_private' | 'approved' | 'publishing' | 'published' | 'publish_failed';
export type DraftKind = 'short_dialogue' | 'daily_event' | 'major_event_proposal';

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

export interface GenerateInput {
  draftId: string;
  expectedVersionId?: string;
  expectedState?: 'generated' | 'reviewing';
  mode: 'new' | 'revise_selection' | 'major_event_scene_plan' | 'major_event_draft';
  kind: DraftKind;
  seed?: string;
  revision?: { selectedText: string; instruction: string };
  requestedMaxOutputTokens?: number;
  maximumCostConfirmed?: boolean;
  confirmedMaximumCostMicros?: number;
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
  archive(input: { draftId: string; expectedVersionId: string; expectedState: DraftStatus }): Promise<{ status: 'archived' }>;
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
    generate: (input) => post('generate', input),
    saveManualVersion: (input) => post(`drafts/${encodeURIComponent(input.draftId)}/manual-version`, input),
    review: (input) => post(`drafts/${encodeURIComponent(input.draftId)}/review`, input),
    retryPublish: (input) => post(`drafts/${encodeURIComponent(input.draftId)}/retry-publish`, input),
    archive: (input) => post(`drafts/${encodeURIComponent(input.draftId)}/archive`, input),
  };
}
