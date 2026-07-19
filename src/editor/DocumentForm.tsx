import type { JSX } from 'react';
import type { DocumentMeta } from '../content/schema';
type DocumentFormProps = { value: DocumentMeta; errors: Record<string, string>; onChange(next: Partial<DocumentMeta>): void; onBodyChange(value: string): void; body: string };
export function DocumentForm({ value, errors, onChange, onBodyChange, body }: DocumentFormProps): JSX.Element { return <fieldset><legend>문서 정보</legend>
  <label>식별자<input value={value.id} onChange={(event) => onChange({ id: event.target.value })} /></label>{errors.id && <p role="alert">{errors.id}</p>}
  <label>제목<input value={value.title} onChange={(event) => onChange({ title: event.target.value })} /></label>{errors.title && <p role="alert">{errors.title}</p>}
  <label>출처 제작자<input value={value.credit?.creator ?? ''} onChange={(event) => onChange({ credit: { creator: event.target.value, source: value.credit?.source } })} /></label>{errors['credit.creator'] && <p role="alert">{errors['credit.creator']}</p>}
  <label>출처 URL<input type="url" value={value.credit?.source ?? ''} onChange={(event) => onChange({ credit: { creator: value.credit?.creator ?? '', source: event.target.value || undefined } })} /></label>{errors['credit.source'] && <p role="alert">{errors['credit.source']}</p>}
  <label>본문 (Markdown)<textarea value={body} onChange={(event) => onBodyChange(event.target.value)} /></label>
</fieldset>; }
