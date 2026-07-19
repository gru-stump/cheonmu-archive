import { useEffect, useMemo, useState, type JSX } from 'react';
import { parse as parseYaml, stringify } from 'yaml';
import { ZodError, type ZodType } from 'zod';
import { parseMarkdown } from '../content/frontmatter';
import { documentMetaSchema, profileMetaSchema, recordMetaSchema, type DocumentMeta, type ProfileMeta, type RecordMeta } from '../content/schema';
import { DocumentForm } from './DocumentForm';
import { editorApi, type EditorApi as EditorApiContract, type EditorEntry, type EditorKind } from './api';
import { PreviewPane } from './PreviewPane';
import { ProfileForm } from './ProfileForm';
import { RecordForm } from './RecordForm';

export type { EditorApi } from './api';
type DraftData = RecordMeta | ProfileMeta | DocumentMeta;

export interface EditorDraft {
  kind: EditorKind;
  id: string;
  source: string;
  dirty: boolean;
  validation: { valid: boolean; fields: Record<string, string> };
}

const schemas: Record<EditorKind, ZodType<DraftData>> = { records: recordMetaSchema, profiles: profileMetaSchema, documents: documentMetaSchema };
const kinds = ['records', 'profiles', 'documents'] as const;

function splitSource(kind: EditorKind, source: string): { data: DraftData; body: string } { return parseMarkdown(source, schemas[kind]); }
function sourceFrom(data: DraftData, body: string): string { return `---\n${stringify(data)}---\n${body.startsWith('\n') ? body : `\n${body}`}`; }
function previewSource(source: string): { data: DraftData; body: string } | null {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  return match ? { data: parseYaml(match[1]) as DraftData, body: source.slice(match[0].length) } : null;
}

function validationFor(kind: EditorKind, source: string, recordIds: readonly string[]): EditorDraft['validation'] {
  try {
    const { data } = splitSource(kind, source);
    if (kind === 'records') {
      const missing = (data as RecordMeta).related.find((id) => !recordIds.includes(id));
      if (missing) return { valid: false, fields: { related: `연결된 기록을 찾을 수 없습니다: ${missing}` } };
    }
    return { valid: true, fields: {} };
  } catch (error) {
    if (error instanceof ZodError) return { valid: false, fields: Object.fromEntries(error.issues.map((issue) => [issue.path.join('.') || 'source', issue.message])) };
    return { valid: false, fields: { source: error instanceof Error ? error.message : '유효하지 않은 Markdown입니다.' } };
  }
}

function titleFrom(kind: EditorKind, source: string): string { try { return splitSource(kind, source).data.title; } catch { return '유효하지 않은 초안'; } }

export function EditorApp({ api = editorApi }: { api?: EditorApiContract }): JSX.Element {
  const [kind, setKind] = useState<EditorKind>('records');
  const [entries, setEntries] = useState<Record<EditorKind, EditorEntry[]>>({ records: [], profiles: [], documents: [] });
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [savedSource, setSavedSource] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void Promise.all(kinds.map(async (entryKind) => [entryKind, await api.list(entryKind)] as const))
      .then((loaded) => setEntries(Object.fromEntries(loaded) as Record<EditorKind, EditorEntry[]>))
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.'));
  }, [api]);

  const recordIds = entries.records.map((entry) => entry.id);
  const visibleEntries = entries[kind].filter((entry) => `${entry.id} ${titleFrom(kind, entry.source)}`.toLowerCase().includes(query.toLowerCase()));
  const preview = useMemo(() => draft ? previewSource(draft.source) : null, [draft]);

  function select(entryKind: EditorKind, entry: EditorEntry) {
    setKind(entryKind);
    setDraft({ kind: entryKind, id: entry.id, source: entry.source, dirty: false, validation: validationFor(entryKind, entry.source, recordIds) });
    setSavedSource(entry.source);
    setDeleting(false);
    setMessage('');
  }

  function update(dataUpdate: Partial<DraftData>, body?: string) {
    if (!draft) return;
    try {
      const current = previewSource(draft.source);
      if (!current) throw new Error('Markdown frontmatter를 읽을 수 없습니다.');
      const source = sourceFrom({ ...current.data, ...dataUpdate } as DraftData, body ?? current.body);
      setDraft({ ...draft, source, dirty: source !== savedSource, validation: validationFor(draft.kind, source, recordIds) });
      setDeleting(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : '초안을 갱신하지 못했습니다.'); }
  }

  async function save() {
    if (!draft || !draft.validation.valid) return;
    try {
      if (deleting && api.remove) {
        await api.remove(draft.kind, draft.id);
        setMessage('삭제 예정 항목을 휴지통으로 옮겼습니다.');
        setDraft(null);
        return;
      }
      const result = await api.save({ kind: draft.kind, id: draft.id, source: draft.source });
      setSavedSource(result.source);
      setDraft({ ...draft, source: result.source, dirty: false, validation: validationFor(draft.kind, result.source, recordIds) });
      setMessage('저장했습니다.');
    } catch (error) { setMessage(error instanceof Error ? error.message : '저장하지 못했습니다.'); }
  }

  return <main>
    <header><h1>천무 로컬 편집기</h1><p>저장 전 미리보기와 스키마 검증을 확인하세요.</p></header>
    <nav aria-label="콘텐츠 종류">{kinds.map((entryKind) => <button key={entryKind} type="button" aria-pressed={kind === entryKind} onClick={() => { setKind(entryKind); setQuery(''); }}>{entryKind === 'records' ? '기록' : entryKind === 'profiles' ? '프로필' : '문서'}</button>)}</nav>
    <section aria-label="콘텐츠 목록"><label>검색<input value={query} onChange={(event) => setQuery(event.target.value)} /></label><ul>{visibleEntries.map((entry) => <li key={entry.id}><button type="button" onClick={() => select(kind, entry)}>{titleFrom(kind, entry.source)} 편집</button></li>)}</ul></section>
    {draft && preview && <section aria-label="편집 초안">
      {draft.dirty && <p role="status">저장하지 않은 변경 사항이 있습니다.</p>}
      {draft.kind === 'records' && <RecordForm value={preview.data as RecordMeta} body={preview.body} errors={draft.validation.fields} recordIds={recordIds} onChange={update} onBodyChange={(body) => update({}, body)} />}
      {draft.kind === 'profiles' && <ProfileForm value={preview.data as ProfileMeta} body={preview.body} errors={draft.validation.fields} onChange={update} onBodyChange={(body) => update({}, body)} />}
      {draft.kind === 'documents' && <DocumentForm value={preview.data as DocumentMeta} body={preview.body} errors={draft.validation.fields} onChange={update} onBodyChange={(body) => update({}, body)} />}
      <button type="button" onClick={() => setDeleting(!deleting)}>{deleting ? '삭제 취소' : '삭제 예정으로 표시'}</button>
      <button type="button" disabled={!draft.validation.valid} onClick={() => void save()}>{deleting ? '삭제 확인' : '저장'}</button>
      <PreviewPane kind={draft.kind} data={preview.data} body={preview.body} path={`src/content/${draft.kind}/${draft.id}.md`} action={deleting ? '삭제 예정' : savedSource ? '수정' : '생성'} />
    </section>}
    {message && <p role="status">{message}</p>}
  </main>;
}
