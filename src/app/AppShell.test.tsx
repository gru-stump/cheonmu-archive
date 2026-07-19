import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('offers the three primary archive destinations', () => {
    render(<MemoryRouter><AppShell /></MemoryRouter>);
    expect(screen.getByRole('link', { name: '\uCC9C\uBB34' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '\uAE30\uB85D\uCCA0' })).toHaveAttribute('href', '/records');
    expect(screen.getByRole('link', { name: '\uC544\uCE74\uC774\uBE0C' })).toHaveAttribute('href', '/archive');
  });
});
