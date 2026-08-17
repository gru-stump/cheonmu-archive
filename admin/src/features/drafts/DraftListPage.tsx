import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type { DraftSummary, NarrativeApi } from '../../api/narrativeApi';
import { AdminNotice } from '../../components/AdminNotice';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { AdminStatusBadge } from '../../components/AdminStatusBadge';
import { draftStatusLabels, draftStatusTone, formatSeoulTimestamp } from '../../lib/narrativeDisplay';

const kindLabels: Record<string, string> = {
  short_dialogue: '짧은 대화', daily_event: '일상 사건', major_event_proposal: '큰 사건 제안',
};
const continuityLabels: Record<string, string> = {
  pass: '문제 없음', review: '확인 필요', block: '승인 불가',
};
const needsReviewStatuses = new Set(['generated', 'reviewing']);

function DraftRows({ drafts }: { drafts: DraftSummary[] }) {
  return <ul className="draft-list">{drafts.map((draft) => <li key={draft.id}><Link to={`/drafts/${draft.id}`}><strong className="draft-list__title">{draft.title}</strong><span className="draft-list__kind">{kindLabels[draft.kind] ?? '이야기'}</span><AdminStatusBadge tone={draft.continuityLevel === 'block' ? 'danger' : draftStatusTone(draft.status)}>{draftStatusLabels[draft.status] ?? '상태 확인 필요'}</AdminStatusBadge><span className="draft-list__continuity">{draft.status === 'rejected' ? '거절 사유 반영됨' : `이어짐 ${draft.continuityLevel ? continuityLabels[draft.continuityLevel] ?? '확인 필요' : '아직 검사하지 않음'}`}</span><time dateTime={draft.updatedAt}>{draft.status === 'rejected' ? '거절 ' : ''}{formatSeoulTimestamp(draft.updatedAt).exact}</time></Link></li>)}</ul>;
}

export function DraftListPage({ api }: { api: NarrativeApi }) {
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get('view');
  const [view, setView] = useState<'active' | 'rejected' | 'archived'>(requestedView === 'rejected' || requestedView === 'archived' ? requestedView : 'active');
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState(false);
  const load = async () => {
    setError(false);
    try { setDrafts(await api.listDrafts({ status: view })); }
    catch { setError(true); }
  };
  useEffect(() => { let active = true; setDrafts(null); setError(false); void api.listDrafts({ status: view }).then((rows) => { if (active) setDrafts(rows); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api, view]);
  const switchView = (nextView: 'active' | 'rejected' | 'archived') => {
    setView(nextView);
    setSearchParams(nextView === 'active' ? {} : { view: nextView }, { replace: true });
  };
  const filters = <div className="draft-list__filters" role="group" aria-label="초안 범위"><button type="button" aria-pressed={view === 'active'} onClick={() => switchView('active')}>진행 중</button><button type="button" aria-pressed={view === 'rejected'} onClick={() => switchView('rejected')}>거절됨</button><button type="button" aria-pressed={view === 'archived'} onClick={() => switchView('archived')}>보관됨</button></div>;
  const reviewMessage = (location.state as { reviewMessage?: unknown } | null)?.reviewMessage;
  const needsReview = drafts?.filter((draft) => needsReviewStatuses.has(draft.status)) ?? [];
  const others = drafts?.filter((draft) => !needsReviewStatuses.has(draft.status)) ?? [];
  const emptyNotice = view === 'archived'
    ? <AdminNotice>보관된 초안이 없습니다.</AdminNotice>
    : view === 'rejected'
      ? <AdminNotice>거절된 초안이 없습니다.</AdminNotice>
      : <AdminNotice>진행 중인 초안이 없습니다. <Link to="/">오늘 화면에서 이야기를 만들거나</Link> <Link to="/schedules">일정을 확인해 보세요</Link>.</AdminNotice>;
  return <section><AdminPageHeader eyebrow="검토 대기실" title="초안" description="만들어진 이야기를 읽고 승인하거나 수정합니다." action={filters} />{typeof reviewMessage === 'string' && <AdminNotice tone="success">{reviewMessage}</AdminNotice>}{error ? <AdminNotice tone="danger" action={<button type="button" onClick={() => void load()}>다시 시도</button>}>초안 목록을 불러오지 못했습니다.</AdminNotice> : drafts === null ? <AdminNotice>초안을 불러오는 중입니다.</AdminNotice> : drafts.length === 0 ? emptyNotice : view !== 'active' ? <DraftRows drafts={drafts} /> : <>
    {needsReview.length > 0 && <section aria-labelledby="drafts-needs-review"><h2 id="drafts-needs-review" className="draft-list__group-title">검토가 필요한 초안 · {needsReview.length}편</h2><DraftRows drafts={needsReview} /></section>}
    {needsReview.length === 0 && <AdminNotice>지금 검토할 초안은 없습니다. <Link to="/">오늘 화면에서 새 이야기를 만들 수 있습니다.</Link></AdminNotice>}
    {others.length > 0 && <section aria-labelledby="drafts-others"><h2 id="drafts-others" className="draft-list__group-title">만드는 중이거나 승인·게시된 초안 · {others.length}편</h2><DraftRows drafts={others} /></section>}
  </>}</section>;
}
