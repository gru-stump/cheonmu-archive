import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';
import { RouteLoadingFallback } from './router';

afterEach(cleanup);

describe('AppShell', () => {
  it('offers the three primary archive destinations', () => {
    render(<MemoryRouter><AppShell /></MemoryRouter>);
    expect(screen.getByRole('link', { name: '\uCC9C\uBB34' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '\uAE30\uB85D\uCCA0' })).toHaveAttribute('href', '/records');
    expect(screen.getByRole('link', { name: '\uC544\uCE74\uC774\uBE0C' })).toHaveAttribute('href', '/archive');
  });
});

describe('RouteLoadingFallback', () => {
  it('announces that an archive route is loading', () => {
    render(<RouteLoadingFallback />);

    expect(screen.getByRole('status')).toHaveTextContent('기록을 불러오는 중입니다.');
  });
});
