import { useState, type JSX } from 'react';
import { Link } from 'react-router-dom';
import { loadAllContent } from '../../content/load';
import type { GalleryItem } from '../../content/schema';
import { resolvePublicAssetUrl } from '../../lib/publicAssetUrl';
import { GalleryLightbox } from './GalleryLightbox';

type GalleryPageProps = {
  items?: readonly GalleryItem[];
};

export function GalleryPage({ items = loadAllContent().gallery }: GalleryPageProps): JSX.Element {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const publicItems = items.filter((item) => item.public === true);

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

      <ul className="gallery-grid">
        {publicItems.map((item, index) => (
          <li key={item.id}>
            <button
              className="gallery-card"
              type="button"
              aria-label={`${item.title} 크게 보기`}
              onClick={() => setSelectedIndex(index)}
            >
              <span className="gallery-card__image"><img src={resolvePublicAssetUrl(item.image)} alt={item.alt} /></span>
              <span className="gallery-card__caption">
                <strong>{item.title}</strong>
                <small>작가 {item.creator}</small>
              </span>
            </button>
          </li>
        ))}
      </ul>

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
