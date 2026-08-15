import { BrowserRouter, NavLink, Route, Routes } from 'react-router-dom';
import { AuthGate, type AuthClient } from '../auth/AuthGate';
import { authClient } from '../lib/supabase';
import './admin.css';

const routes = [
  { path: '/', label: '오늘', title: '오늘' },
  { path: '/drafts', label: '초안', title: '초안' },
  { path: '/memory', label: '기억', title: '기억' },
  { path: '/schedules', label: '일정', title: '일정' },
  { path: '/settings', label: '설정', title: '설정' },
] as const;

function PlaceholderPage({ title }: { title: string }) {
  return <section aria-labelledby="page-title"><h1 id="page-title">{title}</h1><p>이 기능은 다음 작업에서 연결됩니다.</p></section>;
}

function PrivateAdminRoutes() {
  return (
    <div className="admin-shell">
      <header className="admin-header"><p>천무 서사 관리</p><nav aria-label="관리자 메뉴">{routes.map((route) => <NavLink key={route.path} to={route.path} end={route.path === '/'}>{route.label}</NavLink>)}</nav></header>
      <main><Routes>{routes.map((route) => <Route key={route.path} path={route.path} element={<PlaceholderPage title={route.title} />} />)}</Routes></main>
    </div>
  );
}

export function AdminApp({ client = authClient }: { client?: AuthClient }) {
  return <AuthGate client={client}><BrowserRouter><PrivateAdminRoutes /></BrowserRouter></AuthGate>;
}
