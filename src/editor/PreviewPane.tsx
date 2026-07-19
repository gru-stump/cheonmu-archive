import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import { StatusStamp } from '../components/StatusStamp';
import type { DocumentMeta, ProfileMeta, RecordMeta } from '../content/schema';
import type { EditorKind } from './api';

export type EditorAction = '생성' | '수정' | '변경 없음' | '삭제 예정';
type PreviewPaneProps = { kind: EditorKind; data: RecordMeta | ProfileMeta | DocumentMeta; body: string; path: string; action: EditorAction };

function CreditLine({ credit }: { credit?: { creator: string; source?: string } }): JSX.Element | null {
  if (!credit) return null;
  return <p>출처: <span>{credit.creator}</span>{credit.source && <> · <a href={credit.source}>{credit.source}</a></>}</p>;
}

export function PreviewPane({ kind, data, body, path, action }: PreviewPaneProps): JSX.Element {
  const record = kind === 'records' ? data as RecordMeta : undefined;
  const profile = kind === 'profiles' ? data as ProfileMeta : undefined;
  const document = kind === 'documents' ? data as DocumentMeta : undefined;

  return <aside aria-label="미리보기">
    <p>변경 파일: <code>{path}</code></p>
    <p>작업: {action}</p>
    <article className={record ? 'record-detail' : 'archive-detail'}>
      <header className={record ? 'record-detail__header' : 'archive-detail__header'}>
        {record && <p>{record.recordNumber} · Stage {record.stage.toString().padStart(2, '0')}</p>}
        <h2>{data.title}</h2>
        {record && <StatusStamp status={record.status} />}
        {profile?.height && <p>신장 {profile.height}</p>}
      </header>
      {record && <>
        <blockquote>{record.quote}</blockquote>
        <p>등장인물: <span>{record.characters.join(', ')}</span></p>
        <p>태그: <span>{record.tags.map((tag) => `#${tag}`).join(' ')}</span></p>
        <p>관련 기록: <span>{record.related.join(', ') || '없음'}</span></p>
        <p>장면 재구성: {record.cinematic ? '사용' : '사용 안 함'}</p>
        <CreditLine credit={record.credit} />
      </>}
      <CreditLine credit={profile?.credit ?? document?.credit} />
      <div className="markdown-document"><ReactMarkdown>{body}</ReactMarkdown></div>
    </article>
  </aside>;
}
