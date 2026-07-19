import { useId, type ChangeEvent, type JSX } from 'react';
import type { RecordMeta } from '../content/schema';

type RecordFormProps = {
  value: RecordMeta;
  recordIds: readonly string[];
  errors: Record<string, string>;
  idEditable: boolean;
  onChange(next: Partial<RecordMeta>): void;
  onBodyChange(value: string): void;
  body: string;
};

type ErrorProps = { 'aria-invalid'?: true; 'aria-describedby'?: string };
const toList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);
type Credit = NonNullable<RecordMeta['credit']>;
const creditFrom = (creator: string, source: string): Credit | undefined => creator || source ? { creator, source: source || undefined } : undefined;

export function RecordForm({ value, recordIds, errors, idEditable, onChange, onBodyChange, body }: RecordFormProps): JSX.Element {
  const prefix = useId();
  const errorId = (name: string) => `${prefix}-${name.replace('.', '-')}-error`;
  const errorProps = (name: string): ErrorProps => errors[name] ? { 'aria-invalid': true, 'aria-describedby': errorId(name) } : {};
  const error = (name: string) => errors[name] ? <p id={errorId(name)} role="alert">{errors[name]}</p> : null;
  const idDescription = idEditable ? undefined : `${prefix}-id-rule`;
  const updateRelated = (event: ChangeEvent<HTMLSelectElement>) => onChange({ related: Array.from(event.currentTarget.selectedOptions, (option) => option.value) });

  return <fieldset><legend>기록 정보</legend>
    <label>식별자<input value={value.id} readOnly={!idEditable} aria-describedby={errors.id ? errorId('id') : idDescription} aria-invalid={errors.id ? true : undefined} onChange={(event) => onChange({ id: event.target.value })} /></label>
    {!idEditable && <p id={idDescription}>기존 항목의 식별자는 변경할 수 없습니다.</p>}{error('id')}
    <label>기록 번호<input value={value.recordNumber} {...errorProps('recordNumber')} onChange={(event) => onChange({ recordNumber: event.target.value })} /></label>{error('recordNumber')}
    <label>제목<input value={value.title} {...errorProps('title')} onChange={(event) => onChange({ title: event.target.value })} /></label>{error('title')}
    <label>단계<input type="number" min="1" max="8" value={value.stage} {...errorProps('stage')} onChange={(event) => onChange({ stage: Number(event.target.value) })} /></label>{error('stage')}
    <label>기록 상태<select value={value.status} {...errorProps('status')} onChange={(event) => onChange({ status: event.target.value as RecordMeta['status'] })}><option value="confirmed">확정</option><option value="draft">초안</option></select></label>{error('status')}
    <label>등장인물<input value={value.characters.join(', ')} {...errorProps('characters')} onChange={(event) => onChange({ characters: toList(event.target.value) })} /></label>{error('characters')}
    <label>태그<input value={value.tags.join(', ')} {...errorProps('tags')} onChange={(event) => onChange({ tags: toList(event.target.value) })} /></label>{error('tags')}
    <label>관련 기록<select multiple value={value.related} {...errorProps('related')} onChange={updateRelated}>{recordIds.filter((id) => id !== value.id).map((id) => <option key={id} value={id}>{id}</option>)}</select></label>{error('related')}
    <label>인용문<input value={value.quote} {...errorProps('quote')} onChange={(event) => onChange({ quote: event.target.value })} /></label>{error('quote')}
    <label><input type="checkbox" checked={value.cinematic} {...errorProps('cinematic')} onChange={(event) => onChange({ cinematic: event.target.checked })} />장면 재구성</label>{error('cinematic')}
    <label>출처 제작자<input value={value.credit?.creator ?? ''} {...errorProps('credit.creator')} onChange={(event) => onChange({ credit: creditFrom(event.target.value, value.credit?.source ?? '') })} /></label>{error('credit.creator')}
    <label>출처 URL<input type="url" value={value.credit?.source ?? ''} {...errorProps('credit.source')} onChange={(event) => onChange({ credit: creditFrom(value.credit?.creator ?? '', event.target.value) })} /></label>{error('credit.source')}
    <label>본문 (Markdown)<textarea value={body} {...errorProps('body')} onChange={(event) => onBodyChange(event.target.value)} /></label>{error('body')}
  </fieldset>;
}
