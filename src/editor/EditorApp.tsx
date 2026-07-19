import { useEffect, useMemo, useState, type JSX } from 'react';
import { parse as parseYaml, stringify } from 'yaml';
import { ZodError, type ZodType } from 'zod';
import { parseMarkdown } from '../content/frontmatter';
import { documentMetaSchema, profileMetaSchema, recordMetaSchema, type DocumentMeta, type ProfileMeta, type RecordMeta } from '../content/schema';
import { DocumentForm } from './DocumentForm';
import { editorApi, type EditorApi as EditorApiContract, type EditorEntry, type EditorKind } from './api';
import { PreviewPane, type EditorAction } from './PreviewPane';
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
const labels: Record<EditorKind, { tab: string; create: string }> = {
  records: { tab: '기록', create: '새 기록' },
  profiles: { tab: '프로필', create: '새 프로필' },
  documents: { tab: '문서', create: '새 문서' },
};

function splitSource(kind: EditorKind, source: string): { data: DraftData; body: string } { return parseMarkdown(source, schemas[kind]); }
function sourceFrom(data: DraftData, body: string): string { return `---\n${stringify(data)}---\n${body.startsWith('\n') ? body : `\n${body}`}`; }
function previewSource(source: string): { data: DraftData; body: string } | null {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/);
  return match ? { data: parseYaml(match[1]) as DraftData, body: source.slice(match[0].length) } : null;
}

