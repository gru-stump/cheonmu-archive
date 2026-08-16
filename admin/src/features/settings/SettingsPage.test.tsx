import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { NarrativeApi } from '../../api/narrativeApi';
import { SettingsPage } from './SettingsPage';

function api() {
  return {
    getSettings: vi.fn().mockResolvedValue({
      manualGenerationEnabled: true,
      scheduleAutomationEnabled: false,
      pricingValidDays: 30,
      providers: [
        { providerKey: 'openai', enabled: true, modelKey: 'gpt-test', maxInputTokens: 4096, maxOutputTokens: 1024, maxRevisionOutputTokens: 256, inputPriceMicrosPerMillion: 1_250_000, outputPriceMicrosPerMillion: 5_000_000, pricingVerifiedAt: '2026-08-10' },
        { providerKey: 'anthropic', enabled: false, modelKey: 'claude-test', maxInputTokens: 4096, maxOutputTokens: 1024, maxRevisionOutputTokens: 256, inputPriceMicrosPerMillion: 2_000_000, outputPriceMicrosPerMillion: 6_000_000, pricingVerifiedAt: '2026-08-10' },
      ],
      budget: { monthlyLimitMicros: 20_000_000, dailyLimitMicros: 2_000_000, spentMicros: 1_000_000, reservedMicros: 250_000, manualCallLimit: 3, warningThresholdPercent: 80, riskThresholdPercent: 95, krwPerUsd: 1380.5 },
      secrets: { openai: false, anthropic: true, github: false },
    }),
    saveSettings: vi.fn().mockResolvedValue({ saved: true }),
    saveSecret: vi.fn().mockResolvedValue({ configured: true }),
  } as unknown as NarrativeApi;
}

function apiWithProviders(providers: Awaited<ReturnType<NarrativeApi['getSettings']>>['providers']) {
  const client = api();
  client.getSettings = vi.fn().mockResolvedValue({ ...(awaitedSettings as object), providers });
  return client;
}

const awaitedSettings = {
  manualGenerationEnabled: false,
  scheduleAutomationEnabled: false,
  pricingValidDays: 30,
  providers: [],
  budget: { monthlyLimitMicros: 20_000_000, dailyLimitMicros: 2_000_000, spentMicros: 0, reservedMicros: 0, manualCallLimit: 3, warningThresholdPercent: 80, riskThresholdPercent: 95, krwPerUsd: 1380.5 },
  secrets: { openai: false, anthropic: false, github: false },
};

