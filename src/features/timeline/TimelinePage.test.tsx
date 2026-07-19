import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
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

afterEach(cleanup);

function LocationProbe() {
  return <output data-testid="location">{useLocation().search}</output>;
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