function validationFor(kind: EditorKind, source: string, recordIds: readonly string[], existingIds: readonly string[], isNew: boolean): EditorDraft['validation'] {
  try {
    const { data } = splitSource(kind, source);
    if (isNew && existingIds.includes(data.id)) return { valid: false, fields: { id: '이미 사용 중인 식별자입니다.' } };
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

function blankData(kind: EditorKind): DraftData {
  if (kind === 'records') return { id: '', recordNumber: '', title: '', stage: 1, status: 'draft', characters: [], tags: [], related: [], quote: '', cinematic: false };
  return { id: '', title: '' };
}

function fieldErrors(error: unknown): Record<string, string> | undefined {
  if (typeof error !== 'object' || error === null || !('fields' in error)) return undefined;
  const fields = error.fields;
  return typeof fields === 'object' && fields !== null ? fields as Record<string, string> : undefined;
}

export function EditorApp({ api = editorApi }: { api?: EditorApiContract }): JSX.Element {
  const [kind, setKind] = useState<EditorKind>('records');
  const [entries, setEntries] = useState<Record<EditorKind, EditorEntry[]>>({ records: [], profiles: [], documents: [] });
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [savedSource, setSavedSource] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    void Promise.all(kinds.map(async (entryKind) => [entryKind, await api.list(entryKind)] as const))
      .then((loaded) => setEntries(Object.fromEntries(loaded) as Record<EditorKind, EditorEntry[]>))
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.'));
  }, [api]);

  const hasUnsavedChanges = Boolean(draft && (draft.dirty || deleting));
  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedChanges]);

  const recordIds = entries.records.map((entry) => entry.id);
  const allIds = kinds.flatMap((entryKind) => entries[entryKind].map((entry) => entry.id));
  const visibleEntries = entries[kind].filter((entry) => `${entry.id} ${titleFrom(kind, entry.source)}`.toLowerCase().includes(query.toLowerCase()));
  const preview = useMemo(() => draft ? previewSource(draft.source) : null, [draft]);
  const action: EditorAction = deleting ? '삭제 예정' : isNew ? '생성' : draft?.dirty ? '수정' : '변경 없음';

  function transition(next: () => void) {
    if (hasUnsavedChanges && !window.confirm('저장하지 않은 변경 사항을 버리시겠습니까?')) return;
    next();
  }

  function select(entryKind: EditorKind, entry: EditorEntry) {
    transition(() => {
      setKind(entryKind);
      setDraft({ kind: entryKind, id: entry.id, source: entry.source, dirty: false, validation: validationFor(entryKind, entry.source, recordIds, allIds, false) });
      setSavedSource(entry.source);
      setIsNew(false);
      setDeleting(false);
      setMessage('');
    });
  }

  function create(entryKind: EditorKind) {
    transition(() => {
      const data = blankData(entryKind);
      const source = sourceFrom(data, '');
      setKind(entryKind);
      setDraft({ kind: entryKind, id: '', source, dirty: true, validation: validationFor(entryKind, source, recordIds, allIds, true) });
      setSavedSource(null);
      setIsNew(true);
      setDeleting(false);
      setMessage('');
    });
  }

  function update(dataUpdate: Partial<DraftData>, body?: string) {
    if (!draft) return;
    try {
      const current = previewSource(draft.source);
      if (!current) throw new Error('Markdown frontmatter를 읽을 수 없습니다.');
      const data = { ...current.data, ...dataUpdate } as DraftData;
      const source = sourceFrom(data, body ?? current.body);
      const id = isNew ? data.id : draft.id;
      setDraft({ kind: draft.kind, id, source, dirty: isNew || source !== savedSource, validation: validationFor(draft.kind, source, recordIds, allIds, isNew) });
      setDeleting(false);
    } catch (error) { setMessage(error instanceof Error ? error.message : '초안을 갱신하지 못했습니다.'); }
  }

  async function save() {
    if (!draft || (!deleting && !draft.validation.valid)) return;
    try {
      if (deleting) {
        await api.remove(draft.kind, draft.id);
        setEntries((current) => ({ ...current, [draft.kind]: current[draft.kind].filter((entry) => entry.id !== draft.id) }));
        setMessage('삭제한 항목을 휴지통으로 옮겼습니다.');
        setDraft(null);
        setDeleting(false);
        return;
      }

      const result = await api.save({ kind: draft.kind, id: draft.id, source: draft.source });
      setEntries((current) => {
        const withoutSaved = current[draft.kind].filter((entry) => entry.id !== result.id);
        return { ...current, [draft.kind]: [...withoutSaved, result] };
      });
      setSavedSource(result.source);
      setIsNew(false);
      setDraft({ kind: draft.kind, id: result.id, source: result.source, dirty: false, validation: validationFor(draft.kind, result.source, recordIds, allIds, false) });
      setMessage('저장했습니다.');
    } catch (error) {
      const fields = fieldErrors(error);
      if (fields) setDraft((current) => current ? { ...current, validation: { valid: false, fields } } : current);
      setMessage(error instanceof Error ? error.message : '저장하지 못했습니다.');
    }
  }

  function changeTab(entryKind: EditorKind) {
    transition(() => {
      setKind(entryKind);
      setQuery('');
      setDraft(null);
      setDeleting(false);
      setIsNew(false);
      setSavedSource(null);
    });
  }

  return <main>
    <header><h1>천무 로컬 편집기</h1><p>저장 전 미리보기와 스키마 검증을 확인하세요.</p></header>
    <nav aria-label="콘텐츠 종류">{kinds.map((entryKind) => <button key={entryKind} type="button" aria-pressed={kind === entryKind} onClick={() => changeTab(entryKind)}>{labels[entryKind].tab}</button>)}</nav>
    <section aria-label="콘텐츠 목록">
      <label>검색<input value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <button type="button" onClick={() => create(kind)}>{labels[kind].create}</button>
      <ul>{visibleEntries.map((entry) => <li key={entry.id}><button type="button" onClick={() => select(kind, entry)}>{titleFrom(kind, entry.source)} 편집</button></li>)}</ul>
    </section>
    {draft && preview && <section aria-label="편집 초안">
      {hasUnsavedChanges && <p role="status">저장하지 않은 변경 사항이 있습니다.</p>}
      {draft.kind === 'records' && <RecordForm value={preview.data as RecordMeta} body={preview.body} errors={draft.validation.fields} recordIds={recordIds} idEditable={isNew} onChange={update} onBodyChange={(body) => update({}, body)} />}
      {draft.kind === 'profiles' && <ProfileForm value={preview.data as ProfileMeta} body={preview.body} errors={draft.validation.fields} idEditable={isNew} onChange={update} onBodyChange={(body) => update({}, body)} />}
      {draft.kind === 'documents' && <DocumentForm value={preview.data as DocumentMeta} body={preview.body} errors={draft.validation.fields} idEditable={isNew} onChange={update} onBodyChange={(body) => update({}, body)} />}
      {!isNew && <button type="button" onClick={() => setDeleting((value) => !value)}>{deleting ? '삭제 취소' : '삭제 예정으로 표시'}</button>}
      <button type="button" disabled={deleting ? false : !draft.validation.valid} onClick={() => void save()}>{deleting ? '삭제 확인' : '저장'}</button>
      <PreviewPane kind={draft.kind} data={preview.data} body={preview.body} path={`src/content/${draft.kind}/${draft.id}.md`} action={action} />
    </section>}
    {message && <p role="status">{message}</p>}
  </main>;
}
