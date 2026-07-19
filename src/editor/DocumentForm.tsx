import { useId, type JSX } from 'react';
import type { DocumentMeta } from '../content/schema';

type DocumentFormProps = { value: DocumentMeta; errors: Record<string, string>; idEditable: boolean; onChange(next: Partial<DocumentMeta>): void; onBodyChange(value: string): void; body: string };
type Credit = NonNullable<DocumentMeta['credit']>;
const creditFrom = (creator: string, source: string): Credit | undefined => creator || source ? { creator, source: source || undefined } : undefined;

export function DocumentForm({ value, errors, idEditable, onChange, onBodyChange, body }: DocumentFormProps): JSX.Element {
  const prefix = useId();
  const errorId = (name: string) => `${prefix}-${name.replace('.', '-')}-error`;
  const props = (name: string) => errors[name] ? { 'aria-invalid': true as const, 'aria-describedby': errorId(name) } : {};
  const error = (name: string) => errors[name] ? <p id={errorId(name)} role="alert">{errors[name]}</p> : null;
  const idDescription = idEditable ? undefined : `${prefix}-id-rule`;
  return <fieldset><legend>문서 정보</legend>
    <label>식별자<input value={value.id} readOnly={!idEditable} aria-describedby={errors.id ? errorId('id') : idDescription} aria-invalid={errors.id ? true : undefined} onChange={(event) => onChange({ id: event.target.value })} /></label>{!idEditable && <p id={idDescription}>기존 항목의 식별자는 변경할 수 없습니다.</p>}{error('id')}
    <label>제목<input value={value.title} {...props('title')} onChange={(event) => onChange({ title: event.target.value })} /></label>{error('title')}
    <label>출처 제작자<input value={value.credit?.creator ?? ''} {...props('credit.creator')} onChange={(event) => onChange({ credit: creditFrom(event.target.value, value.credit?.source ?? '') })} /></label>{error('credit.creator')}
    <label>출처 URL<input type="url" value={value.credit?.source ?? ''} {...props('credit.source')} onChange={(event) => onChange({ credit: creditFrom(value.credit?.creator ?? '', event.target.value) })} /></label>{error('credit.source')}
    <label>본문 (Markdown)<textarea value={body} {...props('body')} onChange={(event) => onBodyChange(event.target.value)} /></label>{error('body')}
  </fieldset>;
}
