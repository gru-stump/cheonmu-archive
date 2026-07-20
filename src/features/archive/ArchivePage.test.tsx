import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import type { ArchiveContent } from '../../content/schema';
import { ArchivePage } from './ArchivePage';
import { DocumentPage } from './DocumentPage';
import { ProfilePage } from './ProfilePage';

const content: ArchiveContent = {
  records: [],
  scenes: [],
  profiles: [
    { id: 'cheonryeong', title: '천령', height: '186cm', body: '## 의료관\n\n**치유**를 담당한다.' },
    { id: 'muyeong', title: '무영', height: '185cm', body: '## 지휘관\n\n현장을 지휘한다.' },
  ],
  documents: [
    { id: 'relationship', title: '천무 관계 개요', body: '## 관계\n\n천령과 무영의 기록.' },
  ],
  gallery: [
    {
      id: 'cheonryeong-ld',
      title: '천령 전신',
      image: '/images/Cheonryeong_LD.png',
      alt: '천령 전신 설정화',
      creator: '불가사리',
      characters: ['cheonryeong'],
      tags: ['전신', '캐릭터-디자인'],
      public: true,
    },
  ],
};

afterEach(cleanup);

function renderArchive() {
  return render(
    <MemoryRouter>
      <ArchivePage content={content} />
    </MemoryRouter>,
  );
}

describe('ArchivePage', () => {
  it('provides visible type, character, and tag filters', () => {
    renderArchive();

    expect(screen.getByLabelText('자료 유형')).toBeVisible();
    expect(screen.getByLabelText('등장인물')).toBeVisible();
    expect(screen.getByLabelText('태그')).toBeVisible();
  });

  it('filters archive cards and links each result to an independent route', async () => {
    const user = userEvent.setup();
    renderArchive();

    await user.selectOptions(screen.getByLabelText('자료 유형'), 'profile');
    await user.selectOptions(screen.getByLabelText('등장인물'), 'cheonryeong');

    expect(screen.getByRole('link', { name: /천령/ })).toHaveAttribute(
      'href',
      '/archive/profiles/cheonryeong',
    );
    expect(screen.queryByRole('link', { name: /무영/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /천무 관계 개요/ })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('자료 유형'), 'gallery');
    await user.selectOptions(screen.getByLabelText('태그'), '전신');
    expect(screen.getByRole('link', { name: /천령 전신/ })).toHaveAttribute(
      'href',
      '/archive/gallery',
    );
  });
});

describe('archive detail pages', () => {
  it('renders profile and document Markdown', () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/archive/profiles/cheonryeong']}>
        <Routes>
          <Route path="archive/profiles/:id" element={<ProfilePage profiles={content.profiles} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: '의료관' })).toBeVisible();
    expect(screen.getByTestId('profile-content-display')).toBeVisible();
    expect(screen.getByText('치유')).toHaveProperty('tagName', 'STRONG');

    unmount();
    render(
      <MemoryRouter initialEntries={['/archive/documents/relationship']}>
        <Routes>
          <Route path="archive/documents/:id" element={<DocumentPage documents={content.documents} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: '관계' })).toBeVisible();
    expect(screen.getByTestId('document-content-display')).toBeVisible();
  });

  it.each([
    ['profiles', <ProfilePage profiles={content.profiles} />],
    ['documents', <DocumentPage documents={content.documents} />],
  ])('offers archive recovery for a missing %s id', (kind, element) => {
    render(
      <MemoryRouter initialEntries={[`/archive/${kind}/missing`]}>
        <Routes>
          <Route path={`archive/${kind}/:id`} element={element} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: '아카이브로 돌아가기' })).toHaveAttribute(
      'href',
      '/archive',
    );
  });
});
