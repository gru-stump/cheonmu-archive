import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { AppShell } from './AppShell';

describe('AppShell', () => {
  it('offers the three primary archive destinations', () => {
    render(<MemoryRouter><AppShell /></MemoryRouter>);
    expect(screen.getByRole('link', { name: '\uF9E3\uC495\u0422' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: '\u6E72\uACD5\uC909\uF9E3?' })).toHaveAttribute('href', '/records');
    expect(screen.getByRole('link', { name: '?\uAFA9\uBB45?\uB300\uD215' })).toHaveAttribute('href', '/archive');
  });
});
