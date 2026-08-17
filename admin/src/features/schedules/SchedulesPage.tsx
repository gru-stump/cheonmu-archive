import { type FormEvent, useEffect, useState } from 'react';
import type { NarrativeApi, NarrativeSchedule, SaveScheduleInput } from '../../api/narrativeApi';
import { AdminNotice } from '../../components/AdminNotice';
import { AdminPageHeader } from '../../components/AdminPageHeader';
import { AdminStatusBadge } from '../../components/AdminStatusBadge';
import { formatSeoulTimestamp } from '../../lib/narrativeDisplay';

const seoulDate = (value: string | null) => {
  if (!value) return '기록 없음';
  return formatSeoulTimestamp(value).exact;
};

const scheduleTypeHelp: Record<string, string> = {
  automatic: '정한 요일과 시각이 되면 자동으로 이야기를 만듭니다.',
  manual: '자동으로 실행되지 않습니다. 직접 만들 때의 기준 시각으로만 사용합니다.',
  special: '지정한 날짜 하루에만 실행되는 일정입니다.',
};
const weekdayNames = ['일', '월', '화', '수', '목', '금', '토'];
const scheduleKindLabels: Record<string, string> = { short_dialogue: '짧은 대화', daily_event: '일상 사건' };

function scheduleSummary(draft: SaveScheduleInput): string {
  const kind = scheduleKindLabels[draft.kind] ?? '이야기';
  if (draft.scheduleType === 'manual') return '자동으로 실행되지 않는 기준용 일정입니다.';
  if (draft.scheduleType === 'special') return `${draft.specialDate || '날짜 미정'} ${draft.seoulTime}에 한 번, '${kind}' 이야기를 만듭니다.`;
  const day = draft.weekday === null || draft.weekday === undefined ? '매일' : `${weekdayNames[draft.weekday] ?? ''}요일마다`;
  return `${day} ${draft.seoulTime}에 '${kind}' 이야기를 만듭니다.`;
}

