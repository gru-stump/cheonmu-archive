import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EditorApp, type EditorApi } from './EditorApp';

const firstContact = `---
id: first-contact
recordNumber: CM-01
title: "첫 조우"
stage: 1
status: confirmed
characters: [cheonryeong, muyeong]
tags: [첫조우, 치료]
related: []
quote: "그가 돌아왔다."
cinematic: true
---

첫 기록입니다.`;

const fakeEditorApi: EditorApi = {
  list: vi.fn(async () => [
    { id: 'first-contact', source: firstContact },
  ]),
  save: vi.fn(async ({ source }) => ({ id: 'first-contact', source })),
};

describe('EditorApp', () => {
  it('validates and saves an edited record', async () => {
    const user = userEvent.setup();

    render(<EditorApp api={fakeEditorApi} />);

    await user.click(await screen.findByRole('button', { name: '첫 조우 편집' }));
    const title = await screen.findByLabelText('제목');
    await user.clear(title);
    await user.type(title, '최초 접촉');

    expect(screen.getByRole('heading', { name: '최초 접촉' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: '저장' }));

    expect(fakeEditorApi.save).toHaveBeenCalledWith(expect.objectContaining({
      id: 'first-contact',
      kind: 'records',
    }));
  });

  it('renders field validation and changed-file reporting for an invalid record', async () => {
    const user = userEvent.setup();

    render(<EditorApp api={fakeEditorApi} />);

    await user.click(await screen.findByRole('button', { name: '첫 조우 편집' }));
    await user.clear(await screen.findByLabelText('제목'));

    expect(screen.getByText('Too small: expected string to have >=1 characters')).toBeVisible();
    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    expect(screen.getByText('src/content/records/first-contact.md')).toBeVisible();
    expect(screen.getByText('작업: 수정')).toBeVisible();
  });
});
