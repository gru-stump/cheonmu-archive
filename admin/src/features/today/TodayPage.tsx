import { useEffect, useState } from 'react';
import type { DashboardData, NarrativeApi } from '../../api/narrativeApi';
import { AdminNotice } from '../../components/AdminNotice';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { AdminSection } from '../../components/AdminSection';

const micros = (value: number) => `${new Intl.NumberFormat('en-US').format(value)} μUSD`;
const seoulDate = (value: string | null) => {
  if (!value) return '예정 없음';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  return `${parts.year}. ${Number(parts.month)}. ${Number(parts.day)}. ${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}:${parts.minute}`;
};

export function TodayPage({ api }: { api: NarrativeApi }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState(false);
  const load = async () => { setError(false); try { setData(await api.getDashboard()); } catch { setError(true); } };
  useEffect(() => { let active = true; void api.getDashboard().then((value) => { if (active) setData(value); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api]);
  const header = <AdminPageHeader eyebrow="운영 기록" title="오늘" description="오늘의 생성 흐름, 예산, 다음 실행을 한눈에 살핍니다." />;
  if (error) return <section>{header}<AdminNotice tone="danger" action={<button type="button" onClick={() => void load()}>다시 시도</button>}>오늘 현황을 불러오지 못했습니다.</AdminNotice></section>;
  if (!data) return <section>{header}<AdminNotice>오늘 현황을 불러오는 중입니다.</AdminNotice></section>;
  return (
    <section>
      {header}
      <div className="dashboard-grid">
        <AdminSection title="일일 예산"><dl><dt>사용</dt><dd>{micros(data.budget.dailySpentMicros)}</dd><dt>남음</dt><dd>{micros(data.budget.dailyRemainingMicros)}</dd></dl></AdminSection>
        <AdminSection title="월간 예산"><dl><dt>사용</dt><dd>{micros(data.budget.monthlySpentMicros)}</dd><dt>남음</dt><dd>{micros(data.budget.monthlyRemainingMicros)}</dd></dl></AdminSection>
        <AdminSection title="예약 비용"><p className="metric-value">{micros(data.budget.reservedMicros)}</p></AdminSection>
        <AdminSection title="실행 현황"><dl><dt>다음 예약</dt><dd>{seoulDate(data.nextScheduleAt)}</dd><dt>마지막 성공</dt><dd>{seoulDate(data.lastSuccessAt)}</dd></dl></AdminSection>
      </div>
      <AdminSection title="최근 실패" description="운영 확인이 필요한 최근 기록입니다." className="incident-section">{data.failures.length === 0 ? <p className="empty-copy">실패 없음</p> : <ul className="incident-list">{data.failures.map((failure) => <li key={failure.id}><strong>{failure.code}</strong><time dateTime={failure.occurredAt}>{seoulDate(failure.occurredAt)}</time></li>)}</ul>}</AdminSection>
    </section>
  );
}
