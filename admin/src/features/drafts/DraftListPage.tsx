import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DraftSummary, NarrativeApi } from '../../api/narrativeApi';

const seoulDate = (value: string) => new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Seoul' }).format(new Date(value));

export function DraftListPage({ api }: { api: NarrativeApi }) {
  const [drafts, setDrafts] = useState<DraftSummary[] | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => { let active = true; void api.listDrafts({ status: 'active' }).then((rows) => { if (active) setDrafts(rows); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api]);
  return <section aria-labelledby="draft-list-title"><h1 id="draft-list-title">초안</h1>{error ? <p role="alert">초안 목록을 불러오지 못했습니다.</p> : drafts === null ? <p role="status">초안을 불러오는 중입니다.</p> : drafts.length === 0 ? <p>검토할 초안이 없습니다.</p> : <ul className="draft-list">{drafts.map((draft) => <li key={draft.id}><Link to={`/drafts/${draft.id}`}><strong>{draft.title}</strong><span>{draft.kind} · {draft.status}</span><time dateTime={draft.updatedAt}>{seoulDate(draft.updatedAt)}</time></Link></li>)}</ul>}</section>;
}
