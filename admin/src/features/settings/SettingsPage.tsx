import { type FormEvent, useEffect, useState } from 'react';
import type { NarrativeApi, NarrativeSettings, ProviderSetting } from '../../api/narrativeApi';
import { AdminNotice } from '../../components/AdminNotice';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { AdminSection } from '../../components/AdminSection';

const providerName = (key: ProviderSetting['providerKey']) => key === 'openai' ? 'OpenAI' : key === 'anthropic' ? 'Anthropic' : '로컬 테스트';
const microsToUsd = (value: number) => value / 1_000_000;
const usdToMicros = (value: number) => Math.round(value * 1_000_000);
const emptyProvider = (providerKey: 'openai' | 'anthropic'): ProviderSetting => ({
  providerKey, enabled: false, modelKey: '', maxInputTokens: 4096, maxOutputTokens: 1024,
  maxRevisionOutputTokens: 256, inputPriceMicrosPerMillion: 0,
  outputPriceMicrosPerMillion: 0, pricingVerifiedAt: '',
});
const withProviderDrafts = (settings: NarrativeSettings): NarrativeSettings => ({
  ...settings,
  providers: [
    ...settings.providers,
    ...(['openai', 'anthropic'] as const)
      .filter((providerKey) => !settings.providers.some((provider) => provider.providerKey === providerKey))
      .map(emptyProvider),
  ],
});

