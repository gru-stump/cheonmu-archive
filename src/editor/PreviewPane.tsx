import type { JSX } from 'react';
import { ArchiveContentDisplay, RecordContentDisplay } from '../components/ContentDisplay';
import type { ArchiveDocument, ArchiveProfile, ArchiveRecord, DocumentMeta, ProfileMeta, RecordMeta } from '../content/schema';
import type { EditorKind } from './api';

export type EditorAction = '생성' | '수정' | '변경 없음' | '삭제 예정';
type PreviewPaneProps = {
  className?: string;
  kind: EditorKind;
  data: RecordMeta | ProfileMeta | DocumentMeta;
  body: string;
  path: string;
  action: EditorAction;
};

export function PreviewPane({ className, kind, data, body, path, action }: PreviewPaneProps): JSX.Element {
  return <aside className={className} aria-label="미리보기">
    <p>변경 파일: <code>{path}</code></p>
    <p>작업: {action}</p>
    <article className={kind === 'records' ? 'record-detail' : 'archive-detail'}>
      {kind === 'records' && <RecordContentDisplay record={{ ...data as RecordMeta, body } as ArchiveRecord} headingLevel={2} editorDetails />}
      {kind === 'profiles' && <ArchiveContentDisplay kind="profile" content={{ ...data as ProfileMeta, body } as ArchiveProfile} headingLevel={2} editorDetails />}
      {kind === 'documents' && <ArchiveContentDisplay kind="document" content={{ ...data as DocumentMeta, body } as ArchiveDocument} headingLevel={2} editorDetails />}
    </article>
  </aside>;
}
