/** Parse one non-empty bearer credential; Supabase Auth performs JWT validation. */
export function bearerToken(request: Request): string | null {
  const match = /^Bearer[ \t]+([^\s,]+)$/i.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}
