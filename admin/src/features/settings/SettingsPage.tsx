import { type FormEvent, useEffect, useMemo, useState } from 'react';
import type { ModelOption, NarrativeApi, NarrativeSettings, ProviderSetting } from '../../api/narrativeApi';
import { AdminNotice } from '../../components/AdminNotice';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { formatKrw, krwToMicros, microsToKrw } from '../../lib/narrativeDisplay';

type ProviderKey = 'openai' | 'anthropic';
type SecretKind = ProviderKey | 'github';

const providerLabel: Record<SecretKind, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  github: 'GitHub',
};

const emptyProvider = (providerKey: ProviderKey): ProviderSetting => ({
  providerKey,
  enabled: false,
  modelKey: '',
  maxInputTokens: 4096,
  maxOutputTokens: 1024,
  maxRevisionOutputTokens: 256,
  inputPriceMicrosPerMillion: 0,
  outputPriceMicrosPerMillion: 0,
  pricingVerifiedAt: '',
});

function addProviderDrafts(settings: NarrativeSettings) {
  return {
    ...settings,
    providers: [
      ...settings.providers,
      ...(['openai', 'anthropic'] as const)
        .filter((key) => !settings.providers.some((provider) => provider.providerKey === key))
        .map(emptyProvider),
    ],
  };
}

function digits(value: string) {
  return value.replace(/[^0-9]/g, '');
}

function wonInput(value: number) {
  return Math.max(0, Math.round(value)).toLocaleString('ko-KR');
}

function parseWon(value: string) {
  if (!/^\d[\d,]*$/.test(value) || !Number.isFinite(Number(value.replaceAll(',', '')))) return null;
  return Number(value.replaceAll(',', ''));
}

