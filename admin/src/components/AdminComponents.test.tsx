import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AdminNotice } from './AdminNotice';
import { AdminPageHeader } from './AdminPageHeader';
import { AdminSection } from './AdminSection';
import { AdminStatusBadge } from './AdminStatusBadge';

describe('admin presentational components', () => {
  afterEach(cleanup);

  it('gives every page a shared editorial heading hierarchy and optional action', () => {
    render(<AdminPageHeader eyebrow="운영 기록" title="오늘" description="오늘의 생성과 예산 흐름을 살핍니다." action={<button type="button">새 초안</button>} />);

    expect(screen.getByText('운영 기록')).toHaveClass('admin-page-header__eyebrow');
    expect(screen.getByRole('heading', { level: 1, name: '오늘' })).toBeInTheDocument();
    expect(screen.getByText('오늘의 생성과 예산 흐름을 살핍니다.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '새 초안' })).toBeInTheDocument();
  });

  it('communicates status with text and an explicit status prefix', () => {
    render(<AdminStatusBadge tone="green">통과</AdminStatusBadge>);
    expect(screen.getByText('통과')).toHaveAccessibleName('상태: 통과');
  });

  it('uses live regions for saved and error notices', () => {
    const { rerender } = render(<AdminNotice tone="success">설정을 저장했습니다.</AdminNotice>);
    expect(screen.getByRole('status')).toHaveTextContent('설정을 저장했습니다.');
    rerender(<AdminNotice tone="danger">설정을 불러오지 못했습니다.</AdminNotice>);
    expect(screen.getByRole('alert')).toHaveTextContent('설정을 불러오지 못했습니다.');
  });

  it('labels a reusable section with its visible heading', () => {
    render(<AdminSection title="최근 실패" description="운영 확인이 필요한 기록입니다."><p>실패 없음</p></AdminSection>);
    expect(screen.getByRole('region', { name: '최근 실패' })).toContainElement(screen.getByText('실패 없음'));
  });
});
