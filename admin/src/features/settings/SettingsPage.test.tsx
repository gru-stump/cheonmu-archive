import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ModelOption, NarrativeApi, NarrativeSettings } from '../../api/narrativeApi';
import { SettingsPage } from './SettingsPage';

const gptMini: ModelOption = {
  id: 'gpt-5-mini', label: 'GPT-5 mini', description: '비용과 속도의 균형이 좋은 권장 모델',
  quality: 'standard', speed: 'fast', cost: 'low', recommended: true, availability: 'available',
  maxInputTokens: 4000, maxOutputTokens: 4000, maxRevisionOutputTokens: 2000,
  inputPriceMicrosPerMillion: 250000, outputPriceMicrosPerMillion: 2000000,
  pricingVerifiedAt: '2026-08-16',
};
const claudeHaiku: ModelOption = {
  id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5', description: '빠른 짧은 대화용 모델',
  quality: 'standard', speed: 'fast', cost: 'low', recommended: true, availability: 'available',
  maxInputTokens: 4000, maxOutputTokens: 4000, maxRevisionOutputTokens: 2000,
  inputPriceMicrosPerMillion: 1000000, outputPriceMicrosPerMillion: 5000000,
  pricingVerifiedAt: '2026-08-16',
};

const settings: NarrativeSettings = {
  manualGenerationEnabled: true,
  scheduleAutomationEnabled: false,
  pricingValidDays: 30,
  providers: [
    { providerKey: 'openai', enabled: true, modelKey: 'gpt-5-mini', maxInputTokens: 4000, maxOutputTokens: 4000, maxRevisionOutputTokens: 2000, inputPriceMicrosPerMillion: 250000, outputPriceMicrosPerMillion: 2000000, pricingVerifiedAt: '2026-08-16' },
    { providerKey: 'anthropic', enabled: false, modelKey: 'claude-haiku-4-5-20251001', maxInputTokens: 4000, maxOutputTokens: 4000, maxRevisionOutputTokens: 2000, inputPriceMicrosPerMillion: 1000000, outputPriceMicrosPerMillion: 5000000, pricingVerifiedAt: '2026-08-16' },
  ],
  budget: { monthlyLimitMicros: 7_246_377, dailyLimitMicros: 724_638, spentMicros: 1_000_000, reservedMicros: 250_000, manualCallLimit: 3, warningThresholdPercent: 80, riskThresholdPercent: 95, krwPerUsd: 1380 },
  secrets: { openai: false, anthropic: true, github: false },
};

function api(overrides: Partial<NarrativeApi> = {}) {
  return {
    getSettings: vi.fn().mockResolvedValue(structuredClone(settings)),
    saveSettings: vi.fn().mockResolvedValue({ saved: true }),
    saveSecret: vi.fn().mockResolvedValue({ configured: true }),
    deleteSecret: vi.fn().mockResolvedValue({ configured: false, generationPaused: true }),
    listModels: vi.fn(async (providerKey: 'openai' | 'anthropic') => ({
      providerKey, configured: settings.secrets[providerKey], live: true,
      models: providerKey === 'openai' ? [gptMini] : [claudeHaiku],
    })),
    ...overrides,
  } as unknown as NarrativeApi;
}

