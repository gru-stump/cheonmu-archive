import { useEffect, useId, useState, type JSX } from 'react';
import { ZodError } from 'zod';
import { galleryItemSchema, type GalleryItem } from '../content/schema';
import { resolvePublicAssetUrl } from '../lib/publicAssetUrl';

export type GalleryValidation = { valid: boolean; fields: Record<string, string> };

export function validateGalleryDraft(value: GalleryItem): GalleryValidation {
  try {
    galleryItemSchema.parse(value);
    return { valid: true, fields: {} };
  } catch (error) {
    if (error instanceof ZodError) {
      return {
        valid: false,
        fields: Object.fromEntries(error.issues.map((issue) => [issue.path.join('.') || 'gallery', issue.message])),
      };
    }
    return { valid: false, fields: { gallery: '화랑 정보를 검증할 수 없습니다.' } };
  }
}

type GalleryFormProps = {
  value: GalleryItem;
  errors: Record<string, string>;
  idEditable: boolean;
  disabled?: boolean;
  selectedFile: File | null;
  onChange(next: Partial<GalleryItem>): void;
  onFileChange(file: File | null): void;
};

const toList = (value: string): string[] => value.split(',').map((item) => item.trim()).filter(Boolean);

function normalizedExtension(file: File): string | null {
  const fileExtension = file.name.split('.').pop()?.toLowerCase();
  if (fileExtension === 'png' || fileExtension === 'webp') return fileExtension;
  if (fileExtension === 'jpg' || fileExtension === 'jpeg') return 'jpg';
  if (file.type === 'image/png') return 'png';
  if (file.type === 'image/jpeg') return 'jpg';
  if (file.type === 'image/webp') return 'webp';
  return null;
}

export function suggestedGalleryPath(id: string, file: File): string {
  const extension = normalizedExtension(file);
  return id && extension ? `/images/${id}.${extension}` : '';
}

export function GalleryForm({
  value,
  errors,
  idEditable,
  disabled = false,
  selectedFile,
  onChange,
  onFileChange,
}: GalleryFormProps): JSX.Element {
  const prefix = useId();
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const errorId = (name: string) => `${prefix}-${name}-error`;
  const props = (name: string) => errors[name]
    ? { 'aria-invalid': true as const, 'aria-describedby': errorId(name) }
    : {};
  const error = (name: string) => errors[name]
    ? <p id={errorId(name)} role="alert">{errors[name]}</p>
    : null;
  const idDescription = idEditable ? undefined : `${prefix}-id-rule`;

  useEffect(() => {
    if (!selectedFile || typeof URL.createObjectURL !== 'function') {
      setLocalPreview(null);
      return undefined;
    }
    const url = URL.createObjectURL(selectedFile);
    setLocalPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [selectedFile]);

  const extension = selectedFile ? normalizedExtension(selectedFile) : null;
  const resultingPath = selectedFile && extension ? suggestedGalleryPath(value.id, selectedFile) : value.image;
  const preview = localPreview ?? (value.image ? resolvePublicAssetUrl(value.image) : null);

  return <fieldset disabled={disabled}>
    <legend>화랑 정보</legend>
    <label>식별자<input
      value={value.id}
      readOnly={!idEditable}
      aria-describedby={errors.id ? errorId('id') : idDescription}
      aria-invalid={errors.id ? true : undefined}
      onChange={(event) => onChange({ id: event.target.value })}
    /></label>
    {!idEditable && <p id={idDescription}>기존 화랑 항목의 식별자는 변경할 수 없습니다.</p>}
    {error('id')}
    <label>제목<input value={value.title} {...props('title')} onChange={(event) => onChange({ title: event.target.value })} /></label>
    {error('title')}
    <label>대체 텍스트<textarea value={value.alt} {...props('alt')} onChange={(event) => onChange({ alt: event.target.value })} /></label>
    {error('alt')}
    <label>제작자<input value={value.creator} {...props('creator')} onChange={(event) => onChange({ creator: event.target.value })} /></label>
    {error('creator')}
    <label>출처 URL<input
      type="url"
      value={value.source ?? ''}
      {...props('source')}
      onChange={(event) => onChange({ source: event.target.value || undefined })}
    /></label>
    {error('source')}
    <label>캐릭터 태그<input value={value.characters.join(', ')} {...props('characters')} onChange={(event) => onChange({ characters: toList(event.target.value) })} /></label>
    {error('characters')}
    <label>분류 태그<input value={(value.tags ?? []).join(', ')} {...props('tags')} onChange={(event) => onChange({ tags: toList(event.target.value) })} /></label>
    {error('tags')}
    <label><input type="checkbox" checked={value.public} onChange={(event) => onChange({ public: event.target.checked })} />공개</label>
    {error('public')}
    <label>이미지 파일<input
      type="file"
      accept="image/png,image/jpeg,image/webp"
      {...props('image')}
      onChange={(event) => onFileChange(event.target.files?.[0] ?? null)}
    /></label>
    {error('image')}
    {preview && <img src={preview} alt={selectedFile ? '선택한 이미지 미리보기' : value.alt} />}
    <p>공개 경로: <output>{resultingPath || '이미지를 선택하세요.'}</output></p>
  </fieldset>;
}
