import { z } from 'zod';
import { bearerToken } from '../_shared/auth.ts';
import { corsGate, corsPolicyFromEnvironment, createCorsPolicy, withCorsHeaders, type CorsPolicy } from '../_shared/cors.ts';

export type SecretKind = 'openai' | 'anthropic' | 'github';
export interface SecretWriteCommand { authToken: string; kind: SecretKind; value: string }
export interface ManageSettingsDependencies {
  authenticateOwner(token: string): Promise<{ ownerId: string }>;
  storeSecret(input: { ownerId: string; kind: SecretKind; value: string }): Promise<boolean>;
}
export interface SupabaseManageSettingsConfig { url: string; anonKey: string; serviceRoleKey: string; fetch?: typeof globalThis.fetch }
export class ManageSettingsError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); this.name = 'ManageSettingsError'; }
}

const bodySchema = z.object({
  kind: z.enum(['openai', 'anthropic', 'github']),
  value: z.string().trim().min(1).max(20_000),
}).strict();

export async function applySecretWrite(deps: ManageSettingsDependencies, command: SecretWriteCommand): Promise<{ configured: true }> {
  const owner = await deps.authenticateOwner(command.authToken);
  const configured = await deps.storeSecret({ ownerId: owner.ownerId, kind: command.kind, value: command.value });
  if (configured !== true) throw new ManageSettingsError(500, 'internal_error');
  return { configured: true };
}

const noCorsPolicy = createCorsPolicy([]);

export function createManageSettingsHandler(deps: ManageSettingsDependencies, cors: CorsPolicy = noCorsPolicy): (request: Request) => Promise<Response> {
  return async (request) => {
    const gated = corsGate(request, cors);
    if (gated) return gated;
    const respond = (response: Response) => withCorsHeaders(request, response, cors);
    if (request.method !== 'POST') return respond(Response.json({ error: 'method_not_allowed' }, { status: 405 }));
    try {
      const token = bearerToken(request);
      if (!token) throw new ManageSettingsError(401, 'authentication_required');
      let value: unknown;
      try { value = await request.json(); } catch { throw new ManageSettingsError(400, 'invalid_command'); }
      const parsed = bodySchema.safeParse(value);
      if (!parsed.success) throw new ManageSettingsError(400, 'invalid_command');
      return respond(Response.json(await applySecretWrite(deps, { authToken: token, ...parsed.data })));
    } catch (error) {
      const known = error instanceof ManageSettingsError ? error : new ManageSettingsError(500, 'internal_error');
      return respond(Response.json({ error: known.code }, { status: known.status }));
    }
  };
}

function record(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return value[0] && typeof value[0] === 'object' ? value[0] as Record<string, unknown> : null;
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function createSupabaseManageSettingsDependencies(config: SupabaseManageSettingsConfig, authToken: string): ManageSettingsDependencies {
  const request = config.fetch ?? globalThis.fetch;
  const userHeaders = { apikey: config.anonKey, authorization: `Bearer ${authToken}`, 'content-type': 'application/json' };
  const serviceHeaders = { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' };
  const call = async (headers: Record<string, string>, path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await request(`${config.url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const value = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      if (path === '/auth/v1/user' && (response.status === 401 || response.status === 403)) throw new ManageSettingsError(401, 'authentication_required');
      throw new ManageSettingsError(response.status === 401 || response.status === 403 ? response.status : 500,
        response.status === 403 ? 'owner_access_required' : 'internal_error');
    }
    return value;
  };
  return {
    authenticateOwner: async () => {
      const user = record(await call(userHeaders, '/auth/v1/user'));
      if (typeof user?.id !== 'string' || !user.id) throw new ManageSettingsError(401, 'authentication_required');
      const owners = await call(userHeaders, `/rest/v1/owner_profiles?select=owner_id&owner_id=eq.${encodeURIComponent(user.id)}`);
      const ownerRows = Array.isArray(owners) ? owners : [];
      if (ownerRows.length !== 1 || (ownerRows[0] as { owner_id?: unknown })?.owner_id !== user.id) throw new ManageSettingsError(403, 'owner_access_required');
      return { ownerId: user.id };
    },
    storeSecret: async (input) => {
      const value = await call(serviceHeaders, '/rest/v1/rpc/store_narrative_secret', {
        method: 'POST',
        body: JSON.stringify({ p_owner_id: input.ownerId, p_secret_kind: input.kind, p_secret_value: input.value }),
      });
      return value === true;
    },
  };
}

interface DenoRuntime { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Response | Promise<Response>): void }
declare const Deno: DenoRuntime;
if (typeof Deno !== 'undefined' && (import.meta as ImportMeta & { main?: boolean }).main) {
  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceRoleKey) throw new Error('manage-settings runtime settings are required');
  const cors = corsPolicyFromEnvironment(Deno.env.get('NARRATIVE_ADMIN_ORIGINS'));
  Deno.serve((request) => {
    const token = bearerToken(request) ?? '';
    return createManageSettingsHandler(createSupabaseManageSettingsDependencies({ url, anonKey, serviceRoleKey }, token), cors)(request);
  });
}
