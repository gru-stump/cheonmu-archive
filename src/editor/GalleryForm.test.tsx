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
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(cleanup);

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
      onChange={vi.fn()}
      onFileChange={onFileChange}
    />);
    expect(screen.getByRole('img', { name: '선택한 이미지 미리보기' })).toHaveAttribute('src', 'blob:gallery-preview');
    expect(screen.getByText('/images/work.jpg')).toBeVisible();
  });

  it('integrates gallery creation with upload, metadata save, and unsaved navigation protection', async () => {
    const user = userEvent.setup();
    const saveGallery = vi.fn(async (entry: GalleryItem) => entry);
    const uploadGalleryImage = vi.fn(async () => ({ path: '/images/new-work.png', width: 1, height: 1 }));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const api = {
      list: vi.fn(async () => []),
      save: vi.fn(),
      remove: vi.fn(),
      listGallery: vi.fn(async () => []),
      saveGallery,
      removeGallery: vi.fn(),
      uploadGalleryImage,
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
    expect(uploadGalleryImage).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-work', file, overwrite: false }));
    expect(saveGallery).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-work', image: '/images/new-work.png' }));
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
