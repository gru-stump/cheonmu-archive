import { BrowserRouter, NavLink, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useEffect, type ReactNode } from 'react';
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

export function AdminShell({ children, utility, notice }: { children: ReactNode; utility?: ReactNode; notice?: ReactNode }) {
  const session = useAdminSession();
  return (
    <div className="admin-shell">
      <aside className="admin-shell__rail">
        <p className="admin-shell__brand"><strong>천무</strong><span>서사 편집실</span></p>
        <nav className="admin-shell__nav" aria-label="관리자 메뉴">{routes.map((route) => <NavLink key={route.path} to={route.path} end={route.path === '/'}>{route.label}</NavLink>)}</nav>
        <div className="admin-shell__utility">
          {utility}
          {session && <button type="button" className="admin-shell__signout" onClick={() => void session.signOut()}>로그아웃</button>}
        </div>
      </aside>
      <main className="admin-shell__main">
        {notice}
        {children}
      </main>
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
