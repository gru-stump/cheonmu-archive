import type { JSX } from 'react';
import ReactMarkdown from 'react-markdown';
import { StatusStamp } from '../components/StatusStamp';
import type { DocumentMeta, ProfileMeta, RecordMeta } from '../content/schema';
import type { EditorKind } from './api';
type PreviewPaneProps = { kind: EditorKind; data: RecordMeta | ProfileMeta | DocumentMeta; body: string; path: string; action: '생성' | '수정' | '삭제 예정' };
export function PreviewPane({ kind, data, body, path, action }: PreviewPaneProps): JSX.Element {
  const record = kind === 'records' ? data as RecordMeta : undefined;
  const profile = kind === 'profiles' ? data as ProfileMeta : undefined;
  return <aside aria-label="미리보기"><p>변경 파일: <code>{path}</code></p><p>작업: {action}</p><article>{record && <StatusStamp status={record.status} />}<h2>{data.title}</h2>{profile?.height && <p>신장 {profile.height}</p>}<div className="markdown-document"><ReactMarkdown>{body}</ReactMarkdown></div></article></aside>;
}
