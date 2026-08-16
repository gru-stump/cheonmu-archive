import { createNarrativeHandler } from '../../src/server/narrativeHandler';

export default async function handler(request: any, response: any) {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseAnonKey) return response.status(503).json({ error: 'server_not_configured' });
  const protocol = request.headers['x-forwarded-proto'] ?? 'https';
  const host = request.headers.host ?? 'localhost';
  const body = request.method === 'GET' || request.method === 'HEAD' || request.body === undefined || request.body === null
    ? undefined
    : JSON.stringify(request.body);
  const webResponse = await createNarrativeHandler({ supabaseUrl, supabaseAnonKey })(new Request(`${protocol}://${host}${request.url}`, { method: request.method, headers: request.headers as HeadersInit, body }));
  response.status(webResponse.status);
  webResponse.headers.forEach((value, key) => response.setHeader(key, value));
  response.send(await webResponse.text());
}
