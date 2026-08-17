import { useEffect, useRef, useState } from 'react';
import { NarrativeApiError, type AccessEstimate, type DashboardData, type NarrativeApi } from '../../api/narrativeApi';
import { AdminNotice } from '../../components/AdminNotice';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { AdminSection } from '../../components/AdminSection';
import { formatKrw, formatSeoulTimestamp, generationStatusCopy, microsToKrw } from '../../lib/narrativeDisplay';

const displayCost = (value: number, krwPerUsd: number) => formatKrw(microsToKrw(value, krwPerUsd));
const failureCopy: Record<string, string> = {
  provider_timeout: 'AI 응답이 늦어 작업이 중단됐습니다.',
  provider_outcome_unknown: 'AI 요청 결과를 확인하지 못해 안전하게 중단했습니다.',
};

export function TodayPage({ api, readOnly = false, now = () => new Date() }: { api: NarrativeApi; readOnly?: boolean; now?: () => Date }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(false);
  const [accessPending, setAccessPending] = useState(false);
  const [accessMessage, setAccessMessage] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<AccessEstimate | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const pollStartedAt = useRef(0);

  const load = async () => {
    setError(false);
    try { setData(await api.getDashboard()); } catch { setError(true); }
  };

  useEffect(() => { void load(); }, [api]);

  useEffect(() => {
    if (!activeJobId) return;
    const current = data?.queue.find((item) => item.id === activeJobId);
    if (current && ['completed', 'cancelled', 'failed/dead-letter'].includes(current.state)) {
      setActiveJobId(null);
      return;
    }
    if (Date.now() - pollStartedAt.current >= 120_000) return;
    const elapsed = Date.now() - pollStartedAt.current;
    const delay = elapsed < 1_000 ? 1_000 : elapsed < 3_000 ? 2_000 : elapsed < 6_000 ? 3_000 : 5_000;
    const timer = window.setTimeout(() => void load(), delay);
    return () => window.clearTimeout(timer);
  }, [activeJobId, data]);

  const openEstimate = async () => {
    setAccessPending(true);
    setAccessMessage(null);
    try { setEstimate(await api.estimateAccess()); }
    catch { setAccessMessage('비용을 확인하지 못했습니다. 설정과 API 키를 확인해 주세요.'); }
    finally { setAccessPending(false); }
  };

  const confirmAccess = async () => {
    if (!estimate) return;
    setAccessPending(true);
    try {
      const job = await api.triggerAccess({ maximumCostConfirmed: true, confirmedMaximumCostMicros: estimate.maximumCostMicros });
      setEstimate(null);
      setActiveJobId(job.id);
      pollStartedAt.current = Date.now();
      setAccessMessage(job.dispatchState === 'started' ? '이야기 생성을 시작했습니다.' : '이야기 생성이 대기 중입니다. 잠시 후 자동으로 시작합니다.');
      await load();
    } catch (caught) {
      const code = caught instanceof NarrativeApiError ? caught.code : 'request_failed';
      setEstimate(null);
      setAccessMessage(code === 'stale_cost_confirmation' ? '비용 정보가 바뀌었습니다. 다시 확인해 주세요.' : '접속 이야기를 만들지 못했습니다. 설정과 API 키를 확인해 주세요.');
    } finally { setAccessPending(false); }
  };

  const cancelJob = async (jobId: string) => {
    try {
      await api.cancelGenerationJob(jobId);
      setAccessMessage('대기 중인 이야기 생성을 취소했습니다.');
      await load();
    } catch {
      setAccessMessage('이미 시작되었거나 완료되어 취소할 수 없습니다.');
    }
  };

  const header = <AdminPageHeader eyebrow="운영 기록" title="오늘" description="이야기 진행 상태와 비용, 다음 일정을 한눈에 확인합니다." />;
  if (error) return <section>{header}<AdminNotice tone="danger" action={<button type="button" onClick={() => void load()}>다시 시도</button>}>오늘 현황을 불러오지 못했습니다.</AdminNotice></section>;
  if (!data) return <section>{header}<AdminNotice>오늘 현황을 불러오는 중입니다.</AdminNotice></section>;
  const dailyUnconfirmed = data.budget.dailyUnconfirmedMicros ?? 0;
  const monthlyUnconfirmed = data.budget.monthlyUnconfirmedMicros ?? 0;

  return <section>
    {header}
    <div className="dashboard-grid">
      <AdminSection title="오늘 사용"><dl><dt>확정 사용</dt><dd>{displayCost(Math.max(data.budget.dailySpentMicros - dailyUnconfirmed, 0), data.krwPerUsd)}</dd><dt>남은 한도</dt><dd>{displayCost(data.budget.dailyRemainingMicros, data.krwPerUsd)}</dd></dl></AdminSection>
      <AdminSection title="이번 달 사용"><dl><dt>확정 사용</dt><dd>{displayCost(Math.max(data.budget.monthlySpentMicros - monthlyUnconfirmed, 0), data.krwPerUsd)}</dd><dt>남은 한도</dt><dd>{displayCost(data.budget.monthlyRemainingMicros, data.krwPerUsd)}</dd></dl></AdminSection>
      <AdminSection title="확인되지 않은 최대 비용"><p className="metric-value">{displayCost(monthlyUnconfirmed, data.krwPerUsd)}</p><p className="settings-help">AI 결과를 받지 못한 요청의 안전한 최대값이며, 실제 결제액으로 확정된 금액이 아닙니다.</p></AdminSection>
      <AdminSection title="처리 중인 예상 비용"><p className="metric-value">{displayCost(data.budget.reservedMicros, data.krwPerUsd)}</p></AdminSection>
      <AdminSection title="일정"><dl><dt>다음 예약</dt><dd>{data.nextScheduleAt ? formatSeoulTimestamp(data.nextScheduleAt, now()).relative : '예정 없음'}</dd><dt>마지막 성공</dt><dd>{data.lastSuccessAt ? formatSeoulTimestamp(data.lastSuccessAt, now()).relative : '아직 없음'}</dd></dl></AdminSection>
    </div>

    {!readOnly && <AdminSection title="접속 이야기 만들기" description="지금 천령과 무영의 짧은 대화 한 편을 요청합니다. 결제 전에 최대 비용을 먼저 보여드립니다.">
      <button type="button" disabled={accessPending || Boolean(activeJobId)} onClick={() => void openEstimate()}>{accessPending ? '확인 중…' : '접속 이야기 만들기'}</button>
      {accessMessage && <p role="status">{accessMessage}</p>}
    </AdminSection>}

    <AdminSection title="이야기 생성 현황" description="최근 요청이 어디까지 진행됐는지 쉬운 말로 보여드립니다." className="incident-section">
      {data.queue.length === 0 ? <p className="empty-copy">진행 중인 이야기가 없습니다.</p> : <ul className="generation-status-list">{data.queue.map((item) => {
        const copy = generationStatusCopy(item);
        const occurredAt = item.completedAt ?? item.failedAt ?? item.createdAt ?? item.scheduledFor;
        const formatted = formatSeoulTimestamp(occurredAt, now());
        return <li key={item.id}>
          <div><strong>{copy.title}</strong><p>{copy.description}</p>{copy.action && <p>{copy.action}</p>}</div>
          <time dateTime={occurredAt} title={formatted.exact}>{formatted.relative}<span className="exact-time">{formatted.exact}</span></time>
          {item.state === 'retry-wait' && item.retryAt && <p>다시 시도 예정: {formatSeoulTimestamp(item.retryAt, now()).relative}</p>}
          {(item.unconfirmedMaximumCostMicros ?? 0) > 0 && <p>확인되지 않은 최대 비용 {displayCost(item.unconfirmedMaximumCostMicros ?? 0, data.krwPerUsd)}</p>}
          {item.attemptCount > 0 && <details><summary>기술 정보</summary><p>시도 횟수 {item.attemptCount}회</p></details>}
          {!readOnly && item.state === 'queued' && item.attemptCount === 0 && <button type="button" onClick={() => void cancelJob(item.id)}>대기 취소</button>}
        </li>;
      })}</ul>}
    </AdminSection>

    <AdminSection title="최근 확인할 일" description="중단된 작업이 있으면 이해하기 쉬운 이유를 보여드립니다." className="incident-section">
      {data.failures.length === 0 ? <p className="empty-copy">확인할 문제가 없습니다.</p> : <ul className="incident-list">{data.failures.map((failure) => {
        const formatted = formatSeoulTimestamp(failure.occurredAt, now());
        return <li key={failure.id}><strong>{failureCopy[failure.code] ?? '이야기 생성이 중단됐습니다.'}</strong><time dateTime={failure.occurredAt} title={formatted.exact}>{formatted.relative}</time></li>;
      })}</ul>}
    </AdminSection>

    {estimate && <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="access-estimate-title">
        <h2 id="access-estimate-title">접속 이야기 비용 확인</h2>
        <p><strong>{estimate.modelLabel}</strong> 모델로 짧은 대화를 만듭니다.</p>
        <p>실제 사용량에 따라 더 적게 들 수 있으며, 최대 {formatKrw(estimate.maximumCostKrw)}까지만 사용합니다.</p>
        <div className="inline-actions">
          <button type="button" disabled={accessPending} onClick={() => void confirmAccess()}>최대 {formatKrw(estimate.maximumCostKrw)}으로 만들기</button>
          <button type="button" disabled={accessPending} onClick={() => setEstimate(null)}>취소</button>
        </div>
      </section>
    </div>}
  </section>;
}
