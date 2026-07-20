export type GalleryImageExtension = 'png' | 'jpg' | 'webp';

function matches(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

export function galleryImageExtensionFromBytes(bytes: Uint8Array): GalleryImageExtension | null {
  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (matches(bytes, [0xff, 0xd8, 0xff])) return 'jpg';
  if (matches(bytes, [0x52, 0x49, 0x46, 0x46]) && matches(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  return null;
}

function readFileBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('이미지 파일을 읽지 못했습니다.'));
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.readAsArrayBuffer(file);
  });
}

export async function galleryImageExtension(file: File): Promise<GalleryImageExtension | null> {
  return galleryImageExtensionFromBytes(await readFileBytes(file));
}
