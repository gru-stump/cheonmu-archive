import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAllContent } from '../../content/load';
import type { WorldDocument } from '../../content/schema';
import { WorldPage } from './WorldPage';

const content = loadAllContent();

afterEach(cleanup);

function renderWorldPage(
  initialEntry: string,
  documents: readonly WorldDocument[] = content.world,
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route
          path="world"
          element={<WorldPage documents={documents} records={content.records} />}
        />
        <Route
          path="world/:documentId"
          element={<WorldPage documents={documents} records={content.records} />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

describe('WorldPage', () => {
  it('selects WF-01 when the index route has no document id', () => {
    renderWorldPage('/world');

    expect(screen.getByRole('heading', { name: '특수재난관리청' })).toBeInTheDocument();
    expect(screen.getByText(/WF-01 · 공개 열람 · 상태 공개 · CM-06 기준/))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: /WF-01.*특수재난관리청/ }))
      .toHaveAttribute('aria-current', 'page');
  });

  it('shows only recurring-anomaly sections released by CM-06', () => {
    const recurring = content.world.find((document) => document.id === 'recurring-anomalies')!;
    const documents = content.world.map((document) => document.id === recurring.id ? {
      ...document,
      sections: [
        ...document.sections,
        { revealStage: 7, paragraphs: ['천령은 인외라는 직접 정체 공개.'] },
      ],
    } : document);

    renderWorldPage('/world/recurring-anomalies', documents);

    expect(screen.getByText('심각한 오염과 치료 이후 일부 보고 수치가 정정되었다.'))
      .toBeInTheDocument();
    expect(screen.queryByText('천령은 인외라는 직접 정체 공개.')).not.toBeInTheDocument();
  });

  it('falls back from an unknown id and offers the canonical WF-01 route', () => {
    renderWorldPage('/world/missing-document');

    expect(screen.getByRole('heading', { name: '특수재난관리청' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '정식 문서 주소' }))
      .toHaveAttribute('href', '/world/special-disaster-agency');
  });

  it('links related CM-01 to its shareable record route', () => {
    renderWorldPage('/world/special-disaster-agency');

    expect(screen.getByRole('link', { name: 'CM-01' }))
      .toHaveAttribute('href', '/records/first-contact');
  });

  it('shows approved CL-01 clues and its lock label without a direct secret', () => {
    const classified = content.world.find((document) => document.id === 'cheonryeong-restricted')!;
    const documents = content.world.map((document) => document.id === classified.id ? {
      ...document,
      sections: [
        ...document.sections,
        { revealStage: 7, paragraphs: ['피는 독이자 약이라는 기밀.'] },
      ],
    } : document);

    renderWorldPage('/world/cheonryeong-restricted', documents);

    expect(screen.getByText('신원 기록 일부 불일치.')).toBeInTheDocument();
    expect(screen.getByText('특정 오염 상황에서 비정상 반응 관측.')).toBeInTheDocument();
    expect(screen.getByText(/추가 기록 확인 후 해금/)).toBeInTheDocument();
    expect(screen.queryByText(/피는 독이자 약/)).not.toBeInTheDocument();
  });

  it('toggles the mobile index and closes it after selecting a document', async () => {
    const user = userEvent.setup();
    renderWorldPage('/world');
    const toggle = screen.getByRole('button', { name: '분류 색인' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    const targetLink = screen.getByRole('link', { name: /OB-01.*반복 관측 이상/ });
    await user.click(targetLink);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    const selectedHeading = screen.getByRole('heading', { name: '반복 관측 이상' });
    expect(selectedHeading).toBeInTheDocument();
    expect(selectedHeading).not.toHaveFocus();
    expect(targetLink).toHaveFocus();
  });

  it('moves keyboard focus to the selected document heading after collapsing the mobile index', async () => {
    const user = userEvent.setup();
    renderWorldPage('/world');
    const toggle = screen.getByRole('button', { name: '분류 색인' });

    await user.tab();
    expect(toggle).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');

    await user.tab();
    expect(screen.getByRole('link', { name: /WF-01.*특수재난관리청/ })).toHaveFocus();
    await user.tab();
    const targetLink = screen.getByRole('link', { name: /WF-02.*특수기동대/ });
    expect(targetLink).toHaveFocus();
    await user.keyboard('{Enter}');

    const selectedHeading = screen.getByRole('heading', { name: '특수기동대' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.activeElement).toBe(selectedHeading);
  });
});
