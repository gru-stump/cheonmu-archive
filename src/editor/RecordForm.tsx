import type { ChangeEvent, JSX } from 'react';
import type { RecordMeta } from '../content/schema';

type RecordFormProps = { value: RecordMeta; recordIds: readonly string[]; errors: Record<string, string>; onChange(next: Partial<RecordMeta>): void; onBodyChange(value: string): void; body: string };
const FieldError = ({ error }: { error?: string }): JSX.Element | null => error ? <p role="alert">{error}</p> : null;
const toList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);

export function RecordForm({ value, recordIds, errors, onChange, onBodyChange, body }: RecordFormProps): JSX.Element {
  const updateRelated = (event: ChangeEvent<HTMLSelectElement>) => onChange({ related: Array.from(event.currentTarget.selectedOptions, (option) => option.value) });
  return <fieldset><legend>기록 정보</legend>
    <label>식별자<input value={value.id} onChange={(event) => onChange({ id: event.target.value })} /></label><FieldError error={errors.id} />
    <label>기록 번호<input value={value.recordNumber} onChange={(event) => onChange({ recordNumber: event.target.value })} /></label><FieldError error={errors.recordNumber} />
    <label>제목<input value={value.title} onChange={(event) => onChange({ title: event.target.value })} /></label><FieldError error={errors.title} />
    <label>단계<input type="number" min="1" max="8" value={value.stage} onChange={(event) => onChange({ stage: Number(event.target.value) })} /></label><FieldError error={errors.stage} />
    <label>기록 상태<select value={value.status} onChange={(event) => onChange({ status: event.target.value as RecordMeta['status'] })}><option value="confirmed">확정</option><option value="draft">초안</option></select></label>
    <label>등장인물<input value={value.characters.join(', ')} onChange={(event) => onChange({ characters: toList(event.target.value) })} /></label><FieldError error={errors.characters} />
    <label>태그<input value={value.tags.join(', ')} onChange={(event) => onChange({ tags: toList(event.target.value) })} /></label><FieldError error={errors.tags} />
    <label>관련 기록<select multiple value={value.related} onChange={updateRelated}>{recordIds.filter((id) => id !== value.id).map((id) => <option key={id} value={id}>{id}</option>)}</select></label><FieldError error={errors.related} />
    <label>인용문<input value={value.quote} onChange={(event) => onChange({ quote: event.target.value })} /></label><FieldError error={errors.quote} />
    <label><input type="checkbox" checked={value.cinematic} onChange={(event) => onChange({ cinematic: event.target.checked })} />장면 재구성</label>
    <label>출처 제작자<input value={value.credit?.creator ?? ''} onChange={(event) => onChange({ credit: { creator: event.target.value, source: value.credit?.source } })} /></label><FieldError error={errors['credit.creator']} />
    <label>출처 URL<input type="url" value={value.credit?.source ?? ''} onChange={(event) => onChange({ credit: { creator: value.credit?.creator ?? '', source: event.target.value || undefined } })} /></label><FieldError error={errors['credit.source']} />
    <label>본문 (Markdown)<textarea value={body} onChange={(event) => onBodyChange(event.target.value)} /></label>
  </fieldset>;
}
