import { useState } from 'react';
import { BrowserRouter, Link, Route, Routes, useParams } from 'react-router-dom';
import { AdminShell, PrivateAdminRoutes } from '../app/AdminApp';
import { AdminNotice } from '../components/AdminNotice';
import { AdminPageHeader } from '../components/AdminPageHeader';
import { AdminSection } from '../components/AdminSection';
import { AdminStatusBadge } from '../components/AdminStatusBadge';
import { createE2EFixture } from './e2eFixtureApi';

const fixture = createE2EFixture();

function OwnerJourney() {
  const [generation, setGeneration] = useState<'ready' | 'reserved' | 'reconciled'>('ready');
  const [rejectReady, setRejectReady] = useState(fixture.store.drafts.has('e2e-reject-draft'));
  const [majorPhase, setMajorPhase] = useState(0);
  const phaseMessage = majorPhase === 4 ? '중대 사건 본문이 비공개 초안으로 생성되었습니다.' : null;
  return <>
    <AdminPageHeader eyebrow="결정 기록" title="소유자 여정" description="외부 호출 없이 승인 경계와 단계 순서를 검증하는 로컬 전용 작업대입니다." />
    <AdminNotice><strong>소유자 세션 · E2E</strong> · 결정적 로컬 fixture</AdminNotice>
    <AdminSection title="접속 시 짧은 대화" description="마지막 성공 뒤 최소 간격과 예산을 확인합니다.">
      <p><AdminStatusBadge tone="green">최소 생성 간격 경과</AdminStatusBadge></p>
      {generation === 'ready' && <button type="button" onClick={() => setGeneration('reserved')}>접속 생성 시작</button>}
      {generation === 'reserved' && <><AdminNotice>예산 4,200 μUSD 예약</AdminNotice><button type="button" onClick={() => setGeneration('reconciled')}>생성 완료 및 정산</button></>}
      {generation === 'reconciled' && <><AdminNotice tone="success">실제 2,700 μUSD 정산 · 예약 1,500 μUSD 해제</AdminNotice><Link to="/drafts/e2e-access-draft">생성된 짧은 대화 검토</Link></>}
    </AdminSection>
    <AdminSection title="검토 결과" description="비공개 승인에는 게시 작업이 뒤따르지 않습니다.">
      <p>비공개 승인 {fixture.store.privateApprovals}건</p><p>게시 작업 {fixture.store.publishJobs}건</p>
      {!rejectReady ? <button type="button" onClick={() => { fixture.createRejectDraft(); setRejectReady(true); }}>다른 초안 생성</button> : <Link to="/drafts/e2e-reject-draft">거절할 초안 검토</Link>}
    </AdminSection>
    <AdminSection title="중대 사건 단계" description="앞 단계를 승인해야 다음 단계가 열립니다.">
      <ol className="phase-list"><li><button type="button" disabled={majorPhase !== 0} onClick={() => setMajorPhase(1)}>사건 제안 승인</button></li><li><button type="button" disabled={majorPhase !== 1} onClick={() => setMajorPhase(2)}>장면 계획 생성</button></li><li><button type="button" disabled={majorPhase !== 2} onClick={() => setMajorPhase(3)}>장면 계획 승인</button></li><li><button type="button" disabled={majorPhase !== 3} onClick={() => setMajorPhase(4)}>본문 생성</button></li></ol>
      {phaseMessage && <AdminNotice tone="success">{phaseMessage}</AdminNotice>}
    </AdminSection>
  </>;
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

export function E2EFixtureApp() {
  return <BrowserRouter><Routes>
    <Route path="/__e2e" element={<AdminShell utility={<AdminStatusBadge tone="plum">소유자 세션 · E2E</AdminStatusBadge>}><OwnerJourney /></AdminShell>} />
    <Route path="/__e2e/visual/:state" element={<VisualStateShell />} />
    <Route path="*" element={<PrivateAdminRoutes api={fixture.api} />} />
  </Routes></BrowserRouter>;
}
