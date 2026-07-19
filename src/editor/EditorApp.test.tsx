import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorApp, type EditorApi } from './EditorApp';
import type { EditorEntry, EditorKind, EditorSaveRequest } from './api';

const sources: Record<EditorKind, EditorEntry[]> = {
  records: [
    { id: 'first-contact', source: `---
id: first-contact
recordNumber: CM-01
title: "첫 조우"
stage: 1
status: confirmed
characters: [cheonryeong, muyeong]
tags: [첫조우, 치료]
related: [second-return]
quote: "그가 돌아왔다."
cinematic: true
credit:
  creator: 기록관
  source: https://example.com/record
---

첫 기록입니다.` },
    { id: 'second-return', source: `---
id: second-return
recordNumber: CM-02
title: "두 번째 귀환"
stage: 2
status: draft
characters: [cheonryeong]
tags: [귀환]
related: [first-contact]
quote: "다시 돌아왔다."
cinematic: false
---

두 번째 기록입니다.` },
  ],
  profiles: [{ id: 'cheonryeong', source: `---
id: cheonryeong
title: "천령"
height: 186cm
credit:
  creator: 프로필 작가
  source: https://example.com/profile
---

## 의사

인외 의사입니다.` }],
  documents: [{ id: 'relationship', source: `---
id: relationship
title: "관계 문서"
credit:
  creator: 문서 작가
  source: https://example.com/document
---

## 관계

두 사람의 기록입니다.` }],
};

