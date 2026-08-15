import { BrowserRouter, Route, Routes, useParams } from 'react-router-dom';
import { AdminShell, PrivateAdminRoutes } from '../app/AdminApp';
import { AdminNotice } from '../components/AdminNotice';
import { AdminPageHeader } from '../components/AdminPageHeader';
import { AdminStatusBadge } from '../components/AdminStatusBadge';
import { SettingsPage } from '../features/settings/SettingsPage';
import { createE2EFixture } from './e2eFixtureApi';

const fixture = createE2EFixture();

function FixtureLanding() {
  return <><AdminPageHeader eyebrow="시각 검증" title="결정적 화면 표본" description="실제 소유자 여정은 로컬 Supabase 인증과 영속 상태를 별도 E2E에서 검증합니다." /><AdminNotice>시각 회귀 fixture가 준비되었습니다.</AdminNotice></>;
}

function VisualState() {
  const { state = 'loading' } = useParams();
  const states: Record<string, { title: string; tone: 'info' | 'success' | 'danger' | 'readonly'; text: string }> = {
    loading: { title: '불러오는 중', tone: 'info', text: '서사 기록을 불러오는 중입니다.' },
    empty: { title: '비어 있는 초안함', tone: 'info', text: '지금 검토할 초안이 없습니다.' },
    error: { title: '연결 오류', tone: 'danger', text: '기록을 불러오지 못했습니다. 다시 시도해 주세요.' },
    success: { title: '저장 완료', tone: 'success', text: '변경 사항을 안전하게 저장했습니다.' },
    'read-only': { title: '읽기 전용', tone: 'readonly', text: '로컬 둘러보기 · 저장되지 않음' },
    focus: { title: '키보드 초점', tone: 'info', text: '현재 작업의 초점 위치를 확인합니다.' },
  };
  const current = states[state] ?? states.loading;
  return <><AdminPageHeader eyebrow="상태 표본" title={current.title} description="명확한 상태 문구와 다음 행동을 함께 제공합니다." />{state !== 'read-only' && <AdminNotice tone={current.tone}>{current.text}</AdminNotice>}{state === 'error' && <button type="button">다시 시도</button>}{state === 'focus' && <button type="button" autoFocus>초점이 보이는 작업</button>}</>;
}

function VisualStateShell() {
  const { state } = useParams();
  const readOnly = state === 'read-only';
  return <AdminShell utility={readOnly ? <AdminStatusBadge tone="warning">로컬 둘러보기</AdminStatusBadge> : undefined} notice={readOnly ? <AdminNotice tone="readonly">로컬 둘러보기 · 저장되지 않음</AdminNotice> : undefined}><VisualState /></AdminShell>;
}

function AccessibilityFixture() {
  return <>
    <div className="admin-page-header" data-testid="outside-admin-heading">관리자 셸 밖의 문서 제목</div>
    <AdminShell><SettingsPage api={fixture.api} /></AdminShell>
  </>;
}

function ReadOnlySettingsFixture() {
  return <AdminShell utility={<AdminStatusBadge tone="warning">로컬 둘러보기</AdminStatusBadge>} notice={<AdminNotice tone="readonly">로컬 둘러보기 · 저장되지 않음</AdminNotice>}><SettingsPage api={fixture.api} readOnly /></AdminShell>;
}

export function E2EFixtureApp() {
  return <BrowserRouter><Routes>
    <Route path="/__e2e" element={<AdminShell utility={<AdminStatusBadge tone="plum">시각 표본 · E2E</AdminStatusBadge>}><FixtureLanding /></AdminShell>} />
    <Route path="/__e2e/visual/accessibility" element={<AccessibilityFixture />} />
    <Route path="/__e2e/visual/read-only-settings" element={<ReadOnlySettingsFixture />} />
    <Route path="/__e2e/visual/:state" element={<VisualStateShell />} />
    <Route path="*" element={<PrivateAdminRoutes api={fixture.api} />} />
  </Routes></BrowserRouter>;
}
