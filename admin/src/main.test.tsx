import { beforeEach, describe, expect, it, vi } from 'vitest';

const rootRender = vi.hoisted(() => vi.fn());
vi.mock('react-dom/client', () => ({ createRoot: () => ({ render: rootRender }) }));

async function renderedApp() {
  await import('./main');
  await vi.waitFor(() => expect(rootRender).toHaveBeenCalled());
  const strictMode = rootRender.mock.calls.at(-1)?.[0] as { props: { children: { type: { name: string }; props: Record<string, unknown> } } };
  return strictMode.props.children;
}

describe('admin entry local preview gate', () => {
  beforeEach(() => { vi.resetModules(); vi.unstubAllEnvs(); rootRender.mockReset(); document.body.innerHTML = '<div id="root"></div>'; });

  it('injects the local preview API only for development with the explicit flag', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_ENABLE_LOCAL_PREVIEW', 'true');

    const app = await renderedApp();

    expect(app.type.name).toBe('LocalPreviewApp');
    expect(app.props.previewAuth).toBeDefined();
    expect(app.props.previewApi).toBeDefined();
  });

  it('does not inject preview when the explicit flag is absent', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_ENABLE_LOCAL_PREVIEW', undefined);

    const app = await renderedApp();

    expect(app.type.name).toBe('AdminApp');
    expect(app.props.previewAuth).toBeUndefined();
    expect(app.props.previewApi).toBeUndefined();
  });

  it('does not inject preview in production even when the flag is present', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_ENABLE_LOCAL_PREVIEW', 'true');

    const app = await renderedApp();

    expect(app.type.name).toBe('AdminApp');
    expect(app.props.previewAuth).toBeUndefined();
    expect(app.props.previewApi).toBeUndefined();
  });

  it('loads deterministic fixtures only in development with the explicit E2E flag', async () => {
    vi.stubEnv('DEV', true);
    vi.stubEnv('VITE_ENABLE_E2E_FIXTURE', 'true');

    const app = await renderedApp();

    expect(app.type.name).toBe('E2EFixtureApp');
  });

  it('does not load deterministic fixtures in production', async () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('VITE_ENABLE_E2E_FIXTURE', 'true');

    const app = await renderedApp();

    expect(app.type.name).toBe('AdminApp');
  });
});