function ScheduleForm({ api, schedule, readOnly, onSaved, onMessage, onDiscard }: { api: NarrativeApi; schedule: NarrativeSchedule; readOnly: boolean; onSaved(): Promise<void>; onMessage(message: string): void; onDiscard?(): void }) {
  const [draft, setDraft] = useState<SaveScheduleInput>({
    scheduleId: schedule.id.startsWith('new-') ? undefined : schedule.id,
    scheduleKey: schedule.scheduleKey, scheduleType: schedule.scheduleType, enabled: schedule.enabled,
    seoulTime: schedule.seoulTime, weekday: schedule.weekday, specialDate: schedule.specialDate,
    minimumIntervalMinutes: schedule.minimumIntervalMinutes, kind: schedule.kind,
  });
  const [saving, setSaving] = useState(false);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try { await api.saveSchedule(draft); }
    catch { onMessage('일정을 저장하지 못했습니다. 설정 화면에서 ① 자동 만들기가 켜져 있는지 ② AI 요금 정보가 최신인지 확인해 주세요.'); setSaving(false); return; }
    try { await onSaved(); onMessage('일정을 저장했습니다.'); }
    catch { onMessage('저장했지만 최신 일정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    finally { setSaving(false); }
  };
  return <article className="schedule-row">
    <header className="schedule-row__header"><div><h2>{draft.scheduleKey}</h2><p>{draft.scheduleType === 'special' ? '특별일' : draft.scheduleType === 'automatic' ? '자동 일정' : '수동 일정'}</p></div><AdminStatusBadge tone={draft.enabled ? 'green' : 'neutral'}>{draft.enabled ? '사용 중' : '멈춤'}</AdminStatusBadge></header>
    <p className="schedule-summary">{draft.enabled ? scheduleSummary(draft) : `멈춰 있는 일정입니다 — 켜면 ${scheduleSummary(draft)}`}</p>
    <form className="schedule-form" onSubmit={save}>
      <div className="schedule-field"><label htmlFor={`schedule-key-${schedule.id}`}>일정 이름</label>
      <input id={`schedule-key-${schedule.id}`} value={draft.scheduleKey} disabled={readOnly} onChange={(event) => setDraft({ ...draft, scheduleKey: event.target.value })} required />
      <p className="settings-help">목록에서 구분하기 위한 이름입니다. 한글로 적어도 됩니다.</p></div>
      <div className="schedule-field"><label htmlFor={`schedule-type-${schedule.id}`}>일정 종류</label>
      <select id={`schedule-type-${schedule.id}`} value={draft.scheduleType} disabled={readOnly} onChange={(event) => setDraft({ ...draft, scheduleType: event.target.value as SaveScheduleInput['scheduleType'], specialDate: event.target.value === 'special' ? draft.specialDate ?? '' : null })}>
        <option value="automatic">자동</option><option value="manual">수동</option><option value="special">특별일</option>
      </select>
      <p className="settings-help">{scheduleTypeHelp[draft.scheduleType]}</p></div>
      <div className="schedule-field schedule-field--toggle"><label className="control-target"><input type="checkbox" checked={draft.enabled} disabled={readOnly} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /> 이 일정 사용</label></div>
      <div className="schedule-field"><label htmlFor={`schedule-time-${schedule.id}`}>만들기 시각 (한국 시간)</label>
      <input id={`schedule-time-${schedule.id}`} aria-label={`${draft.scheduleKey} 서울 실행 시각`} type="time" value={draft.seoulTime} disabled={readOnly} onChange={(event) => setDraft({ ...draft, seoulTime: event.target.value })} required /></div>
      {draft.scheduleType === 'automatic' && <div className="schedule-field"><label htmlFor={`schedule-weekday-${schedule.id}`}>요일</label><select id={`schedule-weekday-${schedule.id}`} value={draft.weekday ?? ''} disabled={readOnly} onChange={(event) => setDraft({ ...draft, weekday: event.target.value === '' ? null : Number(event.target.value) })}><option value="">매일</option><option value="1">월요일</option><option value="2">화요일</option><option value="3">수요일</option><option value="4">목요일</option><option value="5">금요일</option><option value="6">토요일</option><option value="0">일요일</option></select></div>}
      {draft.scheduleType === 'special' && <div className="schedule-field"><label htmlFor={`special-date-${schedule.id}`}>특별일</label><input id={`special-date-${schedule.id}`} type="date" value={draft.specialDate ?? ''} disabled={readOnly} onChange={(event) => setDraft({ ...draft, specialDate: event.target.value })} required /></div>}
      <div className="schedule-field"><label htmlFor={`minimum-interval-${schedule.id}`}>다시 만들기까지 기다릴 시간(분)</label>
      <input id={`minimum-interval-${schedule.id}`} type="number" min="1" value={draft.minimumIntervalMinutes} disabled={readOnly} onChange={(event) => setDraft({ ...draft, minimumIntervalMinutes: Number(event.target.value) })} required /></div>
      <div className="schedule-field"><label htmlFor={`schedule-kind-${schedule.id}`}>만들 이야기</label>
      <select id={`schedule-kind-${schedule.id}`} value={draft.kind} disabled={readOnly} onChange={(event) => setDraft({ ...draft, kind: event.target.value as SaveScheduleInput['kind'] })}><option value="short_dialogue">짧은 대화</option><option value="daily_event">일상 사건</option></select></div>
      <dl><dt>마지막 실행</dt><dd>{seoulDate(schedule.lastRunAt)}</dd><dt>다음 실행</dt><dd>{seoulDate(schedule.nextRunAt)}</dd></dl>
      <button type="submit" aria-label={`${draft.scheduleKey} 일정 저장`} disabled={readOnly || saving}>{saving ? '저장 중…' : '일정 저장'}</button>
      {onDiscard && <button type="button" className="button--quiet" onClick={onDiscard}>추가 취소</button>}
    </form>
  </article>;
}

export function SchedulesPage({ api, readOnly = false }: { api: NarrativeApi; readOnly?: boolean }) {
  const [schedules, setSchedules] = useState<NarrativeSchedule[] | null>(null);
  const [error, setError] = useState(false);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const load = async (propagate = false) => { setError(false); try { const value = await api.getSchedules(); setSchedules(value.schedules); } catch (loadError) { setError(true); if (propagate) throw loadError; } };
  useEffect(() => { let active = true; void api.getSchedules().then((value) => { if (active) setSchedules(value.schedules); }).catch(() => { if (active) setError(true); }); return () => { active = false; }; }, [api]);
  const addSpecial = () => setSchedules((current) => [...(current ?? []), {
    id: `new-${Date.now()}`, scheduleKey: '특별일', scheduleType: 'special', enabled: false,
    seoulTime: '09:00', weekday: null, specialDate: '', minimumIntervalMinutes: 1440,
    kind: 'short_dialogue', lastRunAt: null, nextRunAt: null,
  }]);
  const discard = (id: string) => setSchedules((current) => (current ?? []).filter((schedule) => schedule.id !== id));
  return <section>
    <AdminPageHeader eyebrow="이야기 예약" title="일정" description="모든 시각은 한국 시간으로 표시됩니다." action={<button type="button" onClick={addSpecial} disabled={readOnly}>특별일 추가</button>} />
    {pageMessage && <AdminNotice tone={pageMessage.startsWith('저장했지만') ? 'warning' : pageMessage.includes('못했습니다') ? 'danger' : 'success'}>{pageMessage}</AdminNotice>}
    {error ? <AdminNotice tone="danger" action={<button type="button" onClick={() => void load()}>다시 시도</button>}>일정을 불러오지 못했습니다.</AdminNotice> : schedules === null ? <AdminNotice>일정을 불러오는 중입니다.</AdminNotice> : schedules.length === 0 ? <AdminNotice>등록된 일정이 없습니다.</AdminNotice> : <div className="schedule-list">{schedules.map((schedule) => <ScheduleForm key={schedule.id} api={api} schedule={schedule} readOnly={readOnly} onSaved={() => load(true)} onMessage={setPageMessage} onDiscard={schedule.id.startsWith('new-') ? () => discard(schedule.id) : undefined} />)}</div>}
  </section>;
}
