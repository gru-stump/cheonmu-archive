import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';
import { RouteLoadingFallback } from './router';

afterEach(cleanup);

describe('AppShell', () => {
  it('offers the four primary archive destinations in document order', () => {
    render(<MemoryRouter><AppShell /></MemoryRouter>);

    expect(screen.getAllByRole('link').map((link) => link.textContent))
      .toEqual(['천무', '기록철', '세계관', '아카이브']);
    expect(screen.getByRole('link', { name: '세계관' })).toHaveAttribute('href', '/world');
  });
});

describe('RouteLoadingFallback', () => {
  it('announces that an archive route is loading', () => {
    render(<RouteLoadingFallback />);

    expect(screen.getByRole('status')).toHaveTextContent('기록을 불러오는 중입니다.');
  });
});
