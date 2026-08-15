import { type FormEvent, useEffect, useState } from 'react';
import type { MemoryData, MemoryItem, NarrativeApi } from '../../api/narrativeApi';
import { AdminNotice } from '../../components/AdminNotice';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { AdminSection } from '../../components/AdminSection';
import { AdminStatusBadge } from '../../components/AdminStatusBadge';

function MemoryList({ api, items, readOnly, onChanged }: { api: NarrativeApi; items: MemoryItem[]; readOnly?: boolean; onChanged(): Promise<void> }) {
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const toggle = async (item: MemoryItem) => {
    setMessage(null);
    try {
      await api.setMemoryEnabled({ memoryId: item.id, enabled: !item.enabled });
    } catch { setMessage('기억 사용 상태를 저장하지 못했습니다.'); return; }
    try { await onChanged(); setMessage('기억 사용 상태를 저장했습니다.'); }
    catch { setMessage('저장했지만 최신 기억을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
  };
  const correct = async (event: FormEvent, item: MemoryItem) => {
    event.preventDefault();
    setMessage(null);
    try {
      await api.correctMemory({ memoryId: item.id, content, note });
      setCorrectingId(null); setContent(''); setNote('');
    } catch { setMessage('교정 이력을 저장하지 못했습니다.'); return; }
    try { await onChanged(); setMessage('교정 이력을 추가했습니다.'); }
    catch { setMessage('교정은 저장했지만 최신 기억을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
  };

  return <>
    {items.length === 0 ? <p className="empty-copy">등록된 항목이 없습니다.</p> : <ul className="memory-list">{items.map((item) => <li key={item.id}>
      <article className="memory-row">
        <p>{item.content}</p>
        <p className="memory-row__meta"><AdminStatusBadge tone={item.enabled ? 'green' : 'neutral'}>{item.enabled ? '사용 중' : '사용 안 함'}</AdminStatusBadge><span>교정 {item.correctionHistory.length}건</span></p>
        {item.correctionHistory.length > 0 && <details><summary>교정 이력</summary><ol>{item.correctionHistory.map((history) => <li key={history.id}><p>{history.content}</p>{history.note && <small>{history.note}</small>}</li>)}</ol></details>}
        {!readOnly && <div className="inline-actions">
          <button type="button" aria-label={`${item.content} ${item.enabled ? '비활성화' : '활성화'}`} onClick={() => void toggle(item)}>{item.enabled ? '비활성화' : '활성화'}</button>
          <button type="button" aria-label={`${item.content} 교정 추가`} onClick={() => { setCorrectingId(item.id); setContent(''); setNote(''); }}>교정 추가</button>
        </div>}
        {correctingId === item.id && <form className="memory-correction" onSubmit={(event) => void correct(event, item)}>
          <label htmlFor={`correction-content-${item.id}`}>교정 내용</label>
          <textarea id={`correction-content-${item.id}`} value={content} onChange={(event) => setContent(event.target.value)} required />
          <label htmlFor={`correction-note-${item.id}`}>교정 사유</label>
          <textarea id={`correction-note-${item.id}`} value={note} onChange={(event) => setNote(event.target.value)} required />
          <button type="submit">교정 이력 저장</button>
          <button type="button" onClick={() => setCorrectingId(null)}>취소</button>
        </form>}
      </article>
    </li>)}</ul>}
    {message && <AdminNotice tone={message.startsWith('저장했지만') || message.startsWith('교정은 저장했지만') ? 'warning' : message.includes('못했습니다') ? 'danger' : 'success'}>{message}</AdminNotice>}
  </>;
}

const sections: Array<{ key: keyof MemoryData; title: string; readOnly?: boolean }> = [
  { key: 'fixedCanon', title: '고정 정사', readOnly: true },
  { key: 'continuity', title: '연속성 장부' },
  { key: 'recent', title: '최근 기억' },
  { key: 'feedback', title: '금지·피드백 기억' },
  { key: 'unresolved', title: '미회수 요소' },
];

export function MemoryPage({ api, readOnly = false }: { api: NarrativeApi; readOnly?: boolean }) {
  const [data, setData] = useState<MemoryData | null>(null);
  const [error, setError] = useState(false);
  const load = async () => { const value = await api.getMemory(); setData(value); setError(false); };
  useEffect(() => { let active = true; void api.getMemory().then((value) => { if (active) setData(value); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api]);
  return <section>
    <AdminPageHeader eyebrow="연속성 장부" title="기억" description="확정 정사와 최근 서사, 피드백, 미회수 요소를 구분해 관리합니다." />
    <AdminNotice tone="info" live={false}>고정 정사는 이 화면에서 바꿀 수 없습니다. 다른 기억은 사용 상태를 전환하거나 새 교정 이력을 추가합니다.</AdminNotice>
    {error ? <AdminNotice tone="danger">기억을 불러오지 못했습니다.</AdminNotice> : !data ? <AdminNotice>기억을 불러오는 중입니다.</AdminNotice> : sections.map((section) => <AdminSection key={section.key} title={section.title} description={`${data[section.key].length}개 항목`}>
      <MemoryList api={api} items={data[section.key]} readOnly={readOnly || section.readOnly} onChanged={load} />
    </AdminSection>)}
  </section>;
}
