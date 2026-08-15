import { type FormEvent, useEffect, useState } from 'react';
import type { NarrativeApi, NarrativeSchedule, SaveScheduleInput } from '../../api/narrativeApi';
import { AdminNotice } from '../../components/AdminNotice';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { AdminStatusBadge } from '../../components/AdminStatusBadge';

const seoulDate = (value: string | null) => {
  if (!value) return '기록 없음';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  const hour = Number(parts.hour);
  return `${parts.year}. ${Number(parts.month)}. ${Number(parts.day)}. ${hour < 12 ? '오전' : '오후'} ${hour % 12 || 12}:${parts.minute}`;
};

function ScheduleForm({ api, schedule, readOnly, onSaved, onMessage }: { api: NarrativeApi; schedule: NarrativeSchedule; readOnly: boolean; onSaved(): Promise<void>; onMessage(message: string): void }) {
  const [draft, setDraft] = useState<SaveScheduleInput>({
    scheduleId: schedule.id.startsWith('new-') ? undefined : schedule.id,
    scheduleKey: schedule.scheduleKey, scheduleType: schedule.scheduleType, enabled: schedule.enabled,
    seoulTime: schedule.seoulTime, weekday: schedule.weekday, specialDate: schedule.specialDate,
    minimumIntervalMinutes: schedule.minimumIntervalMinutes, kind: schedule.kind,
  });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    try { await api.saveSchedule(draft); }
    catch { onMessage('일정을 저장하지 못했습니다. 단가 확인일과 자동화 설정을 확인해 주세요.'); return; }
    try { await onSaved(); onMessage('일정을 저장했습니다.'); }
    catch { onMessage('저장했지만 최신 일정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
  };
  return <article className="schedule-row">
    <header className="schedule-row__header"><div><h2>{draft.scheduleKey}</h2><p>{draft.scheduleType === 'special' ? '특별일' : draft.scheduleType === 'automatic' ? '자동 실행' : '수동 실행'}</p></div><AdminStatusBadge tone={draft.enabled ? 'green' : 'neutral'}>{draft.enabled ? '활성' : '비활성'}</AdminStatusBadge></header>
    <form className="schedule-form" onSubmit={save}>
      <div className="schedule-field"><label htmlFor={`schedule-key-${schedule.id}`}>일정 키</label>
      <input id={`schedule-key-${schedule.id}`} value={draft.scheduleKey} onChange={(event) => setDraft({ ...draft, scheduleKey: event.target.value })} required /></div>
      <div className="schedule-field"><label htmlFor={`schedule-type-${schedule.id}`}>일정 종류</label>
      <select id={`schedule-type-${schedule.id}`} value={draft.scheduleType} onChange={(event) => setDraft({ ...draft, scheduleType: event.target.value as SaveScheduleInput['scheduleType'], specialDate: event.target.value === 'special' ? draft.specialDate ?? '' : null })}>
        <option value="automatic">자동</option><option value="manual">수동</option><option value="special">특별일</option>
      </select></div>
      <div className="schedule-field schedule-field--toggle"><label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> 활성</label></div>
      <div className="schedule-field"><label htmlFor={`schedule-time-${schedule.id}`}>서울 실행 시각</label>
      <input id={`schedule-time-${schedule.id}`} aria-label={`${draft.scheduleKey} 서울 실행 시각`} type="time" value={draft.seoulTime} onChange={(event) => setDraft({ ...draft, seoulTime: event.target.value })} required /></div>
      {draft.scheduleType === 'automatic' && <div className="schedule-field"><label htmlFor={`schedule-weekday-${schedule.id}`}>요일</label><select id={`schedule-weekday-${schedule.id}`} value={draft.weekday ?? ''} onChange={(event) => setDraft({ ...draft, weekday: event.target.value === '' ? null : Number(event.target.value) })}><option value="">매일</option><option value="1">월요일</option><option value="2">화요일</option><option value="3">수요일</option><option value="4">목요일</option><option value="5">금요일</option><option value="6">토요일</option><option value="0">일요일</option></select></div>}
      {draft.scheduleType === 'special' && <div className="schedule-field"><label htmlFor={`special-date-${schedule.id}`}>특별일</label><input id={`special-date-${schedule.id}`} type="date" value={draft.specialDate ?? ''} onChange={(event) => setDraft({ ...draft, specialDate: event.target.value })} required /></div>}
      <div className="schedule-field"><label htmlFor={`minimum-interval-${schedule.id}`}>최소 간격(분)</label>
      <input id={`minimum-interval-${schedule.id}`} type="number" min="1" value={draft.minimumIntervalMinutes} onChange={(event) => setDraft({ ...draft, minimumIntervalMinutes: Number(event.target.value) })} required /></div>
      <div className="schedule-field"><label htmlFor={`schedule-kind-${schedule.id}`}>생성 종류</label>
      <select id={`schedule-kind-${schedule.id}`} value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as SaveScheduleInput['kind'] })}><option value="short_dialogue">짧은 대화</option><option value="daily_event">일상 사건</option></select></div>
      <dl><dt>마지막 실행</dt><dd>{seoulDate(schedule.lastRunAt)}</dd><dt>다음 실행</dt><dd>{seoulDate(schedule.nextRunAt)}</dd></dl>
      <button type="submit" aria-label={`${draft.scheduleKey} 일정 저장`} disabled={readOnly}>일정 저장</button>
    </form>
  </article>;
}

export function SchedulesPage({ api, readOnly = false }: { api: NarrativeApi; readOnly?: boolean }) {
  const [schedules, setSchedules] = useState<NarrativeSchedule[] | null>(null);
  const [error, setError] = useState(false);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const load = async () => { const value = await api.getSchedules(); setSchedules(value.schedules); setError(false); };
  useEffect(() => { let active = true; void api.getSchedules().then((value) => { if (active) setSchedules(value.schedules); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api]);
  const addSpecial = () => setSchedules((current) => [...(current ?? []), {
    id: `new-${Date.now()}`, scheduleKey: 'special-date', scheduleType: 'special', enabled: false,
    seoulTime: '09:00', weekday: null, specialDate: '', minimumIntervalMinutes: 1440,
    kind: 'short_dialogue', lastRunAt: null, nextRunAt: null,
  }]);
  return <section>
    <AdminPageHeader eyebrow="자동화 시계" title="일정" description="모든 실행 시각과 특별일은 Asia/Seoul 기준입니다." action={<button type="button" onClick={addSpecial} disabled={readOnly}>특별일 추가</button>} />
    {pageMessage && <AdminNotice tone={pageMessage.startsWith('저장했지만') ? 'warning' : pageMessage.includes('못했습니다') ? 'danger' : 'success'}>{pageMessage}</AdminNotice>}
    {error ? <AdminNotice tone="danger">일정을 불러오지 못했습니다.</AdminNotice> : schedules === null ? <AdminNotice>일정을 불러오는 중입니다.</AdminNotice> : schedules.length === 0 ? <AdminNotice>등록된 일정이 없습니다.</AdminNotice> : <div className="schedule-list">{schedules.map((schedule) => <ScheduleForm key={schedule.id} api={api} schedule={schedule} readOnly={readOnly} onSaved={load} onMessage={setPageMessage} />)}</div>}
  </section>;
}