describe('SettingsPage simple owner experience', () => {
  it('shows only understandable essentials until advanced settings are opened', async () => {
    render(<SettingsPage api={api()} />);

    expect(await screen.findByRole('heading', { name: '설정' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'OpenAI에서 사용할 모델' })).toHaveValue('gpt-5-mini');
    expect(screen.getByText('비용과 속도의 균형이 좋은 권장 모델')).toBeInTheDocument();
    expect(screen.getByLabelText('한 달 예산')).toHaveValue('10,000');
    expect(screen.getByLabelText('하루 예산')).toHaveValue('1,000');
    expect(screen.getByRole('button', { name: '5천원' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1만원' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '3만원' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '직접 이야기 만들기 허용' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '정해진 일정에 자동 만들기 허용' })).not.toBeChecked();
    expect(screen.queryByLabelText('OpenAI 입력 단가')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('고급 설정'));
    expect(screen.getByLabelText('OpenAI 입력 단가')).toHaveValue(0.25);
    expect(screen.getByText(/AI가 읽는 글 100만 토큰/)).toBeInTheDocument();
    expect(screen.getByLabelText('단가 확인 유효 기간')).toHaveValue(30);
  });

  it('applies catalog prices automatically and saves comma-formatted won as exact internal limits', async () => {
    const client = api();
    const user = userEvent.setup();
    render(<SettingsPage api={client} />);

    await screen.findByRole('combobox', { name: 'OpenAI에서 사용할 모델' });
    await user.click(screen.getByRole('button', { name: '1만원' }));
    await user.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => expect(client.saveSettings).toHaveBeenCalledTimes(1));
    expect(vi.mocked(client.saveSettings).mock.calls[0][0]).toMatchObject({
      activeProviderKey: 'openai',
      monthlyLimitMicros: 7_246_377,
      dailyLimitMicros: 724_638,
      providers: [expect.objectContaining({
        providerKey: 'openai', modelKey: 'gpt-5-mini', maxInputTokens: 4000, maxOutputTokens: 4000,
        inputPriceMicrosPerMillion: 250000, outputPriceMicrosPerMillion: 2000000, pricingVerifiedAt: '2026-08-16',
      })],
    });
    expect(screen.getByText(/대략 805회/)).toBeInTheDocument();
  });

  it('normalizes a legacy saved GPT-5 mini limit even when the owner keeps the same selected model', async () => {
    const legacy = structuredClone(settings);
    legacy.providers[0] = { ...legacy.providers[0], maxInputTokens: 8192, maxOutputTokens: 2048, maxRevisionOutputTokens: 512 };
    const client = api({ getSettings: vi.fn().mockResolvedValue(legacy) });
    render(<SettingsPage api={client} />);

    await screen.findByRole('combobox', { name: 'OpenAI에서 사용할 모델' });
    await userEvent.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => expect(client.saveSettings).toHaveBeenCalled());
    expect(vi.mocked(client.saveSettings).mock.calls[0][0].providers).toContainEqual(expect.objectContaining({
      providerKey: 'openai', modelKey: 'gpt-5-mini', maxInputTokens: 4000, maxOutputTokens: 4000, maxRevisionOutputTokens: 2000,
    }));
  });

  it('preserves deliberate advanced values that are not the known legacy GPT-5 mini limits', async () => {
    const customized = structuredClone(settings);
    customized.providers[0] = { ...customized.providers[0], maxInputTokens: 3500, inputPriceMicrosPerMillion: 300000 };
    const client = api({ getSettings: vi.fn().mockResolvedValue(customized) });
    render(<SettingsPage api={client} />);

    await screen.findByRole('combobox', { name: 'OpenAI에서 사용할 모델' });
    await userEvent.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => expect(client.saveSettings).toHaveBeenCalled());
    expect(vi.mocked(client.saveSettings).mock.calls[0][0].providers).toContainEqual(expect.objectContaining({
      providerKey: 'openai', maxInputTokens: 3500, inputPriceMicrosPerMillion: 300000,
    }));
  });

  it('blocks negative or malformed won before a settings request', async () => {
    const client = api();
    const user = userEvent.setup();
    render(<SettingsPage api={client} />);
    const monthly = await screen.findByLabelText('한 달 예산');

    await user.clear(monthly);
    await user.type(monthly, '-1');
    await user.click(screen.getByRole('button', { name: '설정 저장' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('예산은 0원 이상의 숫자로 입력해 주세요.');
    expect(client.saveSettings).not.toHaveBeenCalled();
  });

  it('never prefills a key and marks it connected only after a successful write', async () => {
    const client = api();
    const user = userEvent.setup();
    render(<SettingsPage api={client} />);
    const openai = await screen.findByRole('group', { name: 'OpenAI' });
    const secret = within(openai).getByLabelText('OpenAI API 키');

    expect(secret).toHaveValue('');
    expect(within(openai).getByText('연결되지 않음')).toBeInTheDocument();
    await user.type(secret, 'entered-only-in-this-test');
    await user.click(within(openai).getByRole('button', { name: '키 저장' }));

    await waitFor(() => expect(client.saveSecret).toHaveBeenCalledWith({ kind: 'openai', value: 'entered-only-in-this-test' }));
    expect(secret).toHaveValue('');
    expect(within(openai).getByText('연결됨')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('entered-only-in-this-test')).not.toBeInTheDocument();
  });

  it('confirms key deletion, disconnects the provider, and visibly pauses both generation switches', async () => {
    const client = api();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    render(<SettingsPage api={client} />);
    const anthropic = await screen.findByRole('group', { name: 'Anthropic' });

    await user.click(within(anthropic).getByRole('button', { name: 'API 키 삭제' }));

    await waitFor(() => expect(client.deleteSecret).toHaveBeenCalledWith('anthropic'));
    expect(confirm).toHaveBeenCalled();
    expect(within(anthropic).getByText('연결되지 않음')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '직접 이야기 만들기 허용' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '정해진 일정에 자동 만들기 허용' })).not.toBeChecked();
  });

  it('preserves visible connection state when key deletion fails', async () => {
    const client = api({ deleteSecret: vi.fn().mockRejectedValue(new Error('safe failure')) });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<SettingsPage api={client} />);
    const anthropic = await screen.findByRole('group', { name: 'Anthropic' });

    await userEvent.click(within(anthropic).getByRole('button', { name: 'API 키 삭제' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('API 키를 삭제하지 못했습니다.');
    expect(within(anthropic).getByText('연결됨')).toBeInTheDocument();
  });

  it('does not send untouched synthetic provider rows during a budget-only save', async () => {
    const client = api({ getSettings: vi.fn().mockResolvedValue({ ...structuredClone(settings), providers: [] }) });
    render(<SettingsPage api={client} />);
    await screen.findByRole('combobox', { name: 'OpenAI에서 사용할 모델' });

    await userEvent.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => expect(client.saveSettings).toHaveBeenCalled());
    expect(vi.mocked(client.saveSettings).mock.calls[0][0].providers).toEqual([]);
  });

  it('disables every mutation in read-only preview', async () => {
    const { container } = render(<SettingsPage api={api()} readOnly />);
    await screen.findByRole('heading', { name: '설정' });
    for (const control of container.querySelectorAll('input, select, textarea, button')) expect(control).toBeDisabled();
  });

  it('retries the real settings request after an initial error', async () => {
    const client = api({ getSettings: vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(structuredClone(settings)) });
    render(<SettingsPage api={client} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('설정을 불러오지 못했습니다.');
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByLabelText('한 달 예산')).toHaveValue('10,000');
  });
});
