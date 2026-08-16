type ServerConfig = { supabaseUrl: string; supabaseAnonKey: string; fetch?: typeof globalThis.fetch };

const conflicts = new Set([
  'stale_review', 'stale_review_submission', 'stale_manual_version', 'stale_revision', 'stale_archive', 'stale_restore', 'stale_publish_retry',
  'blocked_version_reject_only', 'revision_cost_changed', 'duplicate_review', 'version_not_approvable', 'duplicate_generation',
  'fixed_canon_read_only', 'stale_memory', 'stale_provider_pricing', 'automation_disabled',
  'budget_limit_below_committed', 'duplicate_schedule_key', 'active_provider_setting_required',
  'publication_in_progress', 'publication_queue_busy', 'publication_idempotency_mismatch',
  'publication_not_approved', 'publication_attempt_mismatch', 'publication_already_finalized', 'publication_not_configured',
]);

function bearer(request: Request): string | null {
  const match = /^Bearer ([^\s]+)$/.exec(request.headers.get('authorization') ?? '');
  return match?.[1] ?? null;
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
}

function mapVersion(row: Record<string, unknown>) {
  const findings = Array.isArray(row.continuity_findings) ? row.continuity_findings : [];
  return {
    id: row.id, versionNumber: row.version_number, createdAt: row.created_at, content: row.content,
    contextVersionIds: row.context_version_ids ?? [], continuityLevel: row.continuity_level ?? null,
    continuityFindings: findings.map((finding) => {
      const value = finding as Record<string, unknown>;
      return { code: value.code, level: value.level, message: value.message, sourceIds: value.sourceIds ?? value.source_ids ?? [] };
    }),
  };
}

function mapPublication(row: Record<string, unknown> | undefined) {
  if (!row) return undefined;
  const owner = typeof row.repository_owner === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(row.repository_owner) ? row.repository_owner : '';
  const repository = typeof row.repository_name === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(row.repository_name) ? row.repository_name : '';
  const sha = typeof row.commit_sha === 'string' && /^[0-9a-f]{40}$/i.test(row.commit_sha) ? row.commit_sha.toLowerCase() : null;
  const workflowRunId = typeof row.workflow_run_id === 'number' && Number.isSafeInteger(row.workflow_run_id) && row.workflow_run_id > 0 ? row.workflow_run_id : null;
  const deploymentId = typeof row.pages_deployment_id === 'number' && Number.isSafeInteger(row.pages_deployment_id) && row.pages_deployment_id > 0 ? row.pages_deployment_id : null;
  const phaseValues = new Set(['commit_created', 'workflow_running', 'workflow_succeeded', 'workflow_failed', 'pages_running', 'pages_failed', 'deployed', 'tracking_timed_out']);
  const trackingValues = new Set(['pending', 'observing', 'completed', 'timed_out']);
  const observationValues = new Set(['pending', 'queued', 'in_progress', 'success', 'failure', 'timed_out']);
  const phase = typeof row.publication_phase === 'string' && phaseValues.has(row.publication_phase) ? row.publication_phase : 'commit_created';
  const trackingStatus = typeof row.tracking_status === 'string' && trackingValues.has(row.tracking_status) ? row.tracking_status : 'pending';
  const workflowStatus = typeof row.workflow_status === 'string' && observationValues.has(row.workflow_status) ? row.workflow_status : 'pending';
  const pagesStatus = typeof row.pages_status === 'string' && observationValues.has(row.pages_status) ? row.pages_status : 'pending';
  let pagesUrl: string | null = null;
  if (owner && repository && typeof row.pages_url === 'string') {
    try {
      const candidate = new URL(row.pages_url);
      const host = `${owner.toLowerCase()}.github.io`;
      const path = repository.toLowerCase() === host ? '/' : `/${repository}/`;
      if (candidate.protocol === 'https:' && candidate.hostname === host && !candidate.port && !candidate.username && !candidate.password
        && !candidate.search && !candidate.hash && candidate.pathname.toLowerCase().startsWith(path.toLowerCase())) pagesUrl = candidate.href;
    } catch { /* Unsafe deployment metadata is omitted. */ }
  }
  return {
    phase, trackingStatus, repositoryOwner: owner, repositoryName: repository,
    commit: {
      status: row.status === 'published' && sha ? 'created' : row.status === 'failed' ? 'failed' : 'pending',
      sha,
      url: owner && repository && sha ? `https://github.com/${owner}/${repository}/commit/${sha}` : null,
    },
    workflow: {
      status: workflowStatus, runId: workflowRunId,
      url: owner && repository && workflowRunId ? `https://github.com/${owner}/${repository}/actions/runs/${workflowRunId}` : null,
    },
    pages: { status: pagesStatus, deploymentId, url: pagesUrl },
  };
}

