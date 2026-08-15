import { type FormEvent, useEffect, useState } from 'react';
import type { MemoryData, MemoryItem, NarrativeApi } from '../../api/narrativeApi';

function MemoryList({ api, items, readOnly, onChanged }: { api: NarrativeApi; items: MemoryItem[]; readOnly?: boolean; onChanged(): Promise<void> }) {
  const [correctingId, setCorrectingId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const toggle = async (item: MemoryItem) => {
    setMessage(null);
    try {
      await api.setMemoryEnabled({ memoryId: item.id, enabled: !item.enabled });
      await onChanged();
      setMessage('기억 사용 상태를 저장했습니다.');
    } catch { setMessage('기억 사용 상태를 저장하지 못했습니다.'); }
  };
  const correct = async (event: FormEvent, item: MemoryItem) => {
    event.preventDefault();
    setMessage(null);
    try {
      await api.correctMemory({ memoryId: item.id, content, note });
      setCorrectingId(null); setContent(''); setNote('');
      await onChanged();
      setMessage('교정 이력을 추가했습니다.');
    } catch { setMessage('교정 이력을 저장하지 못했습니다.'); }
  };

  return <>
    {items.length === 0 ? <p>등록된 항목이 없습니다.</p> : <ul className="settings-list">{items.map((item) => <li key={item.id}>
      <article className="settings-card">
        <p>{item.content}</p>
        <p><strong>{item.enabled ? '사용 중' : '사용 안 함'}</strong></p>
        {item.correctionHistory.length > 0 && <details><summary>교정 이력</summary><ol>{item.correctionHistory.map((history) => <li key={history.id}><p>{history.content}</p>{history.note && <small>{history.note}</small>}</li>)}</ol></details>}
        {!readOnly && <div className="inline-actions">
          <button type="button" aria-label={`${item.content} ${item.enabled ? '비활성화' : '활성화'}`} onClick={() => void toggle(item)}>{item.enabled ? '비활성화' : '활성화'}</button>
          <button type="button" aria-label={`${item.content} 교정 추가`} onClick={() => { setCorrectingId(item.id); setContent(''); setNote(''); }}>교정 추가</button>
        </div>}
        {correctingId === item.id && <form onSubmit={(event) => void correct(event, item)}>
          <label htmlFor={`correction-content-${item.id}`}>교정 내용</label>
          <textarea id={`correction-content-${item.id}`} value={content} onChange={(event) => setContent(event.target.value)} required />
          <label htmlFor={`correction-note-${item.id}`}>교정 사유</label>
          <textarea id={`correction-note-${item.id}`} value={note} onChange={(event) => setNote(event.target.value)} required />
          <button type="submit">교정 이력 저장</button>
          <button type="button" onClick={() => setCorrectingId(null)}>취소</button>
        </form>}
      </article>
    </li>)}</ul>}
    {message && <p role="status">{message}</p>}
  </>;
}

const sections: Array<{ key: keyof MemoryData; title: string; readOnly?: boolean }> = [
  { key: 'fixedCanon', title: '고정 정사', readOnly: true },
  { key: 'continuity', title: '연속성 장부' },
  { key: 'recent', title: '최근 기억' },
  { key: 'feedback', title: '금지·피드백 기억' },
  { key: 'unresolved', title: '미회수 요소' },
];

export function MemoryPage({ api }: { api: NarrativeApi }) {
  const [data, setData] = useState<MemoryData | null>(null);
  const [error, setError] = useState(false);
  const load = async () => { const value = await api.getMemory(); setData(value); setError(false); };
  useEffect(() => { let active = true; void api.getMemory().then((value) => { if (active) setData(value); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api]);
  return <section aria-labelledby="memory-title">
    <h1 id="memory-title">기억</h1>
    <p>고정 정사는 이 화면에서 바꿀 수 없습니다. 다른 기억은 사용 상태를 전환하거나 새 교정 이력을 추가합니다.</p>
    {error ? <p role="alert">기억을 불러오지 못했습니다.</p> : !data ? <p role="status">기억을 불러오는 중입니다.</p> : sections.map((section) => <section key={section.key} aria-labelledby={`memory-${section.key}`}>
      <h2 id={`memory-${section.key}`}>{section.title}</h2>
      <MemoryList api={api} items={data[section.key]} readOnly={section.readOnly} onChanged={load} />
    </section>)}
  </section>;
}
