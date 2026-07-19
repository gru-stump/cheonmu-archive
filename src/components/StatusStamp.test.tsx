import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StatusStamp } from './StatusStamp';

describe('StatusStamp', () => {
  it.each([
    ['confirmed', '확정 기록'],
    ['draft', '초안 기록'],
  ] as const)('labels %s records', (status, label) => {
    render(<StatusStamp status={status} />);
    expect(screen.getByText(label)).toBeVisible();
  });
});
