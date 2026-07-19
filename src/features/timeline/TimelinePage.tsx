import type { JSX } from 'react';
import { useSearchParams } from 'react-router-dom';
import { loadAllContent } from '../../content/load';
import type { ArchiveRecord } from '../../content/schema';
import { RecordCard } from './RecordCard';
import { TimelineFilter, type TimelineStatus } from './TimelineFilter';

type TimelinePageProps = {
  records?: readonly ArchiveRecord[];
};

function readStatus(value: string | null): TimelineStatus {
  return value === 'confirmed' || value === 'draft' ? value : 'all';
}

export function TimelinePage({ records = loadAllContent().records }: TimelinePageProps): JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedStatus = readStatus(searchParams.get('status'));
  const visibleRecords = [...records]
    .sort((left, right) => left.stage - right.stage)
    .filter((record) => selectedStatus === 'all' || record.status === selectedStatus);

  function selectStatus(status: TimelineStatus): void {
    const nextParams = new URLSearchParams(searchParams);
    nextParams.set('status', status);
    setSearchParams(nextParams);
  }

  return (
    <section className="timeline-page" aria-labelledby="timeline-title">
      <header className="document-header timeline-header">
        <div>
          <p className="document-kicker">Chronological Case Records</p>
          <h1 id="timeline-title">관계 기록철</h1>
          <p>첫 조우에서 귀환의 약속까지, 두 사람 사이에 남은 기록.</p>
        </div>
        <p className="timeline-count" aria-label={`${visibleRecords.length}개 기록`}>
          <b>{visibleRecords.length.toString().padStart(2, '0')}</b>
          <span>RECORDS</span>
        </p>
      </header>

      <TimelineFilter selected={selectedStatus} onSelect={selectStatus} />

      {visibleRecords.length > 0 ? (
        <div className="record-list">
          {visibleRecords.map((record) => <RecordCard key={record.id} record={record} />)}
        </div>
      ) : (
        <p className="empty-records">해당 상태의 기록이 없습니다.</p>
      )}
    </section>
  );
}
