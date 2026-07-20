import { useCallback, useEffect, useId, useRef, useState, type JSX, type KeyboardEvent, type UIEvent } from 'react';
import { resolvePublicAssetUrl } from '../../lib/publicAssetUrl';

export type CinematicSceneItem = {
  id: string;
  speaker?: string;
  text: string;
  backdrop?: string;
};

export type CinematicSceneProps = {
  title: string;
  scenes: readonly CinematicSceneItem[];
  onClose: () => void;
};

const focusableSelector = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const proseSceneMinimumLength = 120;

export function CinematicScene({ title, scenes, onClose }: CinematicSceneProps): JSX.Element {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [isHeaderHidden, setIsHeaderHidden] = useState(false);
  const readerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const lastScrollTopRef = useRef(0);
  const titleId = useId();
  const scene = scenes[sceneIndex];
  const isProseScene = (scene?.text.trim().length ?? 0) >= proseSceneMinimumLength;

  const restoreFocus = useCallback(() => {
    previouslyFocusedRef.current?.focus();
  }, []);

  const close = useCallback(() => {
    restoreFocus();
    onClose();
  }, [onClose, restoreFocus]);

  useEffect(() => {
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    closeButtonRef.current?.focus();

    return restoreFocus;
  }, [restoreFocus]);

  useEffect(() => {
    lastScrollTopRef.current = 0;
    setIsHeaderHidden(false);
  }, [scene?.id, isProseScene]);

  function handleReaderScroll(event: UIEvent<HTMLDivElement>) {
    if (!isProseScene) return;

    const scrollTop = event.currentTarget.scrollTop;
    const lastScrollTop = lastScrollTopRef.current;

    if (scrollTop <= 24 || scrollTop < lastScrollTop) {
      setIsHeaderHidden(false);
    } else if (scrollTop > 72 && scrollTop > lastScrollTop) {
      setIsHeaderHidden(true);
    }

    lastScrollTopRef.current = scrollTop;
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusableElements = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(focusableSelector) ?? [],
    );
    if (focusableElements.length === 0) {
      event.preventDefault();
      dialogRef.current?.focus();
      return;
    }

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];

    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  }

  return (
    <div ref={readerRef} className="cinematic-scene" role="presentation" onScroll={handleReaderScroll}>
      <div
        ref={dialogRef}
        className={`cinematic-scene__dialog${isProseScene ? ' cinematic-scene__dialog--prose' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {scene?.backdrop && (
          <div
            className="cinematic-scene__backdrop"
            style={{ backgroundImage: `url(${JSON.stringify(resolvePublicAssetUrl(scene.backdrop))})` }}
            aria-hidden="true"
          />
        )}
        <header
          className={`cinematic-scene__header${isProseScene ? ' cinematic-scene__header--sticky' : ''}${isProseScene && isHeaderHidden ? ' cinematic-scene__header--hidden' : ''}`}
          onFocusCapture={isProseScene ? () => setIsHeaderHidden(false) : undefined}
        >
          <div>
            <p className="cinematic-scene__kicker">Scene Reconstruction</p>
            <h2 id={titleId}>{title} 장면 재구성</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="cinematic-scene__close"
            type="button"
            aria-label="장면 재구성 닫기"
            onClick={close}
          >
            닫기
          </button>
        </header>

        <div
          className={`cinematic-scene__content${isProseScene ? ' cinematic-scene__content--prose' : ''}`}
          aria-live="polite"
          aria-atomic="true"
        >
          {scene ? (
            <div key={scene.id} className="cinematic-scene__frame">
              {scene.speaker && <p className="cinematic-scene__speaker">{scene.speaker}</p>}
              <p className={`cinematic-scene__text${isProseScene ? ' cinematic-scene__text--prose' : ''}`}>
                {scene.text}
              </p>
            </div>
          ) : (
            <p className="cinematic-scene__empty">재구성할 장면이 없습니다.</p>
          )}
        </div>

        {scenes.length > 1 && (
          <footer className="cinematic-scene__controls">
            <button
              type="button"
              onClick={() => setSceneIndex((current) => Math.max(0, current - 1))}
              disabled={sceneIndex === 0}
            >
              이전 장면
            </button>
            <p aria-label="현재 장면">{`${sceneIndex + 1} / ${scenes.length}`}</p>
            <button
              type="button"
              onClick={() => setSceneIndex((current) => Math.min(scenes.length - 1, current + 1))}
              disabled={sceneIndex === scenes.length - 1}
            >
              다음 장면
            </button>
          </footer>
        )}
      </div>
    </div>
  );
}
