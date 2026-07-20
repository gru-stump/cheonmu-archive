import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { parse as parseYaml, stringify } from 'yaml';
import { ZodError, type ZodType } from 'zod';
import { parseMarkdown } from '../content/frontmatter';
import {
  documentMetaSchema,
  profileMetaSchema,
  recordMetaSchema,
  type DocumentMeta,
  type GalleryItem,
  type ProfileMeta,
  type RecordMeta,
} from '../content/schema';
import { DocumentForm } from './DocumentForm';
import { editorApi, EditorApiError, type EditorApi as EditorApiContract, type EditorEntry, type EditorKind } from './api';
import { GalleryForm, suggestedGalleryPath, validateGalleryDraft } from './GalleryForm';
import { galleryImageExtension, type GalleryImageExtension } from './gallery-image';
import { PreviewPane, type EditorAction } from './PreviewPane';
import { ProfileForm } from './ProfileForm';
import { RecordForm } from './RecordForm';

export type { EditorApi } from './api';
type DraftData = RecordMeta | ProfileMeta | DocumentMeta;
type EditorSection = EditorKind | 'gallery';

export interface EditorDraft {
  kind: EditorKind;
  id: string;
  source: string;
  dirty: boolean;
  validation: { valid: boolean; fields: Record<string, string> };
}

type GalleryDraft = {
  item: GalleryItem;
  saved: GalleryItem | null;
  isNew: boolean;
  dirty: boolean;
  validation: { valid: boolean; fields: Record<string, string> };
};

const schemas: Record<EditorKind, ZodType<DraftData>> = { records: recordMetaSchema, profiles: profileMetaSchema, documents: documentMetaSchema };
const contentKinds = ['records', 'profiles', 'documents'] as const;
const sections = [...contentKinds, 'gallery'] as const;
const labels: Record<EditorSection, { tab: string; create: string }> = {
  records: { tab: '기록', create: '새 기록' },
  profiles: { tab: '프로필', create: '새 프로필' },
  documents: { tab: '문서', create: '새 문서' },
  gallery: { tab: '화랑', create: '새 화랑 작품' },
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
      if (missing) return { valid: false, fields: { related: `연결한 기록을 찾을 수 없습니다: ${missing}` } };
    }
    return { valid: true, fields: {} };
  } catch (error) {
    if (error instanceof ZodError) return { valid: false, fields: Object.fromEntries(error.issues.map((issue) => [issue.path.join('.') || 'source', issue.message])) };
    return { valid: false, fields: { source: error instanceof Error ? error.message : '유효하지 않은 Markdown입니다.' } };
  }
}

function galleryValidationFor(item: GalleryItem, existingIds: readonly string[], isNew: boolean): GalleryDraft['validation'] {
  const validation = validateGalleryDraft(item);
  if (isNew && existingIds.includes(item.id)) {
    return { valid: false, fields: { ...validation.fields, id: '이미 사용 중인 식별자입니다.' } };
  }
  return validation;
}

function titleFrom(kind: EditorKind, source: string): string { try { return splitSource(kind, source).data.title; } catch { return '유효하지 않은 초안'; } }

function blankData(kind: EditorKind): DraftData {
  if (kind === 'records') return { id: '', recordNumber: '', title: '', stage: 1, status: 'draft', characters: [], tags: [], related: [], quote: '', cinematic: false };
  return { id: '', title: '' };
}

function blankGallery(): GalleryItem {
  return { id: '', title: '', image: '', alt: '', creator: '', characters: [], tags: [], public: false };
}

function fieldErrors(error: unknown): Record<string, string> | undefined {
  if (typeof error !== 'object' || error === null || !('fields' in error)) return undefined;
  const fields = error.fields;
  return typeof fields === 'object' && fields !== null ? fields as Record<string, string> : undefined;
}