describe('SettingsPage', () => {
  it.each([
    ['zero rows', [], []],
    ['one OpenAI row', [{ providerKey: 'openai', enabled: false, modelKey: 'gpt-existing', maxInputTokens: 4096, maxOutputTokens: 1024, maxRevisionOutputTokens: 256, inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0, pricingVerifiedAt: '' }], ['openai']],
  ] as const)('omits untouched synthetic provider drafts from a budget-only save with %s', async (_label, providers, expectedKeys) => {
    const client = apiWithProviders([...providers]);
    const user = userEvent.setup();
    render(<SettingsPage api={client} />);

    const budget = await screen.findByLabelText('월간 예산 USD');
    await user.clear(budget);
    await user.type(budget, '25');
    await user.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => expect(client.saveSettings).toHaveBeenCalled());
    expect(vi.mocked(client.saveSettings).mock.calls[0][0].providers.map((provider) => provider.providerKey)).toEqual(expectedKeys);
  });

  it('keeps a synthetic provider explicitly touched after its field is returned to the default value', async () => {
    const client = apiWithProviders([]);
    const user = userEvent.setup();
    render(<SettingsPage api={client} />);

    const anthropic = await screen.findByRole('group', { name: 'Anthropic' });
    const model = within(anthropic).getByLabelText('모델');
    await user.type(model, 'temporary-model');
    await user.clear(model);
    await user.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => expect(client.saveSettings).toHaveBeenCalled());
    expect(vi.mocked(client.saveSettings).mock.calls[0][0].providers.map((provider) => provider.providerKey)).toEqual(['anthropic']);
  });

  it('recalculates the exact synthetic provider set after settings are refreshed', async () => {
    const emptyClient = apiWithProviders([]);
    const refreshedClient = apiWithProviders([{ providerKey: 'anthropic', enabled: false, modelKey: 'claude-existing', maxInputTokens: 4096, maxOutputTokens: 1024, maxRevisionOutputTokens: 256, inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0, pricingVerifiedAt: '' }]);
    const user = userEvent.setup();
    const { rerender } = render(<SettingsPage api={emptyClient} />);

    await screen.findByRole('group', { name: 'OpenAI' });
    rerender(<SettingsPage api={refreshedClient} />);
    await screen.findByDisplayValue('claude-existing');
    await user.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => expect(refreshedClient.saveSettings).toHaveBeenCalled());
    expect(vi.mocked(refreshedClient.saveSettings).mock.calls[0][0].providers.map((provider) => provider.providerKey)).toEqual(['anthropic']);
  });
  it.each([
    ['zero provider rows', []],
    ['only an OpenAI row', [{ providerKey: 'openai', enabled: false, modelKey: 'gpt-existing', maxInputTokens: 4096, maxOutputTokens: 1024, maxRevisionOutputTokens: 256, inputPriceMicrosPerMillion: 0, outputPriceMicrosPerMillion: 0, pricingVerifiedAt: '' }]],
  ] as const)('renders editable OpenAI and Anthropic onboarding cards with %s', async (_label, providers) => {
    render(<SettingsPage api={apiWithProviders([...providers])} />);

    const openai = await screen.findByRole('group', { name: 'OpenAI' });
    const anthropic = screen.getByRole('group', { name: 'Anthropic' });
    expect(within(openai).getByLabelText('모델')).toBeEnabled();
    expect(within(anthropic).getByLabelText('모델')).toBeEnabled();
  });
  it('shows one active provider, per-million USD prices, verified date, token caps, and all budget controls', async () => {
    render(<SettingsPage api={api()} />);

    expect(await screen.findByRole('heading', { name: '설정' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'OpenAI 활성 제공자' })).toBeChecked();
    expect(screen.getByLabelText('OpenAI 입력 단가 USD / 1M')).toHaveValue(1.25);
    expect(screen.getByLabelText('OpenAI 단가 확인일')).toHaveValue('2026-08-10');
    expect(screen.getByLabelText('OpenAI 최대 출력 토큰')).toHaveValue(1024);
    expect(screen.getByLabelText('월간 예산 USD')).toHaveValue(20);
    expect(screen.getByLabelText('일일 예산 USD')).toHaveValue(2);
    expect(screen.getByLabelText('일일 수동 생성 횟수')).toHaveValue(3);
    expect(screen.getByLabelText('주의 기준 %')).toHaveValue(80);
    expect(screen.getByLabelText('위험 기준 %')).toHaveValue(95);
    expect(screen.getByLabelText('참고 환율 KRW / USD')).toHaveValue(1380.5);
  });

  it('keeps provider selection independent while saving separate manual and schedule policies', async () => {
    const client = api();
    const user = userEvent.setup();
    render(<SettingsPage api={client} />);

    const manual = await screen.findByRole('checkbox', { name: '수동 생성 허용' });
    const schedule = screen.getByRole('checkbox', { name: '자동 일정 허용' });
    const provider = screen.getByRole('radio', { name: 'OpenAI 활성 제공자' });
    expect(manual).toBeChecked();
    expect(schedule).not.toBeChecked();
    expect(provider).toBeChecked();
    expect(provider).toBeEnabled();

    await user.click(manual);
    expect(provider).toBeChecked();
    await user.click(screen.getByRole('button', { name: '설정 저장' }));

    await waitFor(() => expect(client.saveSettings).toHaveBeenCalled());
    expect(vi.mocked(client.saveSettings).mock.calls[0][0]).toMatchObject({
      manualGenerationEnabled: false,
      scheduleAutomationEnabled: false,
      activeProviderKey: 'openai',
    });
  });

  it('never prefills secrets, clears them after save, and renders only connection state', async () => {
    const client = api();
    const user = userEvent.setup();
    render(<SettingsPage api={client} />);

    const secret = await screen.findByLabelText('OpenAI 비밀 키');
    expect(secret).toHaveValue('');
    expect(screen.getByText('OpenAI: 미연결')).toBeInTheDocument();
    expect(screen.getByText('Anthropic: 연결됨')).toBeInTheDocument();
    await user.type(secret, 'entered-only-in-this-test');
    await user.click(screen.getByRole('button', { name: 'OpenAI 비밀 저장' }));

    await waitFor(() => expect(client.saveSecret).toHaveBeenCalledWith({ kind: 'openai', value: 'entered-only-in-this-test' }));
    expect(secret).toHaveValue('');
    expect(screen.getByText('OpenAI: 연결됨')).toBeInTheDocument();
    expect(screen.queryByDisplayValue('entered-only-in-this-test')).not.toBeInTheDocument();
  });

  it('disables every settings mutation control in read-only preview', async () => {
    const { container } = render(<SettingsPage api={api()} readOnly />);
    await screen.findByRole('heading', { name: '설정' });

    for (const control of container.querySelectorAll('input, select, textarea, button')) expect(control).toBeDisabled();
  });

  it('retries the real settings request and recovers from an initial route error', async () => {
    const client = api();
    client.getSettings = vi.fn().mockRejectedValueOnce(new Error('temporary failure')).mockResolvedValueOnce(await api().getSettings());
    render(<SettingsPage api={client} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('설정을 불러오지 못했습니다.');
    await userEvent.click(screen.getByRole('button', { name: '다시 시도' }));

    expect(await screen.findByLabelText('월간 예산 USD')).toHaveValue(20);
    expect(client.getSettings).toHaveBeenCalledTimes(2);
  });
});
