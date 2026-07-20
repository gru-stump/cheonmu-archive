import { useEffect, useRef, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { loadAllContent } from '../../content/load';
import {
  WORLD_PUBLIC_STAGE,
  visibleWorldSections,
  type ArchiveRecord,
  type WorldCategory,
  type WorldDocument,
} from '../../content/schema';

type WorldPageProps = {
  documents?: readonly WorldDocument[];
  records?: readonly ArchiveRecord[];
};

const CATEGORY_LABELS = {
  organization: '기관과 조직',
  'field-response': '현장 대응',
  medical: '의료와 치료',
  anomaly: '미확인 개체·오염',
  observation: '관측 기록',
  classified: '기밀 문서',
} as const;

const STATUS_LABELS: Record<WorldDocument['status'], string> = {
  public: '공개',
  partial: '부분 공개',
  locked: '잠김',
};

export function WorldPage({
  documents = loadAllContent().world,
  records = loadAllContent().records,
}: WorldPageProps): JSX.Element {
  const { documentId } = useParams();
  const [indexOpen, setIndexOpen] = useState(false);
  const documentHeadingRef = useRef<HTMLHeadingElement>(null);
  const pendingKeyboardFocusIdRef = useRef<string | null>(null);
  const selected = documents.find((item) => item.id === documentId) ?? documents[0];
  const invalidId = Boolean(documentId && selected?.id !== documentId);

  useEffect(() => {
    if (!indexOpen && pendingKeyboardFocusIdRef.current === selected?.id) {
      documentHeadingRef.current?.focus();
      pendingKeyboardFocusIdRef.current = null;
    }
  }, [indexOpen, selected?.id]);

  if (!selected) {
    return <section className="record-not-found"><h1>세계관 문서가 없습니다</h1></section>;
  }

  return (
    <section className="world-page" aria-labelledby="world-title">
      <header className="document-header">
        <div>
          <p className="document-kicker">World File · CM-06</p>
          <h1 id="world-title">세계관 기록실</h1>
          <p>공개된 기록을 기준으로 기관과 현상을 열람합니다.</p>
        </div>
      </header>
      {invalidId && (
        <p className="world-route-notice">
          요청한 문서가 없어 첫 문서를 표시합니다.{' '}
          <Link to={`/world/${selected.id}`}>정식 문서 주소</Link>
        </p>
      )}
      <button
        className="world-index-toggle"
        type="button"
        aria-expanded={indexOpen}
        aria-controls="world-index"
        onClick={() => setIndexOpen((value) => !value)}
      >
        분류 색인
      </button>
      <div className="world-layout">
        <nav id="world-index" className="world-index" data-open={indexOpen} aria-label="세계관 문서 색인">
          {Object.entries(CATEGORY_LABELS).map(([category, label]) => {
            const items = documents.filter((item) => item.categories.includes(category as WorldCategory));
            return items.length > 0 && (
              <section key={category}>
                <h2>{label}</h2>
                {items.map((item) => (
                  <Link
                    key={item.id}
                    to={`/world/${item.id}`}
                    aria-current={item.id === selected.id ? 'page' : undefined}
                    onKeyDown={(event) => {
                      if (indexOpen && event.key === 'Enter') {
                        pendingKeyboardFocusIdRef.current = item.id;
                      }
                    }}
                    onClick={() => setIndexOpen(false)}
                  >
                    <span>{item.documentNumber}</span>{item.title}
                  </Link>
                ))}
              </section>
            );
          })}
        </nav>
        <article className="world-document">
          <header>
            <p>
              {selected.documentNumber} · {selected.clearance} · 상태 {STATUS_LABELS[selected.status]}
              {' · '}CM-{String(WORLD_PUBLIC_STAGE).padStart(2, '0')} 기준
            </p>
            <h2 ref={documentHeadingRef} tabIndex={-1}>{selected.title}</h2>
            <strong>{selected.summary}</strong>
          </header>
          <p className="world-explanation">쉽게 말하면 — {selected.explanation}</p>
          {visibleWorldSections(selected).map((section) => section.paragraphs.map((paragraph) => (
            <p key={`${section.revealStage}-${paragraph}`}>{paragraph}</p>
          )))}
          {selected.status === 'locked' && (
            <aside className="world-lock" aria-label="잠긴 기밀 정보">
              <span aria-hidden="true">▣</span> {selected.lockLabel}
            </aside>
          )}
          <footer className="world-related">
            <h3>관련 기록</h3>
            {selected.relatedRecords.map((id) => {
              const record = records.find((item) => item.id === id);
              return record && <Link key={id} to={`/records/${id}`}>{record.recordNumber}</Link>;
            })}
          </footer>
        </article>
      </div>
    </section>
  );
}
