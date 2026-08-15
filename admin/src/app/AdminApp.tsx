import { BrowserRouter, NavLink, Route, Routes, useParams } from 'react-router-dom';
import { AuthGate, type AuthClient } from '../auth/AuthGate';
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

function DraftRoute({ api }: { api: NarrativeApi }) {
  const { draftId } = useParams();
  return draftId ? <DraftReviewPage api={api} draftId={draftId} /> : <p role="alert">초안 ID가 없습니다.</p>;
}

function PrivateAdminRoutes({ api }: { api: NarrativeApi }) {
  return (
    <div className="admin-shell">
      <header className="admin-header"><p>천무 서사 관리</p><nav aria-label="관리자 메뉴">{routes.map((route) => <NavLink key={route.path} to={route.path} end={route.path === '/'}>{route.label}</NavLink>)}</nav></header>
      <main><Routes>
        <Route path="/" element={<TodayPage api={api} />} />
        <Route path="/drafts" element={<DraftListPage api={api} />} />
        <Route path="/drafts/:draftId" element={<DraftRoute api={api} />} />
        <Route path="/memory" element={<MemoryPage api={api} />} />
        <Route path="/schedules" element={<SchedulesPage api={api} />} />
        <Route path="/settings" element={<SettingsPage api={api} />} />
      </Routes></main>
    </div>
  );
}

export function AdminApp({ client = authClient, api = narrativeApi }: { client?: AuthClient; api?: NarrativeApi }) {
  return <AuthGate client={client}><BrowserRouter><PrivateAdminRoutes api={api} /></BrowserRouter></AuthGate>;
}
