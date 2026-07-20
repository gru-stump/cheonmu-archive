import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { galleryItemSchema, type GalleryItem } from '../content/schema';
import { GalleryForm, validateGalleryDraft } from './GalleryForm';
import { EditorApp } from './EditorApp';

const validItem: GalleryItem = {
  id: 'work',
  title: '공개 작품',
  image: '/images/work.png',
  alt: '두 인물이 함께 서 있는 전신 그림',
  creator: '기록 화가',
  source: 'https://example.com/work',
  characters: ['cheonryeong', 'muyeong'],
  tags: ['전신'],
  public: true,
};
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const jpg = Uint8Array.from([0xff, 0xd8, 0xff]);

class DelayedFileReader {
  static pending: DelayedFileReader[] = [];
  result: ArrayBuffer | null = null;
  error: DOMException | null = null;
  onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
  onerror: ((event: ProgressEvent<FileReader>) => void) | null = null;

  readAsArrayBuffer(): void {
    DelayedFileReader.pending.push(this);
  }

  resolve(bytes: Uint8Array): void {
    this.result = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
  }
}

function delayFileReaders(): void {
  DelayedFileReader.pending = [];
  vi.stubGlobal('FileReader', DelayedFileReader as unknown as typeof FileReader);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  DelayedFileReader.pending = [];
});

describe('gallery validation', () => {
  it('requires creator and alt text for public work through the shared schema', () => {
    const result = galleryItemSchema.safeParse({ ...validItem, creator: '', alt: '' });
    expect(result.success).toBe(false);
    expect(validateGalleryDraft({ ...validItem, creator: '', alt: '' }).fields)
      .toEqual(expect.objectContaining({ creator: expect.any(String), alt: expect.any(String) }));
  });

  it('requires character tags and rejects non-HTTPS source URLs', () => {
    const result = validateGalleryDraft({ ...validItem, characters: [], source: 'http://example.com/work' });
    expect(result.valid).toBe(false);
    expect(result.fields).toEqual(expect.objectContaining({ characters: expect.any(String), source: expect.any(String) }));
  });
});

