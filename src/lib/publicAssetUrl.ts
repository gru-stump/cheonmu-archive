const absoluteUrlPattern = /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i;

export function resolvePublicAssetUrl(
  assetPath: string,
  baseUrl = import.meta.env.BASE_URL,
): string {
  if (absoluteUrlPattern.test(assetPath)) return assetPath;

  const basePath = baseUrl.split('/').filter(Boolean).join('/');
  const normalizedBase = basePath ? `/${basePath}/` : '/';
  return `${normalizedBase}${assetPath.replace(/^\/+/, '')}`;
}
