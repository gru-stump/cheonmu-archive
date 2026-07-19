export type EditorKind = 'records' | 'profiles' | 'documents';

export interface EditorEntry {
  id: string;
  source: string;
}

export interface EditorSaveRequest extends EditorEntry {
  kind: EditorKind;
}

export interface EditorApi {
  list(kind: EditorKind): Promise<EditorEntry[]>;
  save(entry: EditorSaveRequest): Promise<EditorEntry>;
  remove?(kind: EditorKind, id: string): Promise<void>;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const problem = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(problem.error ?? '편집기 요청에 실패했습니다.');
  }
  return response.json() as Promise<T>;
}

export const editorApi: EditorApi = {
  list: (kind) => request<EditorEntry[]>(`/api/editor/${kind}`),
  save: ({ kind, id, source }) => request<EditorEntry>(`/api/editor/${kind}/${id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  }),
  remove: async (kind, id) => { await request(`/api/editor/${kind}/${id}`, { method: 'DELETE' }); },
};