describe('GalleryForm', () => {
  it('uses the editor route for a saved private preview and the public URL for a public item', () => {
    const sharedProps = {
      errors: {},
      idEditable: false,
      selectedFile: null,
      selectedExtension: null,
      onChange: vi.fn(),
      onFileChange: vi.fn(),
    };
    const { rerender } = render(<GalleryForm
      {...sharedProps}
      value={{ ...validItem, public: false }}
    />);

    expect(screen.getByRole('img', { name: validItem.alt }))
      .toHaveAttribute('src', '/api/editor/gallery/work/image');

    rerender(<GalleryForm {...sharedProps} value={validItem} />);
    expect(screen.getByRole('img', { name: validItem.alt }))
      .toHaveAttribute('src', '/images/work.png');
  });

  it('keeps a saved private preview usable while its public toggle is unsaved', async () => {
    const user = userEvent.setup();
    const privateItem = { ...validItem, public: false };
    const api = {
      list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(),
      listGallery: vi.fn(async () => [privateItem]), saveGallery: vi.fn(), removeGallery: vi.fn(),
      uploadGalleryImage: vi.fn(), saveGalleryWithImage: vi.fn(),
    };
    render(<EditorApp api={api} />);
    await user.click(await screen.findByRole('button', { name: '화랑' }));
    await user.click(await screen.findByRole('button', { name: '공개 작품 편집' }));
    const image = screen.getByRole('img', { name: validItem.alt });
    expect(image).toHaveAttribute('src', '/api/editor/gallery/work/image');

    await user.click(screen.getByLabelText('공개'));

    expect(image).toHaveAttribute('src', '/api/editor/gallery/work/image');
  });

  it('treats a selected same-path replacement as an unsaved change', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = {
      list: vi.fn(async () => []),
      save: vi.fn(),
      remove: vi.fn(),
      listGallery: vi.fn(async () => [validItem]),
      saveGallery: vi.fn(async (entry: GalleryItem) => entry),
      removeGallery: vi.fn(),
      uploadGalleryImage: vi.fn(),
      saveGalleryWithImage: vi.fn(),
    };
    render(<EditorApp api={api} />);
    await user.click(await screen.findByRole('button', { name: '화랑' }));
    await user.click(await screen.findByRole('button', { name: /편집$/ }));
    const file = new File([png], 'work.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('이미지 파일'), file);

    await user.click(screen.getByRole('button', { name: '기록' }));

    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText('이미지 파일')).toBeInTheDocument();
  });

  it('derives the result extension from bytes and recomputes the path after ID edits', async () => {
    const user = userEvent.setup();
    const api = {
      list: vi.fn(async () => []),
      save: vi.fn(),
      remove: vi.fn(),
      listGallery: vi.fn(async () => []),
      saveGallery: vi.fn(),
      removeGallery: vi.fn(),
      uploadGalleryImage: vi.fn(),
      saveGalleryWithImage: vi.fn(),
    };
    render(<EditorApp api={api} />);
    await user.click(await screen.findByRole('button', { name: '화랑' }));
    await user.click(screen.getByRole('button', { name: '새 화랑 작품' }));
    const id = screen.getByLabelText('식별자');
    await user.type(id, 'first-id');
    const disguisedPng = new File([png], 'portrait.JPEG', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText('이미지 파일'), disguisedPng);

    expect(await screen.findByText('/images/first-id.png')).toBeVisible();
    await user.clear(id);
    await user.type(id, 'renamed-id');
    expect(screen.getByText('/images/renamed-id.png')).toBeVisible();
  });

  it('marks a pending signature read dirty immediately and blocks save', async () => {
    delayFileReaders();
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = {
      list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(),
      listGallery: vi.fn(async () => [validItem]), saveGallery: vi.fn(), removeGallery: vi.fn(),
      uploadGalleryImage: vi.fn(), saveGalleryWithImage: vi.fn(),
    };
    render(<EditorApp api={api} />);
    await user.click(await screen.findByRole('button', { name: '화랑' }));
    await user.click(await screen.findByRole('button', { name: '공개 작품 편집' }));

    await user.upload(screen.getByLabelText('이미지 파일'), new File([png], 'work.png', { type: 'image/png' }));

    expect(screen.getByText('이미지 확인 중입니다.')).toHaveAttribute('role', 'status');
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '기록' }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText('이미지 파일')).toBeInTheDocument();
  });

  it('uses the latest ID when a delayed signature read finishes', async () => {
    delayFileReaders();
    const user = userEvent.setup();
    const api = {
      list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(),
      listGallery: vi.fn(async () => []), saveGallery: vi.fn(), removeGallery: vi.fn(),
      uploadGalleryImage: vi.fn(), saveGalleryWithImage: vi.fn(),
    };
    render(<EditorApp api={api} />);
    await user.click(await screen.findByRole('button', { name: '화랑' }));
    await user.click(screen.getByRole('button', { name: '새 화랑 작품' }));
    const id = screen.getByLabelText('식별자');
    await user.type(id, 'first-id');
    await user.upload(screen.getByLabelText('이미지 파일'), new File([png], 'portrait.png', { type: 'image/png' }));
    await user.clear(id);
    await user.type(id, 'latest-id');

    await act(async () => DelayedFileReader.pending[0]!.resolve(png));

    expect(id).toHaveValue('latest-id');
    expect(screen.getByText('/images/latest-id.png')).toBeVisible();
  });

  it('ignores an older signature read after a newer file is selected', async () => {
    delayFileReaders();
    const user = userEvent.setup();
    const api = {
      list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(),
      listGallery: vi.fn(async () => []), saveGallery: vi.fn(), removeGallery: vi.fn(),
      uploadGalleryImage: vi.fn(), saveGalleryWithImage: vi.fn(),
    };
    render(<EditorApp api={api} />);
    await user.click(await screen.findByRole('button', { name: '화랑' }));
    await user.click(screen.getByRole('button', { name: '새 화랑 작품' }));
    await user.type(screen.getByLabelText('식별자'), 'race-work');
    const input = screen.getByLabelText('이미지 파일');
    await user.upload(input, new File([png], 'older.png', { type: 'image/png' }));
    await user.upload(input, new File([jpg], 'newer.jpg', { type: 'image/jpeg' }));

    await act(async () => DelayedFileReader.pending[1]!.resolve(jpg));
    expect(screen.getByText('/images/race-work.jpg')).toBeVisible();
    await act(async () => DelayedFileReader.pending[0]!.resolve(png));

    expect(screen.getByText('/images/race-work.jpg')).toBeVisible();
    expect(screen.queryByText('/images/race-work.png')).not.toBeInTheDocument();
  });

  it('ignores a delayed signature read after gallery navigation', async () => {
    delayFileReaders();
    const user = userEvent.setup();
    const secondItem = { ...validItem, id: 'second-work', title: '두 번째 작품', image: '/images/second-work.png' };
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const api = {
      list: vi.fn(async () => []), save: vi.fn(), remove: vi.fn(),
      listGallery: vi.fn(async () => [validItem, secondItem]), saveGallery: vi.fn(), removeGallery: vi.fn(),
      uploadGalleryImage: vi.fn(), saveGalleryWithImage: vi.fn(),
    };
    render(<EditorApp api={api} />);
    await user.click(await screen.findByRole('button', { name: '화랑' }));
    await user.click(await screen.findByRole('button', { name: '공개 작품 편집' }));
    await user.upload(screen.getByLabelText('이미지 파일'), new File([png], 'work.png', { type: 'image/png' }));
    await user.click(screen.getByRole('button', { name: '두 번째 작품 편집' }));
    expect(confirm).toHaveBeenCalled();

    await act(async () => DelayedFileReader.pending[0]!.resolve(png));

    expect(screen.getByLabelText('제목')).toHaveValue('두 번째 작품');
    expect(screen.getByText('/images/second-work.png')).toBeVisible();
  });

  it('shows the selected image preview and resulting normalized public path before save', async () => {
    const user = userEvent.setup();
    const onFileChange = vi.fn();
    const file = new File(['image'], 'portrait.JPEG', { type: 'image/jpeg' });
    const createObjectURL = vi.fn(() => 'blob:gallery-preview');
    const revokeObjectURL = vi.fn();
    Object.defineProperties(URL, {
      createObjectURL: { configurable: true, value: createObjectURL },
      revokeObjectURL: { configurable: true, value: revokeObjectURL },
    });

    const { rerender } = render(<GalleryForm
      value={{ ...validItem, image: '' }}
      errors={{}}
      idEditable
      selectedFile={null}
      selectedExtension={null}
      onChange={vi.fn()}
      onFileChange={onFileChange}
    />);
    await user.upload(screen.getByLabelText('이미지 파일'), file);
    expect(onFileChange).toHaveBeenCalledWith(file);

    rerender(<GalleryForm
      value={{ ...validItem, image: '' }}
      errors={{}}
      idEditable
      selectedFile={file}
      selectedExtension="jpg"
      onChange={vi.fn()}
      onFileChange={onFileChange}
    />);
    expect(screen.getByRole('img', { name: '선택한 이미지 미리보기' })).toHaveAttribute('src', 'blob:gallery-preview');
    expect(screen.getByText('/images/work.jpg')).toBeVisible();
  });

  it('integrates gallery creation with upload, metadata save, and unsaved navigation protection', async () => {
    const user = userEvent.setup();
    const saveGallery = vi.fn(async (entry: GalleryItem) => entry);
    const uploadGalleryImage = vi.fn();
    const saveGalleryWithImage = vi.fn(async ({ item }: { item: GalleryItem }) => ({
      item: { ...item, image: '/images/new-work.png' },
      image: { path: '/images/new-work.png', width: 1, height: 1 },
    }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = {
      list: vi.fn(async () => []),
      save: vi.fn(),
      remove: vi.fn(),
      listGallery: vi.fn(async () => []),
      saveGallery,
      removeGallery: vi.fn(),
      uploadGalleryImage,
      saveGalleryWithImage,
    };
    render(<EditorApp api={api} />);

    await user.click(await screen.findByRole('button', { name: '화랑' }));
    await user.click(screen.getByRole('button', { name: '새 화랑 작품' }));
    await user.type(screen.getByLabelText('식별자'), 'new-work');
    await user.type(screen.getByLabelText('제목'), '새 작품');
    await user.type(screen.getByLabelText('대체 텍스트'), '새 작품의 자세한 설명');
    await user.type(screen.getByLabelText('제작자'), '기록 화가');
    await user.type(screen.getByLabelText('캐릭터 태그'), 'cheonryeong');
    await user.click(screen.getByLabelText('공개'));
    const file = new File([png], 'upload.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('이미지 파일'), file);
    expect(screen.getByText('/images/new-work.png')).toBeVisible();

    await user.click(screen.getByRole('button', { name: '기록' }));
    expect(confirm).toHaveBeenCalled();
    expect(screen.getByLabelText('제목')).toHaveValue('새 작품');

    await user.click(screen.getByRole('button', { name: '저장' }));
    expect(saveGalleryWithImage).toHaveBeenCalledWith(expect.objectContaining({ item: expect.objectContaining({ id: 'new-work', image: '/images/new-work.png' }), file, overwrite: false }));
    expect(uploadGalleryImage).not.toHaveBeenCalled();
    expect(saveGallery).not.toHaveBeenCalled();
  });

  it('locks gallery editing and navigation while metadata save is pending', async () => {
    const user = userEvent.setup();
    const pending = deferred<GalleryItem>();
    const saveGallery = vi.fn(() => pending.promise);
    const api = {
      list: vi.fn(async () => []),
      save: vi.fn(),
      remove: vi.fn(),
      listGallery: vi.fn(async () => [validItem]),
      saveGallery,
      removeGallery: vi.fn(),
      uploadGalleryImage: vi.fn(),
      saveGalleryWithImage: vi.fn(),
    };
    render(<EditorApp api={api} />);
    await user.click(await screen.findByRole('button', { name: '화랑' }));
    await user.click(await screen.findByRole('button', { name: '공개 작품 편집' }));
    const title = screen.getByLabelText('제목');
    await user.type(title, '!');
    await user.click(screen.getByRole('button', { name: '저장' }));

    expect(screen.getByText('저장 중입니다.')).toHaveAttribute('role', 'status');
    expect(title).toBeDisabled();
    expect(screen.getByRole('button', { name: '기록' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();

    await act(async () => pending.resolve({ ...validItem, title: '공개 작품!' }));
    await waitFor(() => expect(screen.queryByText('저장 중입니다.')).not.toBeInTheDocument());
    expect(screen.getByLabelText('제목')).toHaveValue('공개 작품!');
    expect(saveGallery).toHaveBeenCalledTimes(1);
  });
});