export function SettingsPage({ api, readOnly = false }: { api: NarrativeApi; readOnly?: boolean }) {
  const [settings, setSettings] = useState<NarrativeSettings | null>(null);
  const [syntheticProviderKeys, setSyntheticProviderKeys] = useState<Set<ProviderSetting['providerKey']>>(new Set());
  const [touchedSyntheticProviderKeys, setTouchedSyntheticProviderKeys] = useState<Set<ProviderSetting['providerKey']>>(new Set());
  const [error, setError] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [secretInputs, setSecretInputs] = useState<Record<'openai' | 'anthropic' | 'github', string>>({ openai: '', anthropic: '', github: '' });
  const applySettings = (value: NarrativeSettings) => {
    const actualKeys = new Set(value.providers.map((provider) => provider.providerKey));
    setSyntheticProviderKeys(new Set((['openai', 'anthropic'] as const).filter((key) => !actualKeys.has(key))));
    setTouchedSyntheticProviderKeys(new Set());
    setSettings(withProviderDrafts(value));
  };
  const load = async () => { setError(false); try { applySettings(await api.getSettings()); } catch { setError(true); } };
  useEffect(() => { let active = true; void api.getSettings().then((value) => { if (active) applySettings(value); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api]);

  const touchSyntheticProvider = (key: ProviderSetting['providerKey']) => {
    if (syntheticProviderKeys.has(key)) setTouchedSyntheticProviderKeys((current) => new Set(current).add(key));
  };
  const updateProvider = (key: ProviderSetting['providerKey'], change: Partial<ProviderSetting>) => {
    touchSyntheticProvider(key);
    setSettings((current) => current ? { ...current, providers: current.providers.map((provider) => provider.providerKey === key ? { ...provider, ...change } : provider) } : current);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault(); if (!settings) return; setMessage(null);
    const activeProviderKey = settings.providers.find((provider) => provider.enabled)?.providerKey ?? null;
    try {
      await api.saveSettings({
        manualGenerationEnabled: settings.manualGenerationEnabled,
        scheduleAutomationEnabled: settings.scheduleAutomationEnabled,
        activeProviderKey, pricingValidDays: settings.pricingValidDays,
        providers: settings.providers
          .filter((provider) => !syntheticProviderKeys.has(provider.providerKey) || touchedSyntheticProviderKeys.has(provider.providerKey))
          .map(({ enabled: _enabled, ...provider }) => provider),
        monthlyLimitMicros: settings.budget.monthlyLimitMicros, dailyLimitMicros: settings.budget.dailyLimitMicros,
        manualCallLimit: settings.budget.manualCallLimit, warningThresholdPercent: settings.budget.warningThresholdPercent,
        riskThresholdPercent: settings.budget.riskThresholdPercent, krwPerUsd: settings.budget.krwPerUsd,
      });
      setMessage('설정을 저장했습니다.');
    } catch { setMessage('설정을 저장하지 못했습니다. 단가 확인일과 사용·예약 금액을 확인해 주세요.'); }
  };
  const saveSecret = async (event: FormEvent, kind: 'openai' | 'anthropic' | 'github') => {
    event.preventDefault(); if (!settings) return; setMessage(null);
    const value = secretInputs[kind];
    try {
      const result = await api.saveSecret({ kind, value });
      setSecretInputs((current) => ({ ...current, [kind]: '' }));
      setSettings({ ...settings, secrets: { ...settings.secrets, [kind]: result.configured } });
      setMessage('비밀 연결 상태를 저장했습니다.');
    } catch { setMessage('비밀을 저장하지 못했습니다.'); }
  };

  const header = <AdminPageHeader eyebrow="운영 기준" title="설정" description="수동 생성, 자동 일정, 제공자, 예산, 비밀 연결을 각각 관리합니다." />;
  if (error) return <section>{header}<AdminNotice tone="danger" action={<button type="button" onClick={() => void load()}>다시 시도</button>}>설정을 불러오지 못했습니다.</AdminNotice></section>;
  if (!settings) return <section>{header}<AdminNotice>설정을 불러오는 중입니다.</AdminNotice></section>;
  return <section>
    {header}
    <form onSubmit={save} className="settings-form">
      <fieldset><legend>생성 정책과 제공자</legend>
        <label className="control-target"><input type="checkbox" checked={settings.manualGenerationEnabled} disabled={readOnly} onChange={(event) => setSettings({ ...settings, manualGenerationEnabled: event.target.checked })} /> 수동 생성 허용</label>
        <label className="control-target"><input type="checkbox" checked={settings.scheduleAutomationEnabled} disabled={readOnly} onChange={(event) => setSettings({ ...settings, scheduleAutomationEnabled: event.target.checked })} /> 자동 일정 허용</label>
        <p>활성 제공자는 두 정책과 독립적으로 유지됩니다. 정책을 하나라도 켜려면 활성 제공자 하나가 필요합니다.</p>
        <label htmlFor="pricing-valid-days">단가 유효 기간(일)</label><input id="pricing-valid-days" type="number" min="1" max="365" value={settings.pricingValidDays} disabled={readOnly} onChange={(event) => setSettings({ ...settings, pricingValidDays: Number(event.target.value) })} />
        <div className="settings-grid">{settings.providers.map((provider) => { const label = providerName(provider.providerKey); return <fieldset key={provider.providerKey} className="settings-card"><legend>{label}</legend>
          <label className="control-target"><input type="radio" name="active-provider" aria-label={`${label} 활성 제공자`} checked={provider.enabled} disabled={readOnly} onChange={() => { touchSyntheticProvider(provider.providerKey); setSettings({ ...settings, providers: settings.providers.map((candidate) => ({ ...candidate, enabled: candidate.providerKey === provider.providerKey })) }); }} /> 활성 제공자</label>
          <label htmlFor={`${provider.providerKey}-model`}>모델</label><input id={`${provider.providerKey}-model`} value={provider.modelKey} disabled={readOnly} onChange={(event) => updateProvider(provider.providerKey, { modelKey: event.target.value })} />
          <label htmlFor={`${provider.providerKey}-input-price`}>{label} 입력 단가 USD / 1M</label><input id={`${provider.providerKey}-input-price`} type="number" min="0" step="0.000001" value={microsToUsd(provider.inputPriceMicrosPerMillion)} disabled={readOnly} onChange={(event) => updateProvider(provider.providerKey, { inputPriceMicrosPerMillion: usdToMicros(Number(event.target.value)) })} />
          <label htmlFor={`${provider.providerKey}-output-price`}>{label} 출력 단가 USD / 1M</label><input id={`${provider.providerKey}-output-price`} type="number" min="0" step="0.000001" value={microsToUsd(provider.outputPriceMicrosPerMillion)} disabled={readOnly} onChange={(event) => updateProvider(provider.providerKey, { outputPriceMicrosPerMillion: usdToMicros(Number(event.target.value)) })} />
          <label htmlFor={`${provider.providerKey}-verified`}>{label} 단가 확인일</label><input id={`${provider.providerKey}-verified`} type="date" value={provider.pricingVerifiedAt} disabled={readOnly} onChange={(event) => updateProvider(provider.providerKey, { pricingVerifiedAt: event.target.value })} />
          <label htmlFor={`${provider.providerKey}-max-input`}>{label} 최대 입력 토큰</label><input id={`${provider.providerKey}-max-input`} type="number" min="1" value={provider.maxInputTokens} disabled={readOnly} onChange={(event) => updateProvider(provider.providerKey, { maxInputTokens: Number(event.target.value) })} />
          <label htmlFor={`${provider.providerKey}-max-output`}>{label} 최대 출력 토큰</label><input id={`${provider.providerKey}-max-output`} type="number" min="1" value={provider.maxOutputTokens} disabled={readOnly} onChange={(event) => updateProvider(provider.providerKey, { maxOutputTokens: Number(event.target.value) })} />
          <label htmlFor={`${provider.providerKey}-max-revision`}>{label} 부분 수정 최대 토큰</label><input id={`${provider.providerKey}-max-revision`} type="number" min="1" value={provider.maxRevisionOutputTokens} disabled={readOnly} onChange={(event) => updateProvider(provider.providerKey, { maxRevisionOutputTokens: Number(event.target.value) })} />
        </fieldset>; })}</div>
      </fieldset>
      <fieldset><legend>예산</legend>
        <p>현재 사용: {microsToUsd(settings.budget.spentMicros).toLocaleString('en-US')} USD · 예약: {microsToUsd(settings.budget.reservedMicros).toLocaleString('en-US')} USD</p>
        <div className="budget-fields">
          <div className="settings-field"><label htmlFor="monthly-budget">월간 예산 USD</label><input id="monthly-budget" type="number" min="0" step="0.000001" value={microsToUsd(settings.budget.monthlyLimitMicros)} disabled={readOnly} onChange={(event) => setSettings({ ...settings, budget: { ...settings.budget, monthlyLimitMicros: usdToMicros(Number(event.target.value)) } })} /></div>
          <div className="settings-field"><label htmlFor="daily-budget">일일 예산 USD</label><input id="daily-budget" type="number" min="0" step="0.000001" value={microsToUsd(settings.budget.dailyLimitMicros)} disabled={readOnly} onChange={(event) => setSettings({ ...settings, budget: { ...settings.budget, dailyLimitMicros: usdToMicros(Number(event.target.value)) } })} /></div>
          <div className="settings-field"><label htmlFor="manual-limit">일일 수동 생성 횟수</label><input id="manual-limit" type="number" min="0" value={settings.budget.manualCallLimit} disabled={readOnly} onChange={(event) => setSettings({ ...settings, budget: { ...settings.budget, manualCallLimit: Number(event.target.value) } })} /></div>
          <div className="settings-field"><label htmlFor="warning-threshold">주의 기준 %</label><input id="warning-threshold" type="number" min="1" max="99" value={settings.budget.warningThresholdPercent} disabled={readOnly} onChange={(event) => setSettings({ ...settings, budget: { ...settings.budget, warningThresholdPercent: Number(event.target.value) } })} /></div>
          <div className="settings-field"><label htmlFor="risk-threshold">위험 기준 %</label><input id="risk-threshold" type="number" min="2" max="100" value={settings.budget.riskThresholdPercent} disabled={readOnly} onChange={(event) => setSettings({ ...settings, budget: { ...settings.budget, riskThresholdPercent: Number(event.target.value) } })} /></div>
          <div className="settings-field"><label htmlFor="krw-rate">참고 환율 KRW / USD</label><input id="krw-rate" type="number" min="0.0001" step="0.0001" value={settings.budget.krwPerUsd} disabled={readOnly} onChange={(event) => setSettings({ ...settings, budget: { ...settings.budget, krwPerUsd: Number(event.target.value) } })} /></div>
        </div>
      </fieldset>
      <button type="submit" disabled={readOnly}>설정 저장</button>
    </form>
    <AdminSection title="비밀 연결" description="저장된 값은 다시 표시하지 않고 연결 상태만 확인합니다.">
      {(['openai', 'anthropic', 'github'] as const).map((kind) => { const label = kind === 'github' ? 'GitHub' : providerName(kind); return <form key={kind} onSubmit={(event) => void saveSecret(event, kind)} className="secret-form">
        <p>{label}: {settings.secrets[kind] ? '연결됨' : '미연결'}</p>
        <label htmlFor={`${kind}-secret`}>{label} 비밀 키</label>
        <input id={`${kind}-secret`} type="password" autoComplete="new-password" value={secretInputs[kind]} disabled={readOnly} onChange={(event) => setSecretInputs({ ...secretInputs, [kind]: event.target.value })} required />
        <button type="submit" disabled={readOnly}>{label} 비밀 저장</button>
      </form>; })}
    </AdminSection>
    {message && <AdminNotice tone={message.includes('못했습니다') ? 'danger' : 'success'}>{message}</AdminNotice>}
  </section>;
}
