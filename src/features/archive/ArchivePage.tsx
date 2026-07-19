import { useMemo, useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { loadAllContent } from '../../content/load';
import type { ArchiveContent } from '../../content/schema';

type ArchivePageProps = {
  content?: ArchiveContent;
};

type ArchiveType = 'profile' | 'document' | 'gallery';

type ArchiveCard = {
  id: string;
  type: ArchiveType;
  title: string;
  description: string;
  path: string;
  characters: string[];
  tags: string[];
};

const characterNames: Record<string, string> = {
  cheonryeong: '천령',
  muyeong: '무영',
};

const typeNames: Record<ArchiveType, string> = {
  profile: '인물',
  document: '문서',
  gallery: '화랑',
};

function toCards(content: ArchiveContent): ArchiveCard[] {
  const profileCards = content.profiles.map((profile) => ({
    id: profile.id,
    type: 'profile' as const,
    title: profile.title,
    description: profile.height ? `신장 ${profile.height}` : '인물 자료',
    path: `/archive/profiles/${profile.id}`,
    characters: [profile.id],
    tags: ['인물'],
  }));
  const documentCards = content.documents.map((document) => ({
    id: document.id,
    type: 'document' as const,
    title: document.title,
    description: '설정 및 관계 문서',
    path: `/archive/documents/${document.id}`,
    characters: Object.entries(characterNames)
      .filter(([, name]) => `${document.title}\n${document.body}`.includes(name))
      .map(([id]) => id),
    tags: ['문서'],
  }));
  const galleryCards = content.gallery
    .filter((item) => item.public)
    .map((item) => ({
      id: item.id,
      type: 'gallery' as const,
      title: item.title,
      description: `작가 ${item.creator}`,
      path: '/archive/gallery',
      characters: item.characters,
      tags: item.tags ?? [],
    }));

  return [...profileCards, ...documentCards, ...galleryCards];
}

export function ArchivePage({ content = loadAllContent() }: ArchivePageProps): JSX.Element {
  const [type, setType] = useState('all');
  const [character, setCharacter] = useState('all');
  const [tag, setTag] = useState('all');
  const cards = useMemo(() => toCards(content), [content]);
  const characters = [...new Set(cards.flatMap((card) => card.characters))];
  const tags = [...new Set(cards.flatMap((card) => card.tags))];
  const visibleCards = cards.filter((card) => (
    (type === 'all' || card.type === type)
    && (character === 'all' || card.characters.includes(character))
    && (tag === 'all' || card.tags.includes(tag))
  ));

  return (
    <section className="archive-page" aria-labelledby="archive-title">
      <header className="document-header">
        <div>
          <p className="document-kicker">Profiles · Documents · Gallery</p>
          <h1 id="archive-title">아카이브</h1>
          <p>인물 자료와 설정 문서, 공개 설정화를 분류해 열람합니다.</p>
        </div>
        <Link className="archive-gallery-link" to="/archive/gallery">화랑 전체 보기</Link>
      </header>

      <form className="archive-filters" aria-label="아카이브 필터">
        <label>
          <span>자료 유형</span>
          <select value={type} onChange={(event) => setType(event.target.value)}>
            <option value="all">전체</option>
            <option value="profile">인물</option>
            <option value="document">문서</option>
            <option value="gallery">화랑</option>
          </select>
        </label>
        <label>
          <span>등장인물</span>
          <select value={character} onChange={(event) => setCharacter(event.target.value)}>
            <option value="all">전체</option>
            {characters.map((id) => <option key={id} value={id}>{characterNames[id] ?? id}</option>)}
          </select>
        </label>
        <label>
          <span>태그</span>
          <select value={tag} onChange={(event) => setTag(event.target.value)}>
            <option value="all">전체</option>
            {tags.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
      </form>

      <p className="archive-result-count" aria-live="polite">자료 {visibleCards.length}건</p>
      {visibleCards.length > 0 ? (
        <ul className="archive-card-grid">
          {visibleCards.map((card) => (
            <li key={`${card.type}-${card.id}`}>
              <Link className="archive-card" to={card.path}>
                <span className="archive-card__type">{typeNames[card.type]}</span>
                <h2>{card.title}</h2>
                <p>{card.description}</p>
                {card.tags.length > 0 && <small>{card.tags.map((item) => `#${item}`).join(' ')}</small>}
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="archive-empty">선택한 조건에 맞는 자료가 없습니다.</p>
      )}
    </section>
  );
}
