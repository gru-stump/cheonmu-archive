export interface CorsPolicy {
  readonly allowedOrigins: ReadonlySet<string>;
}

const standardSupabaseRequestHeaders = ['authorization', 'apikey', 'x-client-info', 'content-type'] as const;
const allowedRequestHeaders = standardSupabaseRequestHeaders.join(', ');
const allowedRequestHeaderSet = new Set<string>(standardSupabaseRequestHeaders);

function normalizedOrigin(value: string): string {
  const candidate = value.trim();
  if (!candidate || candidate === '*') throw new Error('invalid_cors_origin');
  const parsed = new URL(candidate);
  if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || parsed.origin !== candidate) throw new Error('invalid_cors_origin');
  return parsed.origin;
}

export function createCorsPolicy(origins: readonly string[]): CorsPolicy {
  return { allowedOrigins: new Set(origins.filter((origin) => origin.trim() !== '').map(normalizedOrigin)) };
}

export function corsPolicyFromEnvironment(value: string | undefined): CorsPolicy {
  return createCorsPolicy((value ?? '').split(','));
}

function varyOrigin(headers: Headers): void {
  const current = headers.get('vary');
  if (!current) headers.set('vary', 'Origin');
  else if (!current.split(',').some((value) => value.trim().toLowerCase() === 'origin')) headers.set('vary', `${current}, Origin`);
}

export function withCorsHeaders(request: Request, response: Response, policy: CorsPolicy): Response {
  const origin = request.headers.get('origin');
  if (!origin || !policy.allowedOrigins.has(origin)) return response;
  const headers = new Headers(response.headers);
  headers.set('access-control-allow-origin', origin);
  varyOrigin(headers);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** Returns a terminal response for preflight or for any explicitly disallowed browser origin. */
export function corsGate(request: Request, policy: CorsPolicy): Response | null {
  const origin = request.headers.get('origin');
  if (origin && !policy.allowedOrigins.has(origin)) {
    const headers = new Headers({ vary: 'Origin' });
    return Response.json({ error: 'origin_not_allowed' }, { status: 403, headers });
  }
  if (request.method !== 'OPTIONS') return null;
  if (!origin) return Response.json({ error: 'origin_not_allowed' }, { status: 403, headers: { vary: 'Origin' } });
  const requestedMethod = request.headers.get('access-control-request-method')?.toUpperCase();
  const requestedHeaders = (request.headers.get('access-control-request-headers') ?? '')
    .split(',').map((header) => header.trim().toLowerCase()).filter(Boolean);
  if (requestedMethod !== 'POST' || requestedHeaders.some((header) => !allowedRequestHeaderSet.has(header))) {
    return Response.json({ error: 'cors_preflight_rejected' }, { status: 403, headers: { vary: 'Origin' } });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': allowedRequestHeaders,
      'access-control-max-age': '600',
      vary: 'Origin',
    },
  });
}
