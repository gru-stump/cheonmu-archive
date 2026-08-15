import { useState } from 'react';
import { BrowserRouter } from 'react-router-dom';
import type { NarrativeApi } from '../api/narrativeApi';
import { AdminApp, PrivateAdminRoutes } from '../app/AdminApp';
import type { AuthClient } from '../auth/AuthGate';
import { AdminNotice } from '../components/AdminNotice';
import { AdminStatusBadge } from '../components/AdminStatusBadge';
import { authClient, narrativeApi } from '../lib/supabase';
import { localPreviewApi } from './localPreviewApi';
import './localPreview.css';

export interface PreviewAuth {
  enter(): Promise<{ owner: true }>;
}

export const localPreviewAuth: PreviewAuth = {
  enter: async () => ({ owner: true }),
};

export { localPreviewApi };

export function LocalPreviewApp({
  client = authClient,
  api = narrativeApi,
  previewAuth,
  previewApi,
}: {
  client?: AuthClient;
  api?: NarrativeApi;
  previewAuth: PreviewAuth;
  previewApi: NarrativeApi;
}) {
  const [preview, setPreview] = useState(false);
  const enter = async () => {
    const session = await previewAuth.enter();
    if (session.owner) setPreview(true);
  };

  if (preview) return <BrowserRouter><PrivateAdminRoutes api={previewApi} readOnly utility={<AdminStatusBadge tone="warning">로컬 둘러보기</AdminStatusBadge>} notice={<AdminNotice tone="readonly">로컬 둘러보기 · 저장되지 않음</AdminNotice>} /></BrowserRouter>;
  return <><AdminApp client={client} api={api} /><aside className="preview-entry" aria-label="로컬 미리보기"><button type="button" onClick={() => void enter()}>둘러보기</button></aside></>;
}
