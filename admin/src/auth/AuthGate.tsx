import { createContext, type FormEvent, type ReactNode, useContext, useEffect, useState } from 'react';

export interface AuthSession {
  user: { id: string; email?: string | null };
  access_token?: string;
}

export interface AuthClient {
  auth: {
    getSession(): Promise<{ data: { session: AuthSession | null }; error: unknown }>;
    onAuthStateChange(callback: (event: string, session: AuthSession | null) => void): {
      data: { subscription: { unsubscribe(): void } };
    };
    signInWithOtp(input: { email: string; options: { emailRedirectTo: string } }): Promise<{ error: { message?: string } | null }>;
    signOut(): Promise<{ error: unknown }>;
  };
  ownerProfiles: {
    findByOwnerId(ownerId: string): Promise<{ data: { owner_id: string } | null; error: unknown }>;
  };
}

type GateState =
  | { kind: 'checking-session' }
  | { kind: 'checking-owner' }
  | { kind: 'signed-out' }
  | { kind: 'not-owner' }
  | { kind: 'owner' };

interface AdminSessionUtility {
  email?: string | null;
  signOut(): Promise<void>;
}

const AdminSessionContext = createContext<AdminSessionUtility | null>(null);

export const useAdminSession = () => useContext(AdminSessionContext);

export function AuthGate({ client, children }: { client: AuthClient; children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'checking-session' });
  const [email, setEmail] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let sessionVersion = 0;

    const resolveSession = async (session: AuthSession | null) => {
      const version = ++sessionVersion;
      if (!active) return;
      if (!session) {
        setState({ kind: 'signed-out' });
        return;
      }

      setState({ kind: 'checking-owner' });
      try {
        const membership = await client.ownerProfiles.findByOwnerId(session.user.id);
        if (!active || version !== sessionVersion) return;
        setState(membership.error || membership.data?.owner_id !== session.user.id ? { kind: 'not-owner' } : { kind: 'owner' });
      } catch {
        if (active && version === sessionVersion) setState({ kind: 'not-owner' });
      }
    };

    void client.auth.getSession()
      .then(({ data }) => resolveSession(data.session))
      .catch(() => { if (active) setState({ kind: 'signed-out' }); });
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => { void resolveSession(session); });
    return () => { active = false; subscription.unsubscribe(); };
  }, [client]);

  const sendMagicLink = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setMessage(null);
    const result = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
    setMessage(result.error ? '로그인 링크를 보내지 못했습니다. 잠시 후 다시 시도해 주세요.' : '로그인 링크를 이메일로 보냈습니다.');
  };

  const signOut = async () => {
    await client.auth.signOut();
    setState({ kind: 'signed-out' });
    setMessage(null);
  };

  if (state.kind === 'owner') {
    return <AdminSessionContext.Provider value={{ email: undefined, signOut }}>{children}</AdminSessionContext.Provider>;
  }
  if (state.kind === 'checking-session' || state.kind === 'checking-owner') {
    return <main className="auth-screen" aria-live="polite"><p>{state.kind === 'checking-owner' ? '권한을 확인하고 있습니다.' : '로그인 상태를 확인하고 있습니다.'}</p></main>;
  }
  if (state.kind === 'not-owner') {
    return <main className="auth-screen"><h1>관리자 권한이 없습니다.</h1><p>등록된 소유자 계정으로 로그인해 주세요.</p><button type="button" onClick={signOut}>로그아웃</button></main>;
  }
  return (
    <main className="auth-screen">
      <h1>천무 서사 관리</h1>
      <p>등록된 소유자 이메일로 로그인 링크를 받으세요.</p>
      <form onSubmit={sendMagicLink}>
        <label htmlFor="owner-email">이메일</label>
        <input id="owner-email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        <button type="submit">로그인 링크 받기</button>
      </form>
      {message && <p role="status">{message}</p>}
    </main>
  );
}
