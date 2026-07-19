import { useState } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CinematicScene } from './CinematicScene';

const sceneFixtures = [
  { id: 'scene-1', text: '이번에는 돌아와요.', speaker: '천령' },
  { id: 'scene-2', text: '전부 데리고 돌아오겠습니다.', speaker: '무영' },
  { id: 'scene-3', text: '당신도 포함해서.', speaker: '천령' },
];

afterEach(cleanup);

describe('CinematicScene', () => {
  it('labels the modal and moves through scenes without autoplaying', async () => {
    const user = userEvent.setup();
    render(<CinematicScene title="귀환의 약속" scenes={sceneFixtures} onClose={vi.fn()} />);

    expect(screen.getByRole('dialog', { name: '귀환의 약속 장면 재구성' })).toBeInTheDocument();
    expect(screen.getByText(sceneFixtures[0].text)).toBeVisible();
    expect(screen.queryByText(sceneFixtures[1].text)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '이전 장면' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: '다음 장면' }));

    expect(screen.getByText(sceneFixtures[1].text)).toBeVisible();
    expect(screen.getByText('2 / 3')).toBeVisible();
  });

  it('closes with Escape and restores focus to the opener', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();

    function SceneHarness() {
      const [isOpen, setIsOpen] = useState(false);

      return (
        <>
          <button type="button" onClick={() => setIsOpen(true)}>장면 재구성 열기</button>
          {isOpen && (
            <CinematicScene
              title="귀환의 약속"
              scenes={sceneFixtures}
              onClose={() => {
                onClose();
                setIsOpen(false);
              }}
            />
          )}
        </>
      );
    }

    render(<SceneHarness />);
    const opener = screen.getByRole('button', { name: '장면 재구성 열기' });
    await user.click(opener);

    await user.keyboard('{Escape}');

    expect(onClose).toHaveBeenCalledOnce();
    expect(opener).toHaveFocus();
  });

  it('traps Tab focus inside the dialog', async () => {
    const user = userEvent.setup();
    render(<CinematicScene title="귀환의 약속" scenes={sceneFixtures} onClose={vi.fn()} />);

    const closeButton = screen.getByRole('button', { name: '장면 재구성 닫기' });
    const nextButton = screen.getByRole('button', { name: '다음 장면' });

    expect(closeButton).toHaveFocus();
    await user.tab({ shift: true });
    expect(nextButton).toHaveFocus();
    await user.tab();
    expect(closeButton).toHaveFocus();
  });
});
