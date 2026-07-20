import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { loadAllContent } from '../../content/load';
import type { ArchiveRecord } from '../../content/schema';
import { HomePage } from '../home/HomePage';
import { RecordDetailPage } from './RecordDetailPage';
import { TimelinePage } from './TimelinePage';

const records: ArchiveRecord[] = [
  {
    id: 'draft-note',
    recordNumber: 'CM-03',
    title: '초안 기록',
    stage: 3,
    status: 'draft',
    characters: ['cheonryeong', 'muyeong'],
    tags: ['초안'],
    related: [],
    quote: '아직 정리 중인 기록.',
    cinematic: false,
    body: '결론을 내리기 전의 메모입니다.',
  },
  {
    id: 'first-contact',
    recordNumber: 'CM-01',
    title: '첫 조우',
    stage: 1,
    status: 'confirmed',
    characters: ['cheonryeong', 'muyeong'],
    tags: ['첫-조우'],
    related: ['second-return'],
    quote: '전원 철수한 뒤에 나가겠습니다.',
    cinematic: true,
    body: '**정체불명의 의사와 중상 환자.**',
  },
  {
    id: 'second-return',
    recordNumber: 'CM-02',
    title: '두 번째 귀환',
    stage: 2,
    status: 'confirmed',
    characters: ['cheonryeong', 'muyeong'],
    tags: ['귀환'],
    related: ['first-contact'],
    quote: '이번에도 돌아왔네.',
    cinematic: false,
    body: '다시 치료실로 돌아온 날.',
  },
];

const actualRecords = loadAllContent().records;

afterEach(cleanup);

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
}

function RecordRouteControls() {
  const navigate = useNavigate();

  return (
    <>
      <button type="button" onClick={() => navigate('/records/second-return')}>
        비시네마틱 기록으로 이동
      </button>
      <button type="button" onClick={() => navigate('/records/first-contact')}>
        시네마틱 기록으로 이동
      </button>
    </>
  );
}

