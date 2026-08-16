import { z } from 'zod';
import { catalogModels, type ProviderCatalogKey } from '../../../shared/narrative/provider-catalog.ts';
import { bearerToken } from '../_shared/auth.ts';
import { corsGate, corsPolicyFromEnvironment, createCorsPolicy, withCorsHeaders, type CorsPolicy } from '../_shared/cors.ts';

export type SecretKind = 'openai' | 'anthropic' | 'github';
export interface SecretWriteCommand { authToken: string; kind: SecretKind; value: string }
export interface ModelCatalogResult {
  providerKey: ProviderCatalogKey;
  configured: boolean;
  live: boolean;
  connectionIssue?: 'invalid_key' | 'temporarily_unavailable';
  models: Array<{
    id: string; label: string; description: string;
    quality: 'standard' | 'high'; speed: 'fast' | 'balanced'; cost: 'low' | 'medium' | 'high';
    recommended: boolean; availability: 'available' | 'unverified';
    maxInputTokens: number; maxOutputTokens: number; maxRevisionOutputTokens: number;
    inputPriceMicrosPerMillion: number; outputPriceMicrosPerMillion: number; pricingVerifiedAt: string;
  }>;
}
export interface ManageSettingsDependencies {
  authenticateOwner(token: string): Promise<{ ownerId: string }>;
  storeSecret(input: { ownerId: string; kind: SecretKind; value: string }): Promise<boolean>;
  listModels(input: { ownerId: string; providerKey: ProviderCatalogKey }): Promise<ModelCatalogResult>;
  deleteSecret(input: { ownerId: string; kind: SecretKind }): Promise<{ configured: false; generationPaused: boolean }>;
}
export interface SupabaseManageSettingsConfig {
  url: string; anonKey: string; serviceRoleKey: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
export class ManageSettingsError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); this.name = 'ManageSettingsError'; }
}

const commandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('write-secret'), kind: z.enum(['openai', 'anthropic', 'github']), value: z.string().trim().min(1).max(20_000) }).strict(),
  z.object({ action: z.literal('list-models'), providerKey: z.enum(['openai', 'anthropic']) }).strict(),
  z.object({ action: z.literal('delete-secret'), kind: z.enum(['openai', 'anthropic', 'github']) }).strict(),
]);

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
      const owner = await deps.authenticateOwner(token);
      let value: unknown;
      try { value = await request.json(); } catch { throw new ManageSettingsError(400, 'invalid_command'); }
      const parsed = commandSchema.safeParse(value);
      if (!parsed.success) throw new ManageSettingsError(400, 'invalid_command');
      if (parsed.data.action === 'write-secret') {
        const configured = await deps.storeSecret({ ownerId: owner.ownerId, kind: parsed.data.kind, value: parsed.data.value });
        if (configured !== true) throw new ManageSettingsError(500, 'internal_error');
        return respond(Response.json({ configured: true }));
      }
      if (parsed.data.action === 'list-models') {
        return respond(Response.json(await deps.listModels({ ownerId: owner.ownerId, providerKey: parsed.data.providerKey })));
      }
      return respond(Response.json(await deps.deleteSecret({ ownerId: owner.ownerId, kind: parsed.data.kind })));
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

function serializeModels(providerKey: ProviderCatalogKey, liveIds: readonly string[] | null): ModelCatalogResult['models'] {
  return catalogModels(providerKey, liveIds).map((entry) => ({
    id: entry.id, label: entry.label, description: entry.description,
    quality: entry.quality, speed: entry.speed, cost: entry.cost,
    recommended: entry.recommended, availability: entry.availability,
    maxInputTokens: entry.maxInputTokens, maxOutputTokens: entry.maxOutputTokens,
    maxRevisionOutputTokens: entry.maxRevisionOutputTokens,
    inputPriceMicrosPerMillion: entry.inputPriceMicrosPerMillion,
    outputPriceMicrosPerMillion: entry.outputPriceMicrosPerMillion,
    pricingVerifiedAt: entry.verifiedAt,
  }));
}

