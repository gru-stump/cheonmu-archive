import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { StatusStamp } from '../../components/StatusStamp';
import type { ArchiveRecord } from '../../content/schema';

type RecordCardProps = {
  record: ArchiveRecord;
};

export function RecordCard({ record }: RecordCardProps): JSX.Element {
  return (
    <article className="record-card" data-testid="record-card">
      <div className="record-card__index" aria-hidden="true">
        {record.stage.toString().padStart(2, '0')}
      </div>
      <div className="record-card__body">
        <div className="record-card__meta">
          <span>{record.recordNumber}</span>
          <StatusStamp status={record.status} />
        </div>
        <h2>
          <Link to={`/records/${record.id}`}>{record.title}</Link>
        </h2>
        <blockquote>“{record.quote}”</blockquote>
        <ul className="record-tags" aria-label="기록 태그">
          {record.tags.map((tag) => <li key={tag}>#{tag}</li>)}
        </ul>
      </div>
    </article>
  );
}