export function createNarrativeHandler({ supabaseUrl, supabaseAnonKey, fetch = globalThis.fetch }: ServerConfig) {
  const base = supabaseUrl.replace(/\/$/, '');
  return async (request: Request): Promise<Response> => {
    const token = bearer(request);
    if (!token) return json({ error: 'authentication_required' }, 401);
    const headers = { apikey: supabaseAnonKey, authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const upstream = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init.headers } });
      const value = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok) {
        const message = typeof value.message === 'string' ? value.message : typeof value.error === 'string' ? value.error : 'upstream_error';
        const stable = conflicts.has(message) && (value.code === 'P0001' || response.status === 409);
        throw { status: stable ? 409 : response.status === 401 || response.status === 403 ? response.status : response.status === 402 ? 402 : 500, code: stable ? message : response.status === 401 ? 'authentication_required' : response.status === 402 ? 'budget_blocked' : 'request_failed' };
      }
      return value;
    };
    const rpc = (name: string, body: Record<string, unknown>) => upstream(`/rest/v1/rpc/${name}`, { method: 'POST', body: JSON.stringify(body) });
    const body = async () => request.json().catch(() => null) as Promise<Record<string, unknown> | null>;

    try {
      const user = await upstream('/auth/v1/user');
      if (typeof user.id !== 'string' || !user.id) throw { status: 401, code: 'authentication_required' };
      const owners = await upstream(`/rest/v1/owner_profiles?select=owner_id&owner_id=eq.${encodeURIComponent(user.id)}`) as unknown as Array<{ owner_id?: string }>;
      if (owners.length !== 1 || owners[0]?.owner_id !== user.id) throw { status: 403, code: 'owner_access_required' };
      const url = new URL(request.url);
      const path = url.pathname.replace(/^\/api\/narrative\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);

      if (request.method === 'GET' && path.join('/') === 'dashboard') return json(await rpc('get_narrative_dashboard', {}));
      if (request.method === 'GET' && path.join('/') === 'memory') return json(await rpc('get_narrative_memory', {}));
      if (request.method === 'GET' && path.join('/') === 'schedules') return json(await rpc('get_narrative_schedules', {}));
      if (request.method === 'GET' && path.join('/') === 'settings') return json(await rpc('get_narrative_settings', {}));
      if (request.method === 'GET' && path.length === 1 && path[0] === 'drafts') {
        const status = url.searchParams.get('status');
        const filter = status === 'active' ? '&status=not.in.(archived)' : status ? `&status=eq.${encodeURIComponent(status)}` : '';
        const rows = await upstream(`/rest/v1/drafts?select=id,kind,status,title,updated_at&order=updated_at.desc${filter}`) as unknown as Array<Record<string, unknown>>;
        const versions = await upstream('/rest/v1/draft_versions?select=id,draft_id,version_number,continuity_level&order=version_number.desc') as unknown as Array<Record<string, unknown>>;
        const latest = new Map<string, Record<string, unknown>>();
        for (const version of versions) if (!latest.has(String(version.draft_id))) latest.set(String(version.draft_id), version);
        return json({ drafts: rows.map((row) => ({ id: row.id, kind: row.kind, status: row.status, title: row.title, updatedAt: row.updated_at, latestVersionId: latest.get(String(row.id))?.id ?? null, continuityLevel: latest.get(String(row.id))?.continuity_level ?? null })) });
      }
      if (request.method === 'GET' && path.length === 2 && path[0] === 'drafts') {
        const draftRows = await upstream(`/rest/v1/drafts?select=id,kind,status,title,updated_at&id=eq.${encodeURIComponent(path[1]!)}`) as unknown as Array<Record<string, unknown>>;
        const draft = draftRows[0]; if (!draft) return json({ error: 'draft_not_found' }, 404);
        const rows = await upstream(`/rest/v1/draft_versions?select=id,version_number,created_at,content,context_version_ids,continuity_level,continuity_findings&draft_id=eq.${encodeURIComponent(path[1]!)}&order=version_number.asc`) as unknown as Array<Record<string, unknown>>;
        if (!rows.length) return json({ error: 'draft_version_not_found' }, 404);
        const versions = rows.map(mapVersion); const latestVersion = versions[versions.length - 1]!;
        const settings = await upstream('/rest/v1/provider_settings?select=max_input_tokens,max_revision_output_tokens,input_cost_micros_per_million,output_cost_micros_per_million,fixed_cost_micros&enabled=eq.true') as unknown as Array<Record<string, unknown>>;
        const setting = settings.length === 1 ? settings[0] : undefined;
        const publicationSelect = encodeURIComponent('id,draft_id,draft_version_id,status,repository_owner,repository_name,commit_sha,publication_phase,tracking_status,workflow_status,workflow_run_id,pages_status,pages_deployment_id,pages_url');
        const publicationRows = await upstream(`/rest/v1/publish_jobs?select=${publicationSelect}&draft_id=eq.${encodeURIComponent(path[1]!)}&draft_version_id=eq.${encodeURIComponent(String(latestVersion.id))}&limit=2`) as unknown as Array<Record<string, unknown>>;
        const publication = publicationRows.length === 1 ? mapPublication(publicationRows[0]) : undefined;
        return json({ id: draft.id, kind: draft.kind, status: draft.status, title: draft.title, latestVersionId: latestVersion.id, latestVersion, versions, ...(publication ? { publication } : {}), ...(setting ? { revisionPricing: { maximumInputTokens: setting.max_input_tokens, maximumRevisionOutputTokens: setting.max_revision_output_tokens, inputCostMicrosPerMillion: setting.input_cost_micros_per_million, outputCostMicrosPerMillion: setting.output_cost_micros_per_million, fixedCostMicros: setting.fixed_cost_micros } } : {}) });
      }
      if (request.method === 'POST' && path.join('/') === 'generate') {
        const command = await body(); if (!command) return json({ error: 'invalid_command' }, 400);
        if (command.mode !== 'revise_selection') return json({ error: 'unsupported_generation_mode' }, 400);
        const revision = command.revision as Record<string, unknown> | undefined;
        if (!command.maximumCostConfirmed || !revision || !Number.isSafeInteger(command.requestedMaxOutputTokens) || !Number.isSafeInteger(command.confirmedMaximumCostMicros)) return json({ error: 'revision_confirmation_required' }, 400);
        if (command.expectedState === 'generated') await rpc('submit_draft_for_review', { p_draft_id: command.draftId, p_expected_version_id: command.expectedVersionId, p_expected_state: 'generated' });
        const queued = await rpc('queue_draft_revision', {
          p_draft_id: command.draftId, p_expected_version_id: command.expectedVersionId,
          p_selected_text: revision.selectedText, p_instruction: revision.instruction,
          p_requested_max_output_tokens: command.requestedMaxOutputTokens, p_confirmed_maximum_cost_micros: command.confirmedMaximumCostMicros,
        });
        command.jobId = queued.job_id; command.idempotencyKey = queued.idempotency_key; command.draftId = queued.draft_id; command.kind = queued.kind;
        delete command.expectedVersionId; delete command.expectedState; delete command.maximumCostConfirmed; delete command.confirmedMaximumCostMicros;
        return json(await upstream('/functions/v1/generate-draft', { method: 'POST', body: JSON.stringify(command) }));
      }
      if (request.method === 'POST' && path.length === 3 && path[0] === 'memory') {
        const input = await body();
        if (!input || input.memoryId !== path[1]) return json({ error: 'invalid_command' }, 400);
        if (path[2] === 'enabled' && typeof input.enabled === 'boolean') {
          return json(await rpc('set_narrative_memory_enabled', { p_memory_id: input.memoryId, p_enabled: input.enabled }));
        }
        if (path[2] === 'corrections' && typeof input.content === 'string' && typeof input.note === 'string') {
          return json(await rpc('correct_narrative_memory', { p_memory_id: input.memoryId, p_content: input.content, p_note: input.note }));
        }
        return json({ error: 'invalid_command' }, 400);
      }
      if (request.method === 'POST' && path[0] === 'schedules' && path.length <= 2) {
        const input = await body();
        if (!input || (path[1] && input.scheduleId !== path[1])) return json({ error: 'invalid_command' }, 400);
        return json(await rpc('save_narrative_schedule', {
          p_schedule_id: input.scheduleId ?? null,
          p_schedule_key: input.scheduleKey,
          p_schedule_type: input.scheduleType,
          p_enabled: input.enabled,
          p_seoul_time: input.seoulTime,
          p_weekday: input.weekday ?? null,
          p_special_date: input.specialDate ?? null,
          p_minimum_interval_minutes: input.minimumIntervalMinutes,
          p_kind: input.kind,
        }));
      }
      if (request.method === 'POST' && path.join('/') === 'settings') {
        const input = await body(); if (!input) return json({ error: 'invalid_command' }, 400);
        return json(await rpc('save_narrative_settings', {
          p_automation_enabled: input.automationEnabled,
          p_active_provider_key: input.activeProviderKey ?? null,
          p_provider_updates: input.providers,
          p_monthly_limit_micros: input.monthlyLimitMicros,
          p_daily_limit_micros: input.dailyLimitMicros,
          p_manual_call_limit: input.manualCallLimit,
          p_warning_threshold_percent: input.warningThresholdPercent,
          p_risk_threshold_percent: input.riskThresholdPercent,
          p_krw_per_usd: input.krwPerUsd,
          p_pricing_valid_days: input.pricingValidDays,
        }));
      }
      if (request.method === 'POST' && path.join('/') === 'settings/secret') {
        const input = await body();
        if (!input || !['openai', 'anthropic', 'github'].includes(String(input.kind)) || typeof input.value !== 'string' || !input.value.trim()) {
          return json({ error: 'invalid_command' }, 400);
        }
        const result = await upstream('/functions/v1/manage-settings', { method: 'POST', body: JSON.stringify({ kind: input.kind, value: input.value }) });
        return json({ configured: result.configured === true });
      }
      if (request.method === 'POST' && path.length === 3 && path[0] === 'drafts') {
        const input = await body(); if (!input || input.draftId !== path[1]) return json({ error: 'invalid_command' }, 400);
        if (path[2] === 'manual-version') {
          if (input.expectedState === 'generated') await rpc('submit_draft_for_review', { p_draft_id: input.draftId, p_expected_version_id: input.expectedVersionId, p_expected_state: 'generated' });
          const version = await rpc('save_manual_draft_version', { p_draft_id: input.draftId, p_expected_version_id: input.expectedVersionId, p_expected_state: 'reviewing', p_content: input.content });
          return json({ version: mapVersion(version) });
        }
        if (path[2] === 'archive') {
          if (!['generated', 'reviewing', 'rejected', 'approved_private', 'publish_failed'].includes(String(input.expectedState))) return json({ error: 'invalid_archive_state' }, 400);
          return json(await rpc('archive_narrative_draft', { p_draft_id: input.draftId, p_expected_version_id: input.expectedVersionId, p_expected_state: input.expectedState }));
        }
        if (path[2] === 'restore') {
          if (typeof input.expectedVersionId !== 'string' || !input.expectedVersionId) return json({ error: 'invalid_restore_command' }, 400);
          return json(await rpc('restore_narrative_draft', { p_draft_id: input.draftId, p_expected_version_id: input.expectedVersionId }));
        }
        if (path[2] === 'retry-publish') {
          if (input.expectedState !== 'publish_failed' || typeof input.expectedVersionId !== 'string' || !input.expectedVersionId) {
            return json({ error: 'invalid_publish_retry' }, 400);
          }
          const select = encodeURIComponent('id,draft_id,draft_version_id,idempotency_key,status');
          const jobs = await upstream(`/rest/v1/publish_jobs?select=${select}&draft_id=eq.${encodeURIComponent(input.draftId)}&draft_version_id=eq.${encodeURIComponent(input.expectedVersionId)}&status=eq.failed&limit=2`) as unknown as Array<Record<string, unknown>>;
          const job = jobs.length === 1 ? jobs[0] : undefined;
          if (!job || job.draft_id !== input.draftId || job.draft_version_id !== input.expectedVersionId || job.status !== 'failed') {
            return json({ error: 'publication_target_not_found' }, 404);
          }
          if (typeof job.id !== 'string' || !job.id || typeof job.idempotency_key !== 'string' || !job.idempotency_key) {
            return json({ error: 'publication_not_retriable' }, 409);
          }
          return json(await upstream('/functions/v1/publish-draft', {
            method: 'POST',
            body: JSON.stringify({ publishJobId: job.id, expectedVersionId: job.draft_version_id, idempotencyKey: job.idempotency_key }),
          }));
        }
        if (path[2] === 'review') {
          if (input.expectedState === 'generated') await rpc('submit_draft_for_review', { p_draft_id: input.draftId, p_expected_version_id: input.expectedVersionId, p_expected_state: 'generated' });
          const command = { draftId: input.draftId, expectedVersionId: input.expectedVersionId, expectedState: 'reviewing', idempotencyKey: crypto.randomUUID(), action: input.action, ...(input.reason ? { reason: input.reason } : {}) };
          return json(await upstream('/functions/v1/review-draft', { method: 'POST', body: JSON.stringify(command) }));
        }
      }
      return json({ error: 'not_found' }, 404);
    } catch (error) {
      const value = error as { status?: number; code?: string };
      return json({ error: value.code ?? 'internal_error' }, value.status ?? 500);
    }
  };
}
