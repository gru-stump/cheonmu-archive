import type { JSX, ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import type { ArchiveDocument, ArchiveProfile, ArchiveRecord } from '../content/schema';
import { resolvePublicAssetUrl } from '../lib/publicAssetUrl';
import { StatusStamp } from './StatusStamp';

type HeadingLevel = 1 | 2;

function Heading({ level, children }: { level: HeadingLevel; children: ReactNode }): JSX.Element {
  return level === 1 ? <h1>{children}</h1> : <h2>{children}</h2>;
}

function CreditLine({ credit }: { credit?: { creator: string; source?: string } }): JSX.Element | null {
  if (!credit) return null;
  return <p>출처: <span>{credit.creator}</span>{credit.source && <> · <a href={credit.source}>{credit.source}</a></>}</p>;
}

type RecordContentDisplayProps = {
  record: ArchiveRecord;
  headingLevel?: HeadingLevel;
  cinematicEntry?: ReactNode;
  editorDetails?: boolean;
};

export function RecordContentDisplay({ record, headingLevel = 1, cinematicEntry, editorDetails = false }: RecordContentDisplayProps): JSX.Element {
  return <>
    <header className="record-detail__header" data-testid="record-content-display">
      <div>
        <p className="document-kicker">{record.recordNumber} · Stage {record.stage.toString().padStart(2, '0')}</p>
        <Heading level={headingLevel}>{record.title}</Heading>
      </div>
      <StatusStamp status={record.status} />
    </header>
    <blockquote className="record-detail__quote">{editorDetails ? record.quote : `“${record.quote}”`}</blockquote>
    {cinematicEntry}
    {editorDetails && <div className="record-detail__editor-meta">
      <p>등장인물: <span>{record.characters.join(', ')}</span></p>
      <p>태그: <span>{record.tags.map((tag) => `#${tag}`).join(' ')}</span></p>
      <p>관련 기록: <span>{record.related.join(', ') || '없음'}</span></p>
      <p>장면 재구성: {record.cinematic ? '사용' : '사용 안 함'}</p>
      <CreditLine credit={record.credit} />
    </div>}
    <div className="record-detail__layout">
      <div className="markdown-document"><ReactMarkdown>{record.body}</ReactMarkdown></div>
      {!editorDetails && <aside className="record-detail__aside" aria-label="기록 정보">
        <div className="detail-portraits" aria-hidden="true">
          <img src={resolvePublicAssetUrl('/images/Cheonryeong_head.png')} alt="" />
          <img src={resolvePublicAssetUrl('/images/Muyeong_head.png')} alt="" />
        </div>
        <dl>
          <dt>분류</dt><dd>{record.cinematic ? '주요 장면' : '관계 기록'}</dd>
          <dt>등장</dt><dd>천령 · 무영</dd>
          <dt>태그</dt><dd>{record.tags.map((tag) => `#${tag}`).join(' ')}</dd>
        </dl>
      </aside>}
    </div>
  </>;
}

type ArchiveContentDisplayProps = {
  kind: 'profile' | 'document';
  content: ArchiveProfile | ArchiveDocument;
  headingLevel?: HeadingLevel;
  editorDetails?: boolean;
};

export function ArchiveContentDisplay({ kind, content, headingLevel = 1, editorDetails = false }: ArchiveContentDisplayProps): JSX.Element {
  const profile = kind === 'profile' ? content as ArchiveProfile : undefined;
  return <>
    <header className="archive-detail__header" data-testid={`${kind}-content-display`}>
      <p className="document-kicker">{kind === 'profile' ? 'Character Profile' : 'Reference Document'}</p>
      <Heading level={headingLevel}>{content.title}</Heading>
      {profile?.height && <p>신장 {profile.height}</p>}
    </header>
    {editorDetails && <CreditLine credit={content.credit} />}
    <div className="markdown-document"><ReactMarkdown>{content.body}</ReactMarkdown></div>
  </>;
}
