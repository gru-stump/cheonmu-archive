import { useCallback, useEffect, useId, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import type { GalleryItem } from '../../content/schema';

type GalleryLightboxProps = {
  items: readonly GalleryItem[];
  initialIndex: number;
  onClose: () => void;
};

const focusableSelector = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function GalleryLightbox({ items, initialIndex, onClose }: GalleryLightboxProps): JSX.Element | null {
  const [index, setIndex] = useState(() => Math.min(Math.max(initialIndex, 0), items.length - 1));
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const item = items[index];

  const restoreFocus = useCallback(() => {
    previouslyFocusedRef.current?.focus();
  }, []);

  const close = useCallback(() => {
    restoreFocus();
    onClose();
  }, [onClose, restoreFocus]);

  useEffect(() => {
    previouslyFocusedRef.current = globalThis.document.activeElement instanceof HTMLElement
      ? globalThis.document.activeElement
      : null;
    closeButtonRef.current?.focus();

    return restoreFocus;
  }, [restoreFocus]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }

    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (!first || !last) {
      event.preventDefault();
      dialogRef.current?.focus();
    } else if (event.shiftKey && globalThis.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && globalThis.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!item) return null;

  return (
    <div className="gallery-lightbox" role="presentation">
      <div
        ref={dialogRef}
        className="gallery-lightbox__dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        <header className="gallery-lightbox__header">
          <div>
            <p className="document-kicker">Gallery · {index + 1} / {items.length}</p>
            <h2 id={titleId}>{item.title}</h2>
          </div>
          <button ref={closeButtonRef} type="button" aria-label="라이트박스 닫기" onClick={close}>
            닫기
          </button>
        </header>

        <div className="gallery-lightbox__image-wrap">
          <img src={item.image} alt={item.alt} />
        </div>

        <footer className="gallery-lightbox__footer">
          <div className="gallery-lightbox__credit">
            <p>작가 <strong>{item.creator}</strong></p>
            {item.tags && <p>{item.tags.map((tag) => `#${tag}`).join(' ')}</p>}
            {item.source && (
              <a href={item.source} target="_blank" rel="noreferrer">출처 보기</a>
            )}
          </div>
          <div className="gallery-lightbox__controls">
            <button
              type="button"
              aria-label="이전 이미지"
              disabled={index === 0}
              onClick={() => setIndex((current) => Math.max(0, current - 1))}
            >
              이전
            </button>
            <button
              type="button"
              aria-label="다음 이미지"
              disabled={index === items.length - 1}
              onClick={() => setIndex((current) => Math.min(items.length - 1, current + 1))}
            >
              다음
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
