import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApp } from './app/AdminApp';

const root = createRoot(document.getElementById('root')!);
const render = (app: ReactNode = <AdminApp />) => root.render(<StrictMode>{app}</StrictMode>);

if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_E2E_FIXTURE === 'true') {
  void import('./e2e-fixtures/E2EFixtureApp')
    .then(({ E2EFixtureApp }) => render(<E2EFixtureApp />))
    .catch(() => render());
} else if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_LOCAL_PREVIEW === 'true') {
  void import('./preview/LocalPreviewApp')
    .then(({ LocalPreviewApp, localPreviewApi, localPreviewAuth }) => render(<LocalPreviewApp previewAuth={localPreviewAuth} previewApi={localPreviewApi} />))
    .catch(() => render());
} else render();
