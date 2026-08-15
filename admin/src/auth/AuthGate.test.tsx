import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate, type AuthClient, type AuthSession } from './AuthGate';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function createClient(options: {
  session?: AuthSession | null;
  owner?: { owner_id: string } | null;
  ownerPromise?: Promise<{ data: { owner_id: string } | null; error: null }>;
} = {}): AuthClient & { auth: AuthClient['auth'] & { signInWithOtp: ReturnType<typeof vi.fn>; signOut: ReturnType<typeof vi.fn> }; emitAuth(session: AuthSession | null): void } {
  const signInWithOtp = vi.fn().mockResolvedValue({ error: null });
  const signOut = vi.fn().mockResolvedValue({ error: null });
  let authListener: ((event: string, session: AuthSession | null) => void) | undefined;
  return {
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: options.session ?? null }, error: null }),
      onAuthStateChange: vi.fn().mockImplementation((listener) => { authListener = listener; return { data: { subscription: { unsubscribe: vi.fn() } } }; }),
      signInWithOtp,
      signOut,
    },
    ownerProfiles: {
      findByOwnerId: vi.fn().mockImplementation(() => options.ownerPromise ?? Promise.resolve({ data: options.owner ?? null, error: null })),
    },
    emitAuth: (session) => authListener?.('TOKEN_CHANGED', session),
  };
}

describe('AuthGate', () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('hides private content and offers an email magic link when signed out', async () => {
    const client = createClient();

    render(<AuthGate client={client}><p>비공개 초안</p></AuthGate>);

    expect(screen.queryByText('비공개 초안')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '로그인 링크 받기' })).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('이메일'), 'owner@example.com');
    await userEvent.click(screen.getByRole('button', { name: '로그인 링크 받기' }));
    expect(client.auth.signInWithOtp).toHaveBeenCalledWith({
      email: 'owner@example.com',
      options: { emailRedirectTo: window.location.origin },
    });
  });

  it('does not render private content until the restored session owner membership resolves', async () => {
    const membership = deferred<{ data: { owner_id: string } | null; error: null }>();
    const client = createClient({ session: { user: { id: 'owner-1', email: 'owner@example.com' } }, ownerPromise: membership.promise });

    render(<AuthGate client={client}><p>비공개 초안</p></AuthGate>);

    expect(screen.queryByText('비공개 초안')).not.toBeInTheDocument();
    expect(await screen.findByText('권한을 확인하고 있습니다.')).toBeInTheDocument();

    await act(async () => membership.resolve({ data: { owner_id: 'owner-1' }, error: null }));
    expect(await screen.findByText('비공개 초안')).toBeInTheDocument();
  });

  it('blocks a signed-in user outside the server-stored owner allowlist and lets them log out', async () => {
    const client = createClient({ session: { user: { id: 'visitor-1', email: 'visitor@example.com' } }, owner: null });

    render(<AuthGate client={client}><p>비공개 초안</p></AuthGate>);

    expect(await screen.findByText('관리자 권한이 없습니다.')).toBeInTheDocument();
    expect(screen.queryByText('비공개 초안')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('lets an authenticated owner end their restored session', async () => {
    const client = createClient({ session: { user: { id: 'owner-1', email: 'owner@example.com' } }, owner: { owner_id: 'owner-1' } });

    render(<AuthGate client={client}><p>비공개 초안</p></AuthGate>);

    expect(await screen.findByText('비공개 초안')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '로그아웃' }));
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
  });

  it('keeps private content hidden when a sign-out overtakes an in-flight owner lookup', async () => {
    const membership = deferred<{ data: { owner_id: string } | null; error: null }>();
    const client = createClient({ session: { user: { id: 'owner-1' } }, ownerPromise: membership.promise });

    render(<AuthGate client={client}><p>비공개 초안</p></AuthGate>);
    expect(await screen.findByText('권한을 확인하고 있습니다.')).toBeInTheDocument();

    await act(async () => client.emitAuth(null));
    expect(await screen.findByRole('button', { name: '로그인 링크 받기' })).toBeInTheDocument();
    await act(async () => membership.resolve({ data: { owner_id: 'owner-1' }, error: null }));
    expect(screen.queryByText('비공개 초안')).not.toBeInTheDocument();
  });

  it('does not replace a newer signed-out state when an older owner lookup rejects', async () => {
    const membership = deferred<{ data: { owner_id: string } | null; error: null }>();
    const client = createClient({ session: { user: { id: 'owner-1' } }, ownerPromise: membership.promise });

    render(<AuthGate client={client}><p>비공개 초안</p></AuthGate>);
    expect(await screen.findByText('권한을 확인하고 있습니다.')).toBeInTheDocument();

    await act(async () => client.emitAuth(null));
    await act(async () => membership.reject(new Error('network failed')));
    expect(await screen.findByRole('button', { name: '로그인 링크 받기' })).toBeInTheDocument();
    expect(screen.queryByText('관리자 권한이 없습니다.')).not.toBeInTheDocument();
  });
});