export function EditorApp({ api = editorApi }: { api?: EditorApiContract }): JSX.Element {
  const [kind, setKind] = useState<EditorSection>('records');
  const [entries, setEntries] = useState<Record<EditorKind, EditorEntry[]>>({ records: [], profiles: [], documents: [] });
  const [galleryItems, setGalleryItems] = useState<GalleryItem[]>([]);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [galleryDraft, setGalleryDraft] = useState<GalleryDraft | null>(null);
  const [selectedGalleryFile, setSelectedGalleryFile] = useState<File | null>(null);
  const [selectedGalleryExtension, setSelectedGalleryExtension] = useState<GalleryImageExtension | null>(null);
  const [galleryImagePending, setGalleryImagePending] = useState(false);
  const [savedSource, setSavedSource] = useState<string | null>(null);
  const [isNew, setIsNew] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  const pendingRef = useRef(false);
  const galleryImageReadToken = useRef(0);
  const selectedGalleryFileRef = useRef<File | null>(null);

  useEffect(() => {
    void Promise.all([
      ...contentKinds.map(async (entryKind) => [entryKind, await api.list(entryKind)] as const),
      api.listGallery(),
    ]).then((loaded) => {
      const content = loaded.slice(0, contentKinds.length) as Array<readonly [EditorKind, EditorEntry[]]>;
      setEntries(Object.fromEntries(content) as Record<EditorKind, EditorEntry[]>);
      setGalleryItems(loaded[contentKinds.length] as GalleryItem[]);
    }).catch((error: unknown) => setMessage(error instanceof Error ? error.message : '목록을 불러오지 못했습니다.'));
  }, [api]);

  const hasUnsavedChanges = Boolean((draft && (draft.dirty || deleting)) || (galleryDraft && (galleryDraft.dirty || deleting)));
  useEffect(() => {
    if (!hasUnsavedChanges) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedChanges]);

  const recordIds = entries.records.map((entry) => entry.id);
  const allIds = [...contentKinds.flatMap((entryKind) => entries[entryKind].map((entry) => entry.id)), ...galleryItems.map((item) => item.id)];
  const visibleEntries = kind === 'gallery'
    ? []
    : entries[kind].filter((entry) => `${entry.id} ${titleFrom(kind, entry.source)}`.toLowerCase().includes(query.toLowerCase()));
  const visibleGallery = kind === 'gallery'
    ? galleryItems.filter((item) => `${item.id} ${item.title}`.toLowerCase().includes(query.toLowerCase()))
    : [];
  const preview = useMemo(() => draft ? previewSource(draft.source) : null, [draft]);
  const action: EditorAction = deleting ? '삭제 예정' : isNew ? '생성' : draft?.dirty ? '수정' : '변경 없음';

  function transition(next: () => void) {
    if (pendingRef.current) return;
    if (hasUnsavedChanges && !window.confirm('저장하지 않은 변경 사항을 버리시겠습니까?')) return;
    next();
  }

  function clearGalleryImageSelection() {
    galleryImageReadToken.current += 1;
    selectedGalleryFileRef.current = null;
    setSelectedGalleryFile(null);
    setSelectedGalleryExtension(null);
    setGalleryImagePending(false);
  }

  function resetDrafts() {
    setDraft(null);
    setGalleryDraft(null);
    clearGalleryImageSelection();
    setDeleting(false);
    setIsNew(false);
    setSavedSource(null);
  }

  function select(entryKind: EditorKind, entry: EditorEntry) {
    transition(() => {
      setKind(entryKind);
      setGalleryDraft(null);
      clearGalleryImageSelection();
      setDraft({ kind: entryKind, id: entry.id, source: entry.source, dirty: false, validation: validationFor(entryKind, entry.source, recordIds, allIds, false) });
      setSavedSource(entry.source);
      setIsNew(false);
      setDeleting(false);
      setMessage('');
    });
  }

  function selectGallery(item: GalleryItem) {
    transition(() => {
      setKind('gallery');
      setDraft(null);
      setSavedSource(null);
      clearGalleryImageSelection();
      setGalleryDraft({ item, saved: item, isNew: false, dirty: false, validation: galleryValidationFor(item, allIds, false) });
      setIsNew(false);
      setDeleting(false);
      setMessage('');
    });
  }

  function create(entryKind: EditorSection) {
    transition(() => {
      setKind(entryKind);
      setDeleting(false);
      setMessage('');
      if (entryKind === 'gallery') {
        const item = blankGallery();
        setDraft(null);
        setSavedSource(null);
        clearGalleryImageSelection();
        setGalleryDraft({ item, saved: null, isNew: true, dirty: true, validation: galleryValidationFor(item, allIds, true) });
        setIsNew(false);
        return;
      }
      const data = blankData(entryKind);
      const source = sourceFrom(data, '');
      setGalleryDraft(null);
      clearGalleryImageSelection();
      setDraft({ kind: entryKind, id: '', source, dirty: true, validation: validationFor(entryKind, source, recordIds, allIds, true) });
      setSavedSource(null);
      setIsNew(true);
    });
  }

  function update(dataUpdate: Partial<DraftData>, body?: string) {
    if (!draft || pendingRef.current) return;
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

  function updateGallery(change: Partial<GalleryItem>) {
    if (!galleryDraft || pendingRef.current) return;
    const item = { ...galleryDraft.item, ...change };
    if (selectedGalleryFile && selectedGalleryExtension && change.id !== undefined) {
      item.image = suggestedGalleryPath(item.id, selectedGalleryExtension);
    }
    const dirty = galleryDraft.isNew || Boolean(selectedGalleryFile) || JSON.stringify(item) !== JSON.stringify(galleryDraft.saved);
    setGalleryDraft({ ...galleryDraft, item, dirty, validation: galleryValidationFor(item, allIds, galleryDraft.isNew) });
    setDeleting(false);
  }

  async function chooseGalleryFile(file: File | null) {
    if (!galleryDraft || pendingRef.current) return;
    const token = galleryImageReadToken.current + 1;
    galleryImageReadToken.current = token;
    selectedGalleryFileRef.current = file;
    setSelectedGalleryFile(file);
    setSelectedGalleryExtension(null);
    setDeleting(false);
    if (!file) {
      setGalleryImagePending(false);
      setGalleryDraft((current) => {
        if (!current || galleryImageReadToken.current !== token) return current;
        const item = { ...current.item, image: current.saved?.image ?? '' };
        return {
          ...current,
          item,
          dirty: current.isNew || JSON.stringify(item) !== JSON.stringify(current.saved),
          validation: galleryValidationFor(item, allIds, current.isNew),
        };
      });
      return;
    }

    setGalleryImagePending(true);
    setGalleryDraft((current) => current ? {
      ...current,
      dirty: true,
      validation: { ...galleryValidationFor(current.item, allIds, current.isNew), valid: false },
    } : current);

    let extension: GalleryImageExtension | null = null;
    let readError = false;
    try {
      extension = await galleryImageExtension(file);
    } catch {
      readError = true;
    }
    if (galleryImageReadToken.current !== token || selectedGalleryFileRef.current !== file) return;

    setSelectedGalleryExtension(extension);
    setGalleryImagePending(false);
    setGalleryDraft((current) => {
      if (!current || galleryImageReadToken.current !== token || selectedGalleryFileRef.current !== file) return current;
      const item = { ...current.item, image: suggestedGalleryPath(current.item.id, extension) };
      const validation = galleryValidationFor(item, allIds, current.isNew);
      if (!extension) {
        validation.fields.image = readError
          ? '이미지 파일을 읽지 못했습니다.'
          : 'PNG, JPEG, WebP 이미지 파일만 사용할 수 있습니다.';
      }
      return {
        ...current,
        item,
        dirty: true,
        validation: { valid: validation.valid && Boolean(extension), fields: validation.fields },
      };
    });
  }

  async function saveContent() {
    if (pendingRef.current || !draft || (!deleting && !draft.validation.valid)) return;
    const operation = deleting ? 'delete' : 'save';
    pendingRef.current = true;
    setPending(operation);
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
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  async function uploadGallery(item: GalleryItem, file: File) {
    const plan = api.planGalleryWithImage
      ? await api.planGalleryWithImage({ item, file })
      : { item, changes: [{ action: 'write' as const, path: 'src/content/gallery.yaml', visibility: 'metadata' as const }] };
    const replacements = plan.changes.filter(({ action }) => action === 'trash');
    if (replacements.length > 0) {
      const summary = plan.changes
        .map(({ action, path, visibility }) => `${action === 'write' ? '저장' : '휴지통'} [${visibility}] ${path}`)
        .join('\n');
      if (!window.confirm(`다음 파일 변경을 적용하시겠습니까?\n\n${summary}`)) {
        throw new EditorApiError('이미지 교체가 취소되었습니다.');
      }
    }
    return api.saveGalleryWithImage({ item: plan.item, file, overwrite: replacements.length > 0 });
  }

  async function saveGallery() {
    if (pendingRef.current || !galleryDraft || (!deleting && (galleryImagePending || !galleryDraft.validation.valid))) return;
    const operation = deleting ? 'delete' : 'save';
    pendingRef.current = true;
    setPending(operation);
    try {
      if (deleting) {
        await api.removeGallery(galleryDraft.item.id);
        setGalleryItems((current) => current.filter((item) => item.id !== galleryDraft.item.id));
        setMessage('삭제한 화랑 항목과 이미지를 휴지통으로 옮겼습니다.');
        setGalleryDraft(null);
        clearGalleryImageSelection();
        setDeleting(false);
        return;
      }
      const item = galleryDraft.item;
      const validation = galleryValidationFor(item, allIds, galleryDraft.isNew);
      if (!validation.valid) {
        setGalleryDraft({ ...galleryDraft, item, validation });
        return;
      }
      const result = selectedGalleryFile
        ? (await uploadGallery(item, selectedGalleryFile)).item
        : await api.saveGallery(item);
      setGalleryItems((current) => [...current.filter((entry) => entry.id !== result.id), result]);
      setGalleryDraft({ item: result, saved: result, isNew: false, dirty: false, validation: galleryValidationFor(result, allIds, false) });
      clearGalleryImageSelection();
      setMessage('화랑 항목을 저장했습니다.');
    } catch (error) {
      const fields = fieldErrors(error);
      if (fields) setGalleryDraft((current) => current ? { ...current, validation: { valid: false, fields } } : current);
      setMessage(error instanceof Error ? error.message : '화랑 항목을 저장하지 못했습니다.');
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  function changeTab(entryKind: EditorSection) {
    transition(() => {
      setKind(entryKind);
      setQuery('');
      resetDrafts();
    });
  }

  const currentDraft = galleryDraft ?? draft;
  return <main>
    <header><h1>천무 로컬 편집기</h1><p>저장 전 미리보기와 스키마 검증을 확인하세요.</p></header>
    <nav aria-label="콘텐츠 종류">{sections.map((entryKind) => <button key={entryKind} type="button" disabled={pending !== null} aria-pressed={kind === entryKind} onClick={() => changeTab(entryKind)}>{labels[entryKind].tab}</button>)}</nav>
    <section aria-label="콘텐츠 목록">
      <label>검색<input disabled={pending !== null} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <button type="button" disabled={pending !== null} onClick={() => create(kind)}>{labels[kind].create}</button>
      <ul>
        {visibleEntries.map((entry) => <li key={entry.id}><button type="button" disabled={pending !== null} onClick={() => select(kind as EditorKind, entry)}>{titleFrom(kind as EditorKind, entry.source)} 편집</button></li>)}
        {visibleGallery.map((item) => <li key={item.id}><button type="button" disabled={pending !== null} onClick={() => selectGallery(item)}>{item.title} 편집</button></li>)}
      </ul>
    </section>
    {currentDraft && <section aria-label="편집 초안">
      {hasUnsavedChanges && <p role="status">저장하지 않은 변경 사항이 있습니다.</p>}
      {pending && <p role="status" aria-live="polite">{pending === 'delete' ? '삭제 중입니다.' : '저장 중입니다.'}</p>}
      {draft && preview && <>
        {draft.kind === 'records' && <RecordForm value={preview.data as RecordMeta} body={preview.body} errors={draft.validation.fields} recordIds={recordIds} idEditable={isNew} disabled={pending !== null} onChange={update} onBodyChange={(body) => update({}, body)} />}
        {draft.kind === 'profiles' && <ProfileForm value={preview.data as ProfileMeta} body={preview.body} errors={draft.validation.fields} idEditable={isNew} disabled={pending !== null} onChange={update} onBodyChange={(body) => update({}, body)} />}
        {draft.kind === 'documents' && <DocumentForm value={preview.data as DocumentMeta} body={preview.body} errors={draft.validation.fields} idEditable={isNew} disabled={pending !== null} onChange={update} onBodyChange={(body) => update({}, body)} />}
        {!isNew && <button type="button" disabled={pending !== null} onClick={() => setDeleting((value) => !value)}>{deleting ? '삭제 취소' : '삭제 예정으로 표시'}</button>}
        <button type="button" disabled={pending !== null || (deleting ? false : !draft.validation.valid)} onClick={() => void saveContent()}>{deleting ? '삭제 확인' : '저장'}</button>
        <PreviewPane kind={draft.kind} data={preview.data} body={preview.body} path={`src/content/${draft.kind}/${draft.id}.md`} action={action} />
      </>}
      {galleryDraft && <>
        <GalleryForm value={galleryDraft.item} errors={galleryDraft.validation.fields} idEditable={galleryDraft.isNew} disabled={pending !== null} selectedFile={selectedGalleryFile} selectedExtension={selectedGalleryExtension} savedPublic={galleryDraft.saved?.public} onChange={updateGallery} onFileChange={(file) => void chooseGalleryFile(file)} />
        {galleryImagePending && <p role="status">이미지 확인 중입니다.</p>}
        {!galleryDraft.isNew && <button type="button" disabled={pending !== null} onClick={() => setDeleting((value) => !value)}>{deleting ? '삭제 취소' : '삭제 예정으로 표시'}</button>}
        <button type="button" disabled={pending !== null || (deleting ? false : galleryImagePending || !galleryDraft.validation.valid)} onClick={() => void saveGallery()}>{deleting ? '삭제 확인' : '저장'}</button>
        <p>작업: {deleting ? '삭제 예정' : galleryDraft.isNew ? '생성' : galleryDraft.dirty ? '수정' : '변경 없음'}</p>
        <ul aria-label="변경 파일">
          <li>메타데이터 저장: src/content/gallery.yaml</li>
          <li>{galleryDraft.item.public ? '공개 저장' : '비공개 저장'}: {galleryDraft.item.public
            ? `public${galleryDraft.item.image}`
            : `src/content/private-images/${galleryDraft.item.image.slice('/images/'.length)}`}</li>
          {galleryDraft.saved && (galleryDraft.saved.image !== galleryDraft.item.image || galleryDraft.saved.public !== galleryDraft.item.public) && <li>
            휴지통 이동: {galleryDraft.saved.public
              ? `public${galleryDraft.saved.image}`
              : `src/content/private-images/${galleryDraft.saved.image.slice('/images/'.length)}`}
          </li>}
        </ul>
      </>}
    </section>}
    {message && <p role="status">{message}</p>}
  </main>;
}
