import { useEffect, useState, type JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import { RecordContentDisplay } from '../../components/ContentDisplay';
import { loadAllContent } from '../../content/load';
import type { ArchiveRecord } from '../../content/schema';
import { CinematicScene, type CinematicSceneItem } from './CinematicScene';

type RecordDetailPageProps = {
  records?: readonly ArchiveRecord[];
};

const cinematicStages = new Set([1, 3, 5, 7]);

function scenesFromRecord(record: ArchiveRecord): CinematicSceneItem[] {
  return record.body
    .split(/\n+/)
    .map((line) => line
      .trim()
      .replace(/^>\s?/, '')
      .replace(/^\*\*(.+)\*\*$/, '$1')
      .trim())
    .filter(Boolean)
    .map((line, index) => ({
      id: `${record.id}-scene-${index + 1}`,
      text: line,
    }));
}

export function RecordDetailPage({ records = loadAllContent().records }: RecordDetailPageProps): JSX.Element {
  const { recordId } = useParams();
  const [isCinematicOpen, setIsCinematicOpen] = useState(false);
  const record = records.find((item) => item.id === recordId);

  useEffect(() => {
    setIsCinematicOpen(false);
  }, [recordId]);

  if (!record) {
    return (
      <section className="record-not-found" aria-labelledby="missing-record-title">
        <p className="document-kicker">Archive Error · 404</p>
        <h1 id="missing-record-title">기록을 찾을 수 없습니다</h1>
        <p>요청한 문서 번호가 기록철에 존재하지 않습니다.</p>
        <Link className="primary-document-link" to="/records">기록철로 돌아가기</Link>
      </section>
    );
  }

  const relatedRecords = record.related
    .map((id) => records.find((item) => item.id === id))
    .filter((item): item is ArchiveRecord => Boolean(item));
  const hasCinematicScene = record.cinematic
    && record.status === 'confirmed'
    && cinematicStages.has(record.stage);
  const scenes = hasCinematicScene ? scenesFromRecord(record) : [];

  return (
    <article className="record-detail">
      <Link className="back-link" to="/records">← 기록철</Link>
      <RecordContentDisplay
        record={record}
        cinematicEntry={hasCinematicScene ? <div className="cinematic-entry">
          <p>이 기록의 확정된 문장을 장면 순서대로 열람합니다.</p>
          <button type="button" onClick={() => setIsCinematicOpen(true)}>장면 재구성 열기</button>
        </div> : undefined}
      />

      {relatedRecords.length > 0 && (
        <nav className="related-records" aria-label="연결 기록">
          <p>연결 기록</p>
          <ul>
            {relatedRecords.map((related) => (
              <li key={related.id}><Link to={`/records/${related.id}`}>{related.title}</Link></li>
            ))}
          </ul>
        </nav>
      )}

      {isCinematicOpen && hasCinematicScene && (
        <CinematicScene
          title={record.title}
          scenes={scenes}
          onClose={() => setIsCinematicOpen(false)}
        />
      )}
    </article>
  );
}
