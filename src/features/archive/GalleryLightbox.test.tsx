import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GalleryItem } from '../../content/schema';
import { GalleryPage } from './GalleryPage';
import { GalleryLightbox } from './GalleryLightbox';

const publicFixtures: GalleryItem[] = [
  {
    id: 'cheonryeong-ld',
    title: '천령 전신',
    image: '/images/Cheonryeong_LD.png',
    alt: '천령과 무영 전신 설정화',
    creator: '불가사리',
    source: 'https://example.com/art',
    characters: ['cheonryeong'],
    tags: ['전신'],
    public: true,
  },
  {
    id: 'muyeong-head',
    title: '무영 두상',
    image: '/images/Muyeong_head.png',
    alt: '무영 두상 설정화',
    creator: '불가사리',
    characters: ['muyeong'],
    tags: ['두상'],
    public: true,
  },
];

const privateFixture: GalleryItem = {
  ...publicFixtures[0],
  id: 'private-work',
  title: '비공개 작업',
  alt: '비공개 작업',
  public: false,
};

afterEach(cleanup);

describe('GalleryPage', () => {
  it('shows only public gallery items', () => {
    render(
      <MemoryRouter>
        <GalleryPage items={[...publicFixtures, privateFixture]} />
      </MemoryRouter>,
    );

    expect(screen.getByAltText('천령과 무영 전신 설정화')).toBeVisible();
    expect(screen.queryByAltText('비공개 작업')).not.toBeInTheDocument();
  });

  it('opens the selected public image with its credit and tags', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <GalleryPage items={publicFixtures} />
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: '천령 전신 크게 보기' }));

    const dialog = screen.getByRole('dialog', { name: '천령 전신' });
    expect(within(dialog).getByText('불가사리')).toBeVisible();
    expect(within(dialog).getByText('#전신')).toBeVisible();
    expect(within(dialog).getByRole('link', { name: '출처 보기' })).toHaveAttribute(
      'href',
      'https://example.com/art',
    );
  });
});

describe('GalleryLightbox', () => {
  it('closes the lightbox with Escape', async () => {
    const onClose = vi.fn();
    render(<GalleryLightbox items={publicFixtures} initialIndex={0} onClose={onClose} />);

    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('supports previous and next navigation', async () => {
    const user = userEvent.setup();
    render(<GalleryLightbox items={publicFixtures} initialIndex={0} onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '천령 전신' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '다음 이미지' }));
    expect(screen.getByRole('heading', { name: '무영 두상' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: '이전 이미지' }));
    expect(screen.getByRole('heading', { name: '천령 전신' })).toBeVisible();
  });

  it('traps focus and restores it when closed', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button type="button">열기</button>
      </>,
    );
    const trigger = screen.getByRole('button', { name: '열기' });
    trigger.focus();

    rerender(
      <>
        <button type="button">열기</button>
        <GalleryLightbox items={publicFixtures} initialIndex={0} onClose={onClose} />
      </>,
    );

    const closeButton = screen.getByRole('button', { name: '라이트박스 닫기' });
    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: '다음 이미지' })).toHaveFocus();

    await user.click(closeButton);
    expect(onClose).toHaveBeenCalledOnce();
    expect(trigger).toHaveFocus();
  });
});
