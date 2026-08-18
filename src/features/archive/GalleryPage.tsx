import { useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { loadAllContent } from '../../content/load';
import type { GalleryItem } from '../../content/schema';
import { resolvePublicAssetUrl } from '../../lib/publicAssetUrl';
import { GalleryLightbox } from './GalleryLightbox';

type GalleryPageProps = {
  items?: readonly GalleryItem[];
};

function galleryGroup(item: GalleryItem): string {
  if (item.pages && item.pages.length > 1) return '만화';
  if (item.tags?.includes('캐릭터-디자인') || item.tags?.includes('로고')) return '설정화';
  if (item.tags?.includes('삽화')) return '기록 삽화';
  return '일러스트';
}

const scrollToSection = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

export function GalleryPage({ items = loadAllContent().gallery }: GalleryPageProps): JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const publicItems = items.filter((item) => item.public === true);
  const canonItems = publicItems.filter((item) => !item.nonCanon);
  const phantomItems = publicItems.filter((item) => item.nonCanon);
  const grouped = ['설정화', '기록 삽화', '일러스트', '만화']
    .map((group) => ({ group, rows: canonItems.filter((item) => galleryGroup(item) === group) }))
    .filter(({ rows }) => rows.length > 0);
  const gridClass = 'gallery-grid gallery-grid--masonry';
  const tocEntries = [
    ...grouped.map(({ group, rows }) => ({ id: `gallery-section-${group}`, label: group, count: rows.length })),
    ...(phantomItems.length > 0 ? [{ id: 'gallery-section-phantom', label: '존재하지 않는 기록', count: phantomItems.length }] : []),
  ];

  const renderCard = (item: GalleryItem) => (
    <li key={item.id}>
      <button
        className={`gallery-card${item.nonCanon ? ' gallery-card--phantom' : ''}`}
        type="button"
        aria-label={`${item.title} 크게 보기`}
        onClick={() => setSelectedIndex(publicItems.indexOf(item))}
      >
        <span className="gallery-card__image">
          <img src={resolvePublicAssetUrl(item.image)} alt={item.alt} />
          {item.nonCanon && <span className="gallery-card__phantom">존재하지 않는 기록</span>}
          {item.pages && item.pages.length > 1 && <span className="gallery-card__pages">만화 · {item.pages.length}쪽</span>}
        </span>
        <span className="gallery-card__caption">
          <strong>{item.title}</strong>
          <small>작가 {item.creator}</small>
        </span>
      </button>
    </li>
  );

  return (
    <section className="gallery-page" aria-labelledby="gallery-title">
      <Link className="back-link" to="/archive">← 아카이브</Link>
      <header className="document-header">
        <div>
          <p className="document-kicker">Public Character Gallery</p>
          <h1 id="gallery-title">공개 화랑</h1>
          <p>공개가 허용된 설정화만 전시합니다.</p>
        </div>
      </header>

      {tocEntries.length > 1 && (
        <nav className="gallery-toc" aria-label="화랑 목차">
          {tocEntries.map((entry) => (
            <button key={entry.id} type="button" onClick={() => scrollToSection(entry.id)}>
              {entry.label} <span>{entry.count}</span>
            </button>
          ))}
        </nav>
      )}

      {grouped.map(({ group, rows }) => (
        <section key={group} id={`gallery-section-${group}`} className="gallery-group" aria-label={group}>
          <header className="gallery-group__header">
            <h2>{group}</h2>
            <span>{rows.length}점</span>
          </header>
          <ul className={gridClass}>
            {rows.map(renderCard)}
          </ul>
        </section>
      ))}

      {phantomItems.length > 0 && (
        <section id="gallery-section-phantom" className="gallery-phantom-section" aria-labelledby="gallery-phantom-title">
          <header className="gallery-phantom-section__header">
            <h2 id="gallery-phantom-title">존재하지 않는 기록</h2>
            <p>어느 문서고에도 등재되지 않은 장면들. 열람은 가능하나, 아무것도 증명하지 않습니다.</p>
          </header>
          <ul className={gridClass}>
            {phantomItems.map(renderCard)}
          </ul>
        </section>
      )}

      {selectedIndex !== null && (
        <GalleryLightbox
          items={publicItems}
          initialIndex={selectedIndex}
          onClose={() => setSelectedIndex(null)}
        />
      )}
    </section>
  );
}