export function SettingsPage({ api, readOnly = false }: { api: NarrativeApi; readOnly?: boolean }) {
  const [settings, setSettings] = useState<NarrativeSettings | null>(null);
  const [syntheticKeys, setSyntheticKeys] = useState<Set<ProviderSetting['providerKey']>>(new Set());
  const [touchedSyntheticKeys, setTouchedSyntheticKeys] = useState<Set<ProviderSetting['providerKey']>>(new Set());
  const [models, setModels] = useState<Record<ProviderKey, ModelOption[]>>({ openai: [], anthropic: [] });
  const [changedProviderKeys, setChangedProviderKeys] = useState<Set<ProviderSetting['providerKey']>>(new Set());
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [monthlyWon, setMonthlyWon] = useState('');
  const [dailyWon, setDailyWon] = useState('');
  const [secretInputs, setSecretInputs] = useState<Record<SecretKind, string>>({ openai: '', anthropic: '', github: '' });
  const [loadFailed, setLoadFailed] = useState(false);
  const [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);

  const applySettings = (value: NarrativeSettings) => {
    const realKeys = new Set(value.providers.map((provider) => provider.providerKey));
    setSyntheticKeys(new Set((['openai', 'anthropic'] as const).filter((key) => !realKeys.has(key))));
    setTouchedSyntheticKeys(new Set());
    setChangedProviderKeys(new Set());
    setMonthlyWon(wonInput(microsToKrw(value.budget.monthlyLimitMicros, value.budget.krwPerUsd)));
    setDailyWon(wonInput(microsToKrw(value.budget.dailyLimitMicros, value.budget.krwPerUsd)));
    setSettings(addProviderDrafts(value));
  };

  const load = async () => {
    setLoadFailed(false);
    setMessage(null);
    try {
      const value = await api.getSettings();
      applySettings(value);
      const results = await Promise.allSettled((['openai', 'anthropic'] as const).map((key) => api.listModels(key)));
      setModels({
        openai: results[0].status === 'fulfilled' ? results[0].value.models : [],
        anthropic: results[1].status === 'fulfilled' ? results[1].value.models : [],
      });
    } catch {
      setLoadFailed(true);
    }
  };

  useEffect(() => { void load(); }, [api]);

  const touchSynthetic = (key: ProviderSetting['providerKey']) => {
    if (syntheticKeys.has(key)) setTouchedSyntheticKeys((current) => new Set(current).add(key));
  };

  const updateProvider = (key: ProviderSetting['providerKey'], change: Partial<ProviderSetting>) => {
    touchSynthetic(key);
    setChangedProviderKeys((current) => new Set(current).add(key));
    setSettings((current) => current ? {
      ...current,
      providers: current.providers.map((provider) => provider.providerKey === key ? { ...provider, ...change } : provider),
    } : current);
  };

  const chooseModel = (key: ProviderKey, modelId: string) => {
    const model = models[key].find((candidate) => candidate.id === modelId);
    updateProvider(key, model ? {
      modelKey: model.id,
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      maxRevisionOutputTokens: model.maxRevisionOutputTokens,
      inputPriceMicrosPerMillion: model.inputPriceMicrosPerMillion,
      outputPriceMicrosPerMillion: model.outputPriceMicrosPerMillion,
      pricingVerifiedAt: model.pricingVerifiedAt,
    } : { modelKey: modelId });
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!settings) return;
    setMessage(null);
    const monthly = parseWon(monthlyWon);
    const daily = parseWon(dailyWon);
    if (monthly === null || daily === null || monthly < 0 || daily < 0) {
      setMessage({ tone: 'danger', text: '예산은 0원 이상의 숫자로 입력해 주세요.' });
      return;
    }
    if (daily > monthly) {
      setMessage({ tone: 'danger', text: '하루 예산은 한 달 예산보다 작거나 같아야 합니다.' });
      return;
    }
    const activeProviderKey = settings.providers.find((provider) => provider.enabled)?.providerKey ?? null;
    try {
      await api.saveSettings({
        manualGenerationEnabled: settings.manualGenerationEnabled,
        scheduleAutomationEnabled: settings.scheduleAutomationEnabled,
        activeProviderKey,
        pricingValidDays: settings.pricingValidDays,
        providers: settings.providers
          .filter((provider) => (provider.enabled || changedProviderKeys.has(provider.providerKey))
            && (!syntheticKeys.has(provider.providerKey) || touchedSyntheticKeys.has(provider.providerKey)))
          .map(({ enabled: _enabled, ...provider }) => provider),
        monthlyLimitMicros: krwToMicros(monthly, settings.budget.krwPerUsd),
        dailyLimitMicros: krwToMicros(daily, settings.budget.krwPerUsd),
        manualCallLimit: settings.budget.manualCallLimit,
        warningThresholdPercent: settings.budget.warningThresholdPercent,
        riskThresholdPercent: settings.budget.riskThresholdPercent,
        krwPerUsd: settings.budget.krwPerUsd,
      });
      setMessage({ tone: 'success', text: '설정을 저장했습니다.' });
    } catch {
      setMessage({ tone: 'danger', text: '설정을 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.' });
    }
  };

  const saveSecret = async (kind: SecretKind) => {
    if (!settings) return;
    try {
      const result = await api.saveSecret({ kind, value: secretInputs[kind] });
      setSecretInputs((current) => ({ ...current, [kind]: '' }));
      setSettings({ ...settings, secrets: { ...settings.secrets, [kind]: result.configured } });
      setMessage({ tone: 'success', text: `${providerLabel[kind]} 연결 정보를 저장했습니다.` });
    } catch {
      setMessage({ tone: 'danger', text: 'API 키를 저장하지 못했습니다.' });
    }
  };

  const deleteSecret = async (kind: SecretKind) => {
    if (!settings || !window.confirm(`${providerLabel[kind]} 연결 정보를 삭제할까요? 이야기 만들기는 자동으로 멈춥니다.`)) return;
    try {
      await api.deleteSecret(kind);
      setSettings({
        ...settings,
        manualGenerationEnabled: false,
        scheduleAutomationEnabled: false,
        secrets: { ...settings.secrets, [kind]: false },
        providers: settings.providers.map((provider) => kind !== 'github' && provider.providerKey === kind ? { ...provider, enabled: false } : provider),
      });
      setMessage({ tone: 'success', text: `${providerLabel[kind]} 연결을 삭제했습니다.` });
    } catch {
      setMessage({ tone: 'danger', text: 'API 키를 삭제하지 못했습니다.' });
    }
  };

  const estimatedRuns = useMemo(() => {
    if (!settings) return 0;
    const provider = settings.providers.find((candidate) => candidate.enabled);
    const monthly = parseWon(monthlyWon);
    if (!provider || monthly === null) return 0;
    const maximumCost = Math.ceil(provider.maxInputTokens * provider.inputPriceMicrosPerMillion / 1_000_000)
      + Math.ceil(provider.maxOutputTokens * provider.outputPriceMicrosPerMillion / 1_000_000);
    return maximumCost > 0 ? Math.floor(krwToMicros(monthly, settings.budget.krwPerUsd) / maximumCost) : 0;
  }, [monthlyWon, settings]);

  const header = <AdminPageHeader eyebrow="운영 설정" title="설정" description="AI 연결, 모델, 예산을 쉬운 표현으로 관리합니다." />;
  if (loadFailed) return <section>{header}<AdminNotice tone="danger" action={<button type="button" disabled={readOnly} onClick={() => void load()}>다시 시도</button>}>설정을 불러오지 못했습니다.</AdminNotice></section>;
  if (!settings) return <section>{header}<AdminNotice>설정을 불러오는 중입니다.</AdminNotice></section>;

  return <section>
    {header}
    <form onSubmit={save} className="settings-form simple-settings">
      <fieldset>
        <legend>AI와 모델</legend>
        <p className="settings-help">사용할 AI 회사를 하나 고르고, 목록에서 모델을 선택하세요. 단가와 토큰 값은 자동으로 채워집니다.</p>
        <div className="settings-grid">
          {(['openai', 'anthropic'] as const).map((key) => {
            const provider = settings.providers.find((candidate) => candidate.providerKey === key)!;
            const available = models[key];
            const current = available.find((candidate) => candidate.id === provider.modelKey);
            const options = available.some((candidate) => candidate.id === provider.modelKey) || !provider.modelKey
              ? available
              : [{ id: provider.modelKey, label: provider.modelKey, description: '현재 저장된 모델', quality: 'standard', speed: 'balanced', cost: 'medium', recommended: false, availability: 'unverified', maxInputTokens: provider.maxInputTokens, maxOutputTokens: provider.maxOutputTokens, maxRevisionOutputTokens: provider.maxRevisionOutputTokens, inputPriceMicrosPerMillion: provider.inputPriceMicrosPerMillion, outputPriceMicrosPerMillion: provider.outputPriceMicrosPerMillion, pricingVerifiedAt: provider.pricingVerifiedAt } satisfies ModelOption, ...available];
            return <fieldset key={key} className="settings-card" aria-label={providerLabel[key]}>
              <legend>{providerLabel[key]}</legend>
              <p className={settings.secrets[key] ? 'connection-state connection-state--on' : 'connection-state'}>{settings.secrets[key] ? '연결됨' : '연결되지 않음'}</p>
              <label className="control-target"><input type="radio" name="active-provider" aria-label={`${providerLabel[key]} 사용`} checked={provider.enabled} disabled={readOnly} onChange={() => { touchSynthetic(key); setSettings({ ...settings, providers: settings.providers.map((candidate) => ({ ...candidate, enabled: candidate.providerKey === key })) }); }} /> 이 AI 사용</label>
              <label htmlFor={`${key}-model`}>{providerLabel[key]}에서 사용할 모델</label>
              <select id={`${key}-model`} value={provider.modelKey} disabled={readOnly} onChange={(event) => chooseModel(key, event.target.value)}>
                {!options.length && <option value={provider.modelKey}>{provider.modelKey || '연결 후 모델을 불러옵니다'}</option>}
                {options.map((model) => <option key={model.id} value={model.id}>{model.label}{model.recommended ? ' (추천)' : ''}</option>)}
              </select>
              <p className="settings-help">{current?.description ?? '현재 저장된 모델을 사용합니다.'}</p>
              <div className="secret-form">
                <label htmlFor={`${key}-secret`}>{providerLabel[key]} API 키</label>
                <input id={`${key}-secret`} type="password" autoComplete="new-password" value={secretInputs[key]} disabled={readOnly} onChange={(event) => setSecretInputs({ ...secretInputs, [key]: event.target.value })} />
                <button type="button" disabled={readOnly || !secretInputs[key]} onClick={() => void saveSecret(key)}>키 저장</button>
                {settings.secrets[key] && <button type="button" className="button-danger" disabled={readOnly} onClick={() => void deleteSecret(key)}>API 키 삭제</button>}
              </div>
            </fieldset>;
          })}
        </div>
      </fieldset>

      <fieldset>
        <legend>예산</legend>
        <p className="settings-help">최대 사용 한도를 원화로 정합니다. 실제 결제는 선택한 AI 회사에서 이루어집니다.</p>
        <div className="budget-presets" aria-label="한 달 예산 빠른 선택">
          {[5_000, 10_000, 30_000].map((value) => <button key={value} type="button" disabled={readOnly} onClick={() => { setMonthlyWon(wonInput(value)); setDailyWon(wonInput(Math.round(value / 10))); }}>{value === 5_000 ? '5천원' : value === 10_000 ? '1만원' : '3만원'}</button>)}
        </div>
        <div className="budget-fields">
          <div className="settings-field"><label htmlFor="monthly-budget">한 달 예산</label><div className="won-input"><input id="monthly-budget" inputMode="numeric" value={monthlyWon} disabled={readOnly} onChange={(event) => setMonthlyWon(event.target.value.startsWith('-') ? event.target.value : digits(event.target.value) ? wonInput(Number(digits(event.target.value))) : '')} /><span>원</span></div></div>
          <div className="settings-field"><label htmlFor="daily-budget">하루 예산</label><div className="won-input"><input id="daily-budget" inputMode="numeric" value={dailyWon} disabled={readOnly} onChange={(event) => setDailyWon(event.target.value.startsWith('-') ? event.target.value : digits(event.target.value) ? wonInput(Number(digits(event.target.value))) : '')} /><span>원</span></div></div>
        </div>
        <p>현재 사용 {formatKrw(microsToKrw(settings.budget.spentMicros, settings.budget.krwPerUsd))} · 처리 중 {formatKrw(microsToKrw(settings.budget.reservedMicros, settings.budget.krwPerUsd))}</p>
        <p>현재 모델 기준 한 달에 대략 {estimatedRuns.toLocaleString('ko-KR')}회까지 만들 수 있습니다.</p>
      </fieldset>

      <fieldset>
        <legend>이야기 만들기</legend>
        <label className="control-target"><input type="checkbox" checked={settings.manualGenerationEnabled} disabled={readOnly} onChange={(event) => setSettings({ ...settings, manualGenerationEnabled: event.target.checked })} /> 직접 이야기 만들기 허용</label>
        <label className="control-target"><input type="checkbox" checked={settings.scheduleAutomationEnabled} disabled={readOnly} onChange={(event) => setSettings({ ...settings, scheduleAutomationEnabled: event.target.checked })} /> 정해진 일정에 자동 만들기 허용</label>
      </fieldset>

      <div className="advanced-settings">
        <button type="button" disabled={readOnly} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>고급 설정</button>
        {advancedOpen && <div className="advanced-settings__body">
        <p>입력 단가는 AI가 읽는 글 100만 토큰의 비용이고, 출력 단가는 AI가 쓰는 글 100만 토큰의 비용입니다.</p>
        <label htmlFor="pricing-valid-days">단가 확인 유효 기간</label><input id="pricing-valid-days" type="number" min="1" max="365" value={settings.pricingValidDays} disabled={readOnly} onChange={(event) => setSettings({ ...settings, pricingValidDays: Number(event.target.value) })} />
        {(['openai', 'anthropic'] as const).map((key) => { const provider = settings.providers.find((candidate) => candidate.providerKey === key)!; return <div key={key} className="advanced-provider">
          <h3>{providerLabel[key]}</h3>
          <label htmlFor={`${key}-input-price`}>{providerLabel[key]} 입력 단가</label><input id={`${key}-input-price`} type="number" min="0" step="0.000001" value={provider.inputPriceMicrosPerMillion / 1_000_000} disabled={readOnly} onChange={(event) => updateProvider(key, { inputPriceMicrosPerMillion: Math.round(Number(event.target.value) * 1_000_000) })} />
          <label htmlFor={`${key}-output-price`}>{providerLabel[key]} 출력 단가</label><input id={`${key}-output-price`} type="number" min="0" step="0.000001" value={provider.outputPriceMicrosPerMillion / 1_000_000} disabled={readOnly} onChange={(event) => updateProvider(key, { outputPriceMicrosPerMillion: Math.round(Number(event.target.value) * 1_000_000) })} />
        </div>; })}
        <label htmlFor="manual-limit">하루 직접 만들기 횟수</label><input id="manual-limit" type="number" min="0" value={settings.budget.manualCallLimit} disabled={readOnly} onChange={(event) => setSettings({ ...settings, budget: { ...settings.budget, manualCallLimit: Number(event.target.value) } })} />
        <label htmlFor="warning-threshold">예산 주의 알림 기준 (%)</label><input id="warning-threshold" type="number" min="1" max="99" value={settings.budget.warningThresholdPercent} disabled={readOnly} onChange={(event) => setSettings({ ...settings, budget: { ...settings.budget, warningThresholdPercent: Number(event.target.value) } })} />
        <label htmlFor="risk-threshold">자동 중단 기준 (%)</label><input id="risk-threshold" type="number" min="2" max="100" value={settings.budget.riskThresholdPercent} disabled={readOnly} onChange={(event) => setSettings({ ...settings, budget: { ...settings.budget, riskThresholdPercent: Number(event.target.value) } })} />
        <label htmlFor="krw-rate">계산용 환율 (1달러당 원)</label><input id="krw-rate" type="number" min="1" value={settings.budget.krwPerUsd} disabled={readOnly} onChange={(event) => setSettings({ ...settings, budget: { ...settings.budget, krwPerUsd: Number(event.target.value) } })} />
        </div>}
      </div>

      <button type="submit" disabled={readOnly}>설정 저장</button>
    </form>

    <fieldset className="settings-card publishing-secret" aria-label="GitHub">
      <legend>GitHub 게시 연결</legend>
      <p>{settings.secrets.github ? '연결됨' : '연결되지 않음'}</p>
      <div className="secret-form">
        <label htmlFor="github-secret">GitHub API 키</label>
        <input id="github-secret" type="password" autoComplete="new-password" value={secretInputs.github} disabled={readOnly} onChange={(event) => setSecretInputs({ ...secretInputs, github: event.target.value })} />
        <button type="button" disabled={readOnly || !secretInputs.github} onClick={() => void saveSecret('github')}>키 저장</button>
        {settings.secrets.github && <button type="button" className="button-danger" disabled={readOnly} onClick={() => void deleteSecret('github')}>API 키 삭제</button>}
      </div>
    </fieldset>

    {message && <AdminNotice tone={message.tone}>{message.text}</AdminNotice>}
  </section>;
}
