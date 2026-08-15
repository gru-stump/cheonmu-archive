import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DraftSummary, NarrativeApi } from '../../api/narrativeApi';
import { AdminNotice } from '../../components/AdminNotice';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { AdminStatusBadge } from '../../components/AdminStatusBadge';

const seoulDate = (value: string) => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));

export function DraftListPage({ api }: { api: NarrativeApi }) {
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState(false);
  const load = async () => {
    setError(false);
    try { setDrafts(await api.listDrafts({ status: 'active' })); }
    catch { setError(true); }
  };
  useEffect(() => { let active = true; void api.listDrafts({ status: 'active' }).then((rows) => { if (active) setDrafts(rows); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api]);
  return <section><AdminPageHeader eyebrow="검토 대기실" title="초안" description="생성된 기록을 상태와 연속성 수준에 따라 검토합니다." />{error ? <AdminNotice tone="danger" action={<button type="button" onClick={() => void load()}>다시 시도</button>}>초안 목록을 불러오지 못했습니다.</AdminNotice> : drafts === null ? <AdminNotice>초안을 불러오는 중입니다.</AdminNotice> : drafts.length === 0 ? <AdminNotice>검토할 초안이 없습니다.</AdminNotice> : <ul className="draft-list">{drafts.map((draft) => <li key={draft.id}><Link to={`/drafts/${draft.id}`}><strong className="draft-list__title">{draft.title}</strong><span className="draft-list__kind">{draft.kind}</span><AdminStatusBadge tone={draft.continuityLevel === 'block' ? 'danger' : 'green'}>{draft.continuityLevel === 'block' ? 'blocked' : draft.status}</AdminStatusBadge><span className="draft-list__continuity">연속성 {draft.continuityLevel ?? '미검사'}</span><time dateTime={draft.updatedAt}>{seoulDate(draft.updatedAt)}</time></Link></li>)}</ul>}</section>;
}