function renderTimeline(initialEntry = '/records') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <TimelinePage records={records} />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('TimelinePage', () => {
  it('renders records in stage order and links each card to its detail', () => {
    renderTimeline();

    expect(screen.getByRole('group', { name: '기록 상태 필터' })).toBeInTheDocument();
    const cards = screen.getAllByTestId('record-card');
    expect(cards).toHaveLength(3);
    expect(within(cards[0]).getByRole('heading', { name: '첫 조우' })).toBeInTheDocument();
    expect(within(cards[1]).getByRole('heading', { name: '두 번째 귀환' })).toBeInTheDocument();
    expect(within(cards[2]).getByRole('heading', { name: '초안 기록' })).toBeInTheDocument();
    expect(within(cards[0]).getByRole('link', { name: /첫 조우/ })).toHaveAttribute(
      'href',
      '/records/first-contact',
    );
  });

  it('filters the timeline to confirmed records and updates the URL', async () => {
    const user = userEvent.setup();
    renderTimeline();

    await user.click(screen.getByRole('button', { name: '확정' }));

    expect(screen.getAllByTestId('record-card')).toHaveLength(2);
    expect(screen.queryByText('초안 기록')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '확정' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('location')).toHaveTextContent('?status=confirmed');
  });

  it('hydrates the selected filter from the query string', () => {
    renderTimeline('/records?status=draft');

    expect(screen.getAllByTestId('record-card')).toHaveLength(1);
    expect(screen.getByRole('heading', { name: '초안 기록' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '초안' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('RecordDetailPage', () => {
  it('renders the matching record body and related-record links', () => {
    render(
      <MemoryRouter initialEntries={['/records/first-contact']}>
        <Routes>
          <Route path="records/:recordId" element={<RecordDetailPage records={records} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: '첫 조우' })).toBeInTheDocument();
    expect(screen.getByTestId('record-content-display')).toBeVisible();
    expect(screen.getByText('정체불명의 의사와 중상 환자.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '두 번째 귀환' })).toHaveAttribute(
      'href',
      '/records/second-return',
    );
  });

  it('offers a return link when the record id is unknown', () => {
    render(
      <MemoryRouter initialEntries={['/records/missing']}>
        <Routes>
          <Route path="records/:recordId" element={<RecordDetailPage records={records} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.getByText('기록을 찾을 수 없습니다')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '기록철로 돌아가기' })).toHaveAttribute(
      'href',
      '/records',
    );
  });

  it('opens a sourced scene reconstruction for cinematic records only', async () => {
    const user = userEvent.setup();
    const { unmount } = render(
      <MemoryRouter initialEntries={['/records/first-contact']}>
        <Routes>
          <Route path="records/:recordId" element={<RecordDetailPage records={records} />} />
        </Routes>
      </MemoryRouter>,
    );

    const openButton = screen.getByRole('button', { name: '장면 재구성 열기' });
    await user.click(openButton);

    const dialog = screen.getByRole('dialog', { name: '첫 조우 장면 재구성' });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText('정체불명의 의사와 중상 환자.')).toBeVisible();

    unmount();
    render(
      <MemoryRouter initialEntries={['/records/second-return']}>
        <Routes>
          <Route path="records/:recordId" element={<RecordDetailPage records={records} />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: '장면 재구성 열기' })).not.toBeInTheDocument();
  });

  it('presents a long record as one continuous prose reading view', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/records/first-contact']}>
        <Routes>
          <Route path="records/:recordId" element={<RecordDetailPage records={actualRecords} />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: '장면 재구성 열기' }));
    const dialog = screen.getByRole('dialog', { name: '첫 조우 장면 재구성' });
    const prose = dialog.querySelector('.cinematic-scene__text--prose');

    expect(prose?.textContent).toContain('격리선 밖의 의사');
    expect(prose?.textContent).toContain('격리문이 닫히기 직전');
    expect(prose?.textContent).toContain('그 판단을 의심할 힘이 남아 있지 않았다');
    expect(within(dialog).queryByLabelText('현재 장면')).not.toBeInTheDocument();
  });

  it.each([
    {
      stage: 3,
      scenes: [
        '명령이 통하지 않는 지휘관과 의료 지원 인력.',
        '“의료진은 철수하십시오.”',
        '“환자가 아직 안 나왔는데 내가 어떻게 가.”',
        '“나는 환자가 아닙니다.”',
        '“그건 내가 정해요.”',
      ],
    },
    {
      stage: 7,
      scenes: [
        '서로에게 반드시 돌아오기로 한 사이.',
        '“이번에는 돌아와요.”',
        '“전부 데리고 돌아오겠습니다.”',
        '“당신도 포함해서.”',
        '“……예. 나도 포함해서.”',
      ],
    },
  ])('keeps actual stage $stage scenes non-empty and in source order', async ({ stage, scenes }) => {
    const user = userEvent.setup();
    const record = actualRecords.find((item) => item.stage === stage);
    expect(record).toBeDefined();

    render(
      <MemoryRouter initialEntries={[`/records/${record!.id}`]}>
        <Routes>
          <Route path="records/:recordId" element={<RecordDetailPage records={actualRecords} />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: '장면 재구성 열기' }));
    const dialog = screen.getByRole('dialog', { name: `${record!.title} 장면 재구성` });
    expect(within(dialog).getByText(`1 / ${scenes.length}`)).toBeVisible();

    for (const [index, expectedText] of scenes.entries()) {
      const sceneText = dialog.querySelector('.cinematic-scene__text');
      expect(sceneText?.textContent?.trim()).toBe(expectedText);
      expect(sceneText?.textContent?.trim()).not.toBe('');

      if (index < scenes.length - 1) {
        await user.click(within(dialog).getByRole('button', { name: '다음 장면' }));
      }
    }
  });

  it('closes and resets the cinematic modal when the route record changes', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/records/first-contact']}>
        <RecordRouteControls />
        <Routes>
          <Route path="records/:recordId" element={<RecordDetailPage records={records} />} />
        </Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole('button', { name: '장면 재구성 열기' }));
    expect(screen.getByRole('dialog', { name: '첫 조우 장면 재구성' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '비시네마틱 기록으로 이동' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '시네마틱 기록으로 이동' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '장면 재구성 열기' })).toBeVisible();
  });
});

describe('HomePage', () => {
  it('introduces the pair with existing character art and a route into the records', () => {
    render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );

    expect(screen.getByRole('heading', { name: '천무' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /천령/ })).toHaveAttribute(
      'src',
      '/images/Cheonryeong_LD.png',
    );
    expect(screen.getByRole('img', { name: /무영/ })).toHaveAttribute(
      'src',
      '/images/Muyeong_LD.png',
    );
    expect(screen.getByRole('link', { name: '기록 열람하기' })).toHaveAttribute(
      'href',
      '/records',
    );
  });
});