function createApi(overrides: Partial<EditorApi> = {}): EditorApi {
  return {
    list: vi.fn(async (kind: EditorKind) => sources[kind].map((entry) => ({ ...entry }))),
    save: vi.fn(async ({ id, source }) => ({ id, source })),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function openRecord(user: ReturnType<typeof userEvent.setup>, name = '첫 조우 편집') {
  await user.click(await screen.findByRole('button', { name }));
  return screen.findByLabelText('제목');
}

describe('EditorApp', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(cleanup);

  it('validates, previews, and saves an edited record', async () => {
    const user = userEvent.setup();
    const api = createApi();
    render(<EditorApp api={api} />);

    const title = await openRecord(user);
    await user.clear(title);
    await user.type(title, '최초 접촉');

    expect(screen.getByRole('heading', { name: '최초 접촉' })).toBeVisible();
    expect(screen.getByTestId('record-content-display')).toBeVisible();
    expect(screen.getByText('CM-01 · Stage 01')).toBeVisible();
    expect(screen.getByText('그가 돌아왔다.')).toBeVisible();
    expect(screen.getByText('cheonryeong, muyeong')).toBeVisible();
    expect(screen.getByText('작업: 수정')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'first-contact', kind: 'records' }));
  });

  it('keeps an existing entry ID read-only and explains the rule', async () => {
    const user = userEvent.setup();
    render(<EditorApp api={createApi()} />);
    await openRecord(user);

    expect(screen.getByLabelText('식별자')).toHaveAttribute('readonly');
    expect(screen.getByText('기존 항목의 식별자는 변경할 수 없습니다.')).toBeVisible();
  });

  it.each([
    ['기록', '새 기록', 'new-record', '새 기록 제목', ['기록 번호', 'NEW-01'], ['인용문', '새 인용문']],
    ['프로필', '새 프로필', 'new-profile', '새 프로필 제목', null, null],
    ['문서', '새 문서', 'new-document', '새 문서 제목', null, null],
  ] as const)('creates a reachable new %s entry with an exact path', async (tab, createName, id, title, extraOne, extraTwo) => {
    const user = userEvent.setup();
    const api = createApi();
    render(<EditorApp api={api} />);

    if (tab !== '기록') await user.click(await screen.findByRole('button', { name: tab }));
    await user.click(await screen.findByRole('button', { name: createName }));
    await user.type(screen.getByLabelText('식별자'), id);
    await user.type(screen.getByLabelText('제목'), title);
    if (extraOne) await user.type(screen.getByLabelText(extraOne[0]), extraOne[1]);
    if (extraTwo) await user.type(screen.getByLabelText(extraTwo[0]), extraTwo[1]);

    expect(screen.getByText('작업: 생성')).toBeVisible();
    expect(screen.getByText(`src/content/${tab === '기록' ? 'records' : tab === '프로필' ? 'profiles' : 'documents'}/${id}.md`)).toBeVisible();
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ id }));
  });

  it('rejects a new ID already used by another content kind', async () => {
    const user = userEvent.setup();
    render(<EditorApp api={createApi()} />);
    await user.click(await screen.findByRole('button', { name: '프로필' }));
    await user.click(screen.getByRole('button', { name: '새 프로필' }));
    await user.type(screen.getByLabelText('식별자'), 'first-contact');
    await user.type(screen.getByLabelText('제목'), '중복 프로필');

    expect(screen.getByText('이미 사용 중인 식별자입니다.')).toBeVisible();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  });

  it('reports unchanged, modified, and delete-planned states accurately', async () => {
    const user = userEvent.setup();
    render(<EditorApp api={createApi()} />);
    const title = await openRecord(user);

    expect(screen.getByText('작업: 변경 없음')).toBeVisible();
    await user.type(title, '!');
    expect(screen.getByText('작업: 수정')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '삭제 예정으로 표시' }));
    expect(screen.getByText('작업: 삭제 예정')).toBeVisible();
  });

  it('updates the entry cache after save so reselection uses saved content', async () => {
    const user = userEvent.setup();
    const api = createApi();
    render(<EditorApp api={api} />);
    const title = await openRecord(user);
    await user.clear(title);
    await user.type(title, '저장된 제목');
    await user.click(screen.getByRole('button', { name: '저장' }));

    await user.click(screen.getByRole('button', { name: '두 번째 귀환 편집' }));
    await user.click(screen.getByRole('button', { name: '저장된 제목 편집' }));
    expect(screen.getByLabelText('제목')).toHaveValue('저장된 제목');
  });

  it('deletes through remove only and removes the stale list entry', async () => {
    const user = userEvent.setup();
    const api = createApi();
    render(<EditorApp api={api} />);
    await openRecord(user);
    await user.click(screen.getByRole('button', { name: '삭제 예정으로 표시' }));
    await user.click(screen.getByRole('button', { name: '삭제 확인' }));

    expect(api.remove).toHaveBeenCalledWith('records', 'first-contact');
    expect(api.save).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: '첫 조우 편집' })).not.toBeInTheDocument();
  });

  it('locks editing, navigation, and duplicate submission while save is pending', async () => {
    const user = userEvent.setup();
    const pending = deferred<EditorEntry>();
    const save = vi.fn((_request: EditorSaveRequest) => pending.promise);
    render(<EditorApp api={createApi({ save })} />);
    const title = await openRecord(user);
    await user.type(title, '!');
    await user.click(screen.getByRole('button', { name: '저장' }));

    expect(screen.getByText('저장 중입니다.')).toHaveAttribute('role', 'status');
    expect(title).toBeDisabled();
    expect(screen.getByRole('button', { name: '프로필' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '새 기록' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    await user.type(title, '늦은 편집');
    await user.click(screen.getByRole('button', { name: '프로필' }));
    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(title).toHaveValue('첫 조우!');

    const request = save.mock.calls[0]![0];
    await act(async () => pending.resolve({ id: request.id, source: request.source }));
    await waitFor(() => expect(screen.queryByText('저장 중입니다.')).not.toBeInTheDocument());
    expect(screen.getByLabelText('제목')).toHaveValue('첫 조우!');
  });

  it('locks navigation while delete is pending and cannot resurrect the deleted draft', async () => {
    const user = userEvent.setup();
    const pending = deferred<void>();
    const remove = vi.fn(() => pending.promise);
    render(<EditorApp api={createApi({ remove })} />);
    await openRecord(user);
    await user.click(screen.getByRole('button', { name: '삭제 예정으로 표시' }));
    await user.click(screen.getByRole('button', { name: '삭제 확인' }));

    expect(screen.getByText('삭제 중입니다.')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: '문서' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '두 번째 귀환 편집' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '문서' }));
    expect(screen.getByLabelText('제목')).toHaveValue('첫 조우');

    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.queryByRole('button', { name: '첫 조우 편집' })).not.toBeInTheDocument());
    expect(screen.queryByLabelText('제목')).not.toBeInTheDocument();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('keeps dirty content when item navigation is cancelled', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<EditorApp api={createApi()} />);
    await user.type(await openRecord(user), '!');
    await user.click(screen.getByRole('button', { name: '두 번째 귀환 편집' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(screen.getByLabelText('제목')).toHaveValue('첫 조우!');
  });

  it('allows tab navigation after dirty-content confirmation', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<EditorApp api={createApi()} />);
    await user.type(await openRecord(user), '!');
    await user.click(screen.getByRole('button', { name: '프로필' }));

    expect(window.confirm).toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: '천령 편집' })).toBeVisible();
    expect(screen.queryByLabelText('기록 번호')).not.toBeInTheDocument();
  });

  it('protects creating another item and browser unload when dirty', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<EditorApp api={createApi()} />);
    await user.type(await openRecord(user), '!');
    await user.click(screen.getByRole('button', { name: '새 기록' }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText('제목')).toHaveValue('첫 조우!');

    const event = new Event('beforeunload', { cancelable: true });
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('maps API field errors inline with accessible control linkage', async () => {
    const user = userEvent.setup();
    const api = createApi({ save: vi.fn(async () => { throw Object.assign(new Error('검증 실패'), { fields: { title: '서버가 제목을 거부했습니다.' } }); }) });
    render(<EditorApp api={api} />);
    await user.type(await openRecord(user), '!');
    await user.click(screen.getByRole('button', { name: '저장' }));

    const title = screen.getByLabelText('제목');
    const error = await screen.findByText('서버가 제목을 거부했습니다.');
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(title).toHaveAttribute('aria-describedby', error.id);
  });

  it('links local validation errors to their controls', async () => {
    const user = userEvent.setup();
    render(<EditorApp api={createApi()} />);
    const title = await openRecord(user);
    await user.clear(title);
    const error = screen.getByRole('alert');
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(title).toHaveAttribute('aria-describedby', error.id);
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
  });

  it('previews essential profile and document fields', async () => {
    const user = userEvent.setup();
    render(<EditorApp api={createApi()} />);
    await user.click(await screen.findByRole('button', { name: '프로필' }));
    await user.click(await screen.findByRole('button', { name: '천령 편집' }));
    const profilePreview = screen.getByRole('complementary', { name: '미리보기' });
    expect(within(profilePreview).getByTestId('profile-content-display')).toBeVisible();
    expect(within(profilePreview).getByText('신장 186cm')).toBeVisible();
    expect(within(profilePreview).getByText('프로필 작가')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '문서' }));
    await user.click(await screen.findByRole('button', { name: '관계 문서 편집' }));
    const documentPreview = screen.getByRole('complementary', { name: '미리보기' });
    expect(within(documentPreview).getByTestId('document-content-display')).toBeVisible();
    expect(within(documentPreview).getByText('문서 작가')).toBeVisible();
    expect(within(documentPreview).getByRole('heading', { name: '관계' })).toBeVisible();
  });
});