async function requestJson(request: typeof globalThis.fetch, url: string, init: RequestInit, timeoutMs: number) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ManageSettingsError(504, 'upstream_timeout'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await request(url, { ...init, signal: controller.signal });
        const value = response.status === 204 ? null : await response.json().catch(() => null);
        return { response, value };
      })(),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createSupabaseManageSettingsDependencies(config: SupabaseManageSettingsConfig, authToken: string): ManageSettingsDependencies {
  const request = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const userHeaders = { apikey: config.anonKey, authorization: `Bearer ${authToken}`, 'content-type': 'application/json' };
  const serviceHeaders = { apikey: config.serviceRoleKey, authorization: `Bearer ${config.serviceRoleKey}`, 'content-type': 'application/json' };
  const call = async (headers: Record<string, string>, path: string, init: RequestInit = {}): Promise<unknown> => {
    let response: Response;
    let value: unknown;
    try {
      ({ response, value } = await requestJson(request, `${config.url}${path}`, { ...init, headers: { ...headers, ...init.headers } }, timeoutMs));
    } catch {
      throw new ManageSettingsError(500, 'internal_error');
    }
    if (!response.ok) {
      if (path === '/auth/v1/user' && (response.status === 401 || response.status === 403)) throw new ManageSettingsError(401, 'authentication_required');
      throw new ManageSettingsError(response.status === 401 || response.status === 403 ? response.status : 500,
        response.status === 403 ? 'owner_access_required' : 'internal_error');
    }
    return value;
  };
  const fallback = (providerKey: ProviderCatalogKey, configured: boolean, connectionIssue?: ModelCatalogResult['connectionIssue']): ModelCatalogResult => ({
    providerKey, configured, live: false,
    ...(connectionIssue ? { connectionIssue } : {}),
    models: serializeModels(providerKey, null),
  });

  return {
    authenticateOwner: async () => {
      const user = record(await call(userHeaders, '/auth/v1/user'));
      if (typeof user?.id !== 'string' || !user.id) throw new ManageSettingsError(401, 'authentication_required');
      const owners = await call(userHeaders, `/rest/v1/owner_profiles?select=owner_id&owner_id=eq.${encodeURIComponent(user.id)}`);
      const rows = Array.isArray(owners) ? owners : [];
      if (rows.length !== 1 || (rows[0] as { owner_id?: unknown })?.owner_id !== user.id) throw new ManageSettingsError(403, 'owner_access_required');
      return { ownerId: user.id };
    },
    storeSecret: async (input) => {
      const value = await call(serviceHeaders, '/rest/v1/rpc/store_narrative_secret', {
        method: 'POST', body: JSON.stringify({ p_owner_id: input.ownerId, p_secret_kind: input.kind, p_secret_value: input.value }),
      });
      return value === true;
    },
    listModels: async ({ ownerId, providerKey }) => {
      const secret = await call(serviceHeaders, '/rest/v1/rpc/read_narrative_secret', {
        method: 'POST', body: JSON.stringify({ p_owner_id: ownerId, p_secret_kind: providerKey }),
      });
      if (typeof secret !== 'string' || !secret.trim()) return fallback(providerKey, false);
      const providerUrl = providerKey === 'openai'
        ? 'https://api.openai.com/v1/models'
        : 'https://api.anthropic.com/v1/models?limit=100';
      const providerHeaders: Record<string, string> = providerKey === 'openai'
        ? { accept: 'application/json', authorization: `Bearer ${secret}` }
        : { accept: 'application/json', 'x-api-key': secret, 'anthropic-version': '2023-06-01' };
      try {
        const { response, value } = await requestJson(request, providerUrl, { method: 'GET', headers: providerHeaders }, timeoutMs);
        if (response.status === 401 || response.status === 403) return fallback(providerKey, true, 'invalid_key');
        if (!response.ok) return fallback(providerKey, true, 'temporarily_unavailable');
        const payload = record(value);
        if (!Array.isArray(payload?.data)) return fallback(providerKey, true, 'temporarily_unavailable');
        const ids = payload.data.flatMap((item) => {
          const row = item && typeof item === 'object' ? item as Record<string, unknown> : null;
          return typeof row?.id === 'string' && row.id ? [row.id] : [];
        });
        return { providerKey, configured: true, live: true, models: serializeModels(providerKey, ids) };
      } catch {
        return fallback(providerKey, true, 'temporarily_unavailable');
      }
    },
    deleteSecret: async ({ ownerId, kind }) => {
      const value = record(await call(serviceHeaders, '/rest/v1/rpc/delete_narrative_secret', {
        method: 'POST', body: JSON.stringify({ p_owner_id: ownerId, p_secret_kind: kind }),
      }));
      if (value?.configured !== false || typeof value.generationPaused !== 'boolean') throw new ManageSettingsError(500, 'internal_error');
      return { configured: false, generationPaused: value.generationPaused };
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
