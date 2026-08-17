import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { AuthGate, type AuthClient, useAdminSession } from '../auth/AuthGate';
import { authClient, narrativeApi } from '../lib/supabase';
import type { NarrativeApi } from '../api/narrativeApi';
import { TodayPage } from '../features/today/TodayPage';
import { DraftListPage } from '../features/drafts/DraftListPage';
import { DraftReviewPage } from '../features/drafts/DraftReviewPage';
import { MemoryPage } from '../features/memory/MemoryPage';
import { SchedulesPage } from '../features/schedules/SchedulesPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import './admin.css';

const routes = [
  { path: '/', label: '오늘', title: '오늘' },
  { path: '/drafts', label: '초안', title: '초안' },
  { path: '/memory', label: '기억', title: '기억' },
  { path: '/schedules', label: '일정', title: '일정' },
  { path: '/settings', label: '설정', title: '설정' },
] as const;

function DocumentTitle() {
  const location = useLocation();
  useEffect(() => {
    const route = [...routes].sort((left, right) => right.path.length - left.path.length)
      .find((candidate) => candidate.path === '/' ? location.pathname === '/' : location.pathname.startsWith(candidate.path));
    document.title = `${route?.title ?? '천무'} · 천무 서사 편집실`;
  }, [location]);
  return null;
}

function DraftRoute({ api, readOnly }: { api: NarrativeApi; readOnly: boolean }) {
  const { draftId } = useParams();
  const navigate = useNavigate();
  return draftId ? <DraftReviewPage api={api} draftId={draftId} readOnly={readOnly} onRejected={() => navigate('/drafts?view=rejected', { state: { reviewMessage: '거절했습니다. 사유가 다음 생성의 수정 지침에 저장됐습니다.' } })} /> : <p role="alert">초안 ID가 없습니다.</p>;
}

function PasswordChangeDialog({ onClose }: { onClose(): void }) {
  const session = useAdminSession();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (password !== confirmation) return setMessage('새 비밀번호가 서로 다릅니다.');
    const changed = await session?.changePassword(password);
    if (!changed) return setMessage('비밀번호를 변경하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    setPassword('');
    setConfirmation('');
    setMessage('비밀번호를 변경했습니다.');
  };

  return <div className="modal-backdrop"><div role="dialog" aria-modal="true" aria-labelledby="password-dialog-title" className="modal">
    <h2 id="password-dialog-title">비밀번호 변경</h2>
    <p>다른 곳에서 쓰지 않는 12자 이상의 비밀번호를 사용해 주세요.</p>
    <form onSubmit={submit}>
      <label htmlFor="new-password">새 비밀번호</label>
      <input id="new-password" type="password" autoComplete="new-password" minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} required />
      <label htmlFor="new-password-confirmation">새 비밀번호 확인</label>
      <input id="new-password-confirmation" type="password" autoComplete="new-password" minLength={12} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} required />
      <button type="submit">비밀번호 저장</button>
    </form>
    {message && <p role="status">{message}</p>}
    <button type="button" onClick={onClose}>닫기</button>
  </div></div>;
}

export function AdminShell({ children, utility, notice }: { children: ReactNode; utility?: ReactNode; notice?: ReactNode }) {
  const session = useAdminSession();
  const [changingPassword, setChangingPassword] = useState(false);
  return (
    <div className="admin-shell">
      <aside className="admin-shell__rail">
        <p className="admin-shell__brand"><strong>천무</strong><span>서사 편집실</span></p>
        <nav className="admin-shell__nav" aria-label="관리자 메뉴">{routes.map((route) => <NavLink key={route.path} to={route.path} end={route.path === '/'}>{route.label}</NavLink>)}</nav>
        <div className="admin-shell__utility">
          {utility}
          {session && <button type="button" className="admin-shell__account" aria-label="비밀번호 변경" onClick={() => setChangingPassword(true)}>비밀번호</button>}
          {session && <button type="button" className="admin-shell__signout" onClick={() => void session.signOut()}>로그아웃</button>}
        </div>
      </aside>
      <main className="admin-shell__main">
        {notice}
        {children}
      </main>
      {changingPassword && <PasswordChangeDialog onClose={() => setChangingPassword(false)} />}
    </div>
  );
}

export function PrivateAdminRoutes({ api, readOnly = false, utility, notice }: { api: NarrativeApi; readOnly?: boolean; utility?: ReactNode; notice?: ReactNode }) {
  return <AdminShell utility={utility} notice={notice}>
    <DocumentTitle />
    <Routes>
        <Route path="/" element={<TodayPage api={api} readOnly={readOnly} />} />
        <Route path="/drafts" element={<DraftListPage api={api} />} />
        <Route path="/drafts/:draftId" element={<DraftRoute api={api} readOnly={readOnly} />} />
        <Route path="/memory" element={<MemoryPage api={api} readOnly={readOnly} />} />
        <Route path="/schedules" element={<SchedulesPage api={api} readOnly={readOnly} />} />
        <Route path="/settings" element={<SettingsPage api={api} readOnly={readOnly} />} />
    </Routes>
  </AdminShell>;
}

export function AdminApp({ client = authClient, api = narrativeApi }: { client?: AuthClient; api?: NarrativeApi }) {
  return <AuthGate client={client}><BrowserRouter><PrivateAdminRoutes api={api} /></BrowserRouter></AuthGate>;
}
