import type { GalleryItem } from '../content/schema';

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
  remove(kind: EditorKind, id: string): Promise<void>;
  listGallery(): Promise<GalleryItem[]>;
  saveGallery(item: GalleryItem): Promise<GalleryItem>;
  removeGallery(id: string): Promise<void>;
  uploadGalleryImage(request: GalleryImageUploadRequest): Promise<GalleryImageUpload>;
  saveGalleryWithImage(request: GalleryCombinedSaveRequest): Promise<GalleryCombinedSave>;
  planGallery?(request: GalleryPlanRequest): Promise<GalleryChangePlan>;
}

export class EditorApiError extends Error {
  constructor(message: string, readonly fields: Record<string, string> = {}, readonly status?: number) {
    super(message);
    this.name = 'EditorApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const problem = await response.json().catch(() => ({})) as {
      error?: string;
      fields?: Record<string, string>;
    };
    throw new EditorApiError(problem.error ?? '편집기 요청에 실패했습니다.', problem.fields, response.status);
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
  remove: async (kind, id) => {
    await request(`/api/editor/${kind}/${id}`, { method: 'DELETE' });
  },
  listGallery: () => request<GalleryItem[]>('/api/editor/gallery'),
  saveGallery: (item) => request<GalleryItem>(`/api/editor/gallery/${item.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(item),
  }),
  removeGallery: async (id) => {
    await request(`/api/editor/gallery/${id}`, { method: 'DELETE' });
  },
  uploadGalleryImage: async ({ id, file, overwrite }) => request<GalleryImageUpload>('/api/editor/gallery/image', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Gallery-Id': id,
      'X-File-Name': encodeURIComponent(file.name),
      'X-Confirm-Overwrite': String(overwrite),
    },
    body: file,
  }),
  saveGalleryWithImage: async ({ item, file, overwrite }) => request<GalleryCombinedSave>(`/api/editor/gallery/${item.id}/image`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Gallery-Metadata': encodeURIComponent(JSON.stringify(item)),
      'X-Confirm-Overwrite': String(overwrite),
    },
    body: file,
  }),
  planGallery: async ({ item, file, deleting = false }) => {
    if (deleting) {
      return request<GalleryChangePlan>(`/api/editor/gallery/${item.id}/plan`, { method: 'DELETE' });
    }
    if (file) {
      return request<GalleryChangePlan>(`/api/editor/gallery/${item.id}/image/plan`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Gallery-Metadata': encodeURIComponent(JSON.stringify(item)),
        },
        body: file,
      });
    }
    return request<GalleryChangePlan>(`/api/editor/gallery/${item.id}/plan`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    });
  },
};

export interface GalleryImageUploadRequest {
  id: string;
  file: File;
  overwrite: boolean;
}

export interface GalleryImageUpload {
  path: string;
  width: number;
  height: number;
}

export interface GalleryCombinedSaveRequest {
  item: GalleryItem;
  file: File;
  overwrite: boolean;
}

export interface GalleryCombinedSave {
  item: GalleryItem;
  image: GalleryImageUpload;
}

export interface GalleryChangePlan {
  item: GalleryItem;
  changes: GalleryChange[];
}

export interface GalleryPlanRequest {
  item: GalleryItem;
  file?: File;
  deleting?: boolean;
}

export type GalleryChange =
  | { action: 'metadata'; path: string; visibility: 'metadata' }
  | { action: 'stage'; path: string; visibility: 'stage' }
  | { action: 'write'; path: string; visibility: 'public' | 'private' }
  | { action: 'move'; path: string; destination: string; visibility: 'public' | 'private' }
  | { action: 'trash'; path: string; visibility: 'trash' };
