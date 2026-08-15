import { useEffect, useState } from 'react';
import type { DashboardData, NarrativeApi } from '../../api/narrativeApi';

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
  useEffect(() => { let active = true; void api.getDashboard().then((value) => { if (active) setData(value); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api]);
  if (error) return <section aria-labelledby="today-title"><h1 id="today-title">오늘</h1><p role="alert">오늘 현황을 불러오지 못했습니다.</p></section>;
  if (!data) return <section aria-labelledby="today-title"><h1 id="today-title">오늘</h1><p role="status">오늘 현황을 불러오는 중입니다.</p></section>;
  return (
    <section aria-labelledby="today-title">
      <h1 id="today-title">오늘</h1>
      <div className="dashboard-grid">
        <section aria-labelledby="daily-budget"><h2 id="daily-budget">일일 예산</h2><dl><dt>사용</dt><dd>{micros(data.budget.dailySpentMicros)}</dd><dt>남음</dt><dd>{micros(data.budget.dailyRemainingMicros)}</dd></dl></section>
        <section aria-labelledby="monthly-budget"><h2 id="monthly-budget">월간 예산</h2><dl><dt>사용</dt><dd>{micros(data.budget.monthlySpentMicros)}</dd><dt>남음</dt><dd>{micros(data.budget.monthlyRemainingMicros)}</dd></dl></section>
        <section aria-labelledby="reserved-budget"><h2 id="reserved-budget">예약 비용</h2><p>{micros(data.budget.reservedMicros)}</p></section>
        <section aria-labelledby="schedule-status"><h2 id="schedule-status">실행 현황</h2><dl><dt>다음 예약</dt><dd>{seoulDate(data.nextScheduleAt)}</dd><dt>마지막 성공</dt><dd>{seoulDate(data.lastSuccessAt)}</dd></dl></section>
      </div>
      <section aria-labelledby="failures"><h2 id="failures">최근 실패</h2>{data.failures.length === 0 ? <p>실패 없음</p> : <ul>{data.failures.map((failure) => <li key={failure.id}><strong>{failure.code}</strong> <time dateTime={failure.occurredAt}>{seoulDate(failure.occurredAt)}</time></li>)}</ul>}</section>
    </section>
  );
}
