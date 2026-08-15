import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  runSchedules,
  type QueuedJob,
  type ScheduleDependencies,
  type ScheduleRecord,
} from '../functions/run-schedules/index.ts';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = '89000000-0000-0000-0000-000000000001';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runProcess(command: string, args: string[], input?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32' && command === npx,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function runPsql(sql: string): Promise<ProcessResult> {
  return runProcess('docker', [
    'exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-X', '-qAt', '-v', 'ON_ERROR_STOP=1',
  ], sql);
}

function failure(label: string, result: ProcessResult): Error {
  return new Error(`${label} (exit ${String(result.code)})\n${result.stdout}\n${result.stderr}`);
}

async function requireSuccess(label: string, resultPromise: Promise<ProcessResult>): Promise<ProcessResult> {
  const result = await resultPromise;
  if (result.code !== 0) throw failure(label, result);
  return result;
}

async function scalar(sql: string): Promise<string> {
  return (await requireSuccess('psql query failed', runPsql(sql))).stdout.trim();
}

async function resetTo(version?: string): Promise<void> {
  const args = ['supabase', 'db', 'reset', '--local', '--yes'];
  if (version) args.push('--version', version);
  await requireSuccess(`database reset${version ? ` to ${version}` : ''} failed`, runProcess(npx, args));
}

let headApplied = false;
let primaryError: unknown;

try {
  await requireSuccess(
    'database reset to migration 010 failed',
    runProcess(npx, ['supabase', 'db', 'reset', '--local', '--version', '202608140010', '--no-seed', '--yes']),
  );
  assert.equal(
    await scalar('select max(version) from supabase_migrations.schema_migrations;'),
    '202608140010',
    'upgrade fixture must begin at migration 010',
  );
  assert.equal(
    await scalar("select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'schedules' and column_name = 'schedule_type';"),
    '0',
    'migration 010 must not already contain the migration 011 discriminator',
  );

  await requireSuccess('legacy migration-010 fixture setup failed', runPsql(`
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) values (
  '00000000-0000-0000-0000-000000000000', '${ownerId}', 'authenticated', 'authenticated',
  'schedule-upgrade@local.invalid', '$2a$10$testfixturesonlynotarealcredential0000000000000000000000000',
  current_timestamp, '{"provider":"email","providers":["email"]}'::jsonb, '{}', current_timestamp, current_timestamp
);

insert into public.schedules (id, owner_id, schedule_key, cron_expression, enabled, payload) values
  ('89000000-0000-0000-0000-000000000011', '${ownerId}', 'legacy-manual', 'manual', true, '{"kind":"short_dialogue"}'::jsonb),
  ('89000000-0000-0000-0000-000000000012', '${ownerId}', 'legacy-unsupported', '*/15 9 * * *', true, '{"kind":"daily_event"}'::jsonb),
  ('89000000-0000-0000-0000-000000000013', '${ownerId}', 'legacy-daily', '0 9 * * *', true, '{"kind":"daily_event"}'::jsonb),
  ('89000000-0000-0000-0000-000000000014', '${ownerId}', 'legacy-weekly', '0 9 * * 1', true, '{"kind":"daily_event"}'::jsonb);
`));

  await requireSuccess(
    'migration 011 failed to upgrade legacy migration-010 schedules',
    runProcess(npx, ['supabase', 'migration', 'up', '--local', '--yes']),
  );
  headApplied = true;
  assert.equal(
    await scalar('select max(version) from supabase_migrations.schema_migrations;'),
    '202608140015',
    'upgrade fixture must apply migrations 011 through the admin settings workflow at current head',
  );
  assert.equal(
    await scalar("select concat(to_regprocedure('public.submit_draft_for_review(uuid,uuid,text)') is not null, '|', has_function_privilege('authenticated', 'public.submit_draft_for_review(uuid,uuid,text)', 'EXECUTE'), '|', not has_function_privilege('anon', 'public.submit_draft_for_review(uuid,uuid,text)', 'EXECUTE'));"),
    't|t|t',
    'upgrade must install the narrow authenticated review submission boundary without anonymous access',
  );
  assert.equal(
    await scalar("select concat(to_regprocedure('public.save_manual_draft_version(uuid,uuid,text,jsonb)') is not null, '|', has_function_privilege('authenticated', 'public.save_manual_draft_version(uuid,uuid,text,jsonb)', 'EXECUTE'), '|', not has_function_privilege('anon', 'public.save_manual_draft_version(uuid,uuid,text,jsonb)', 'EXECUTE'));"),
    't|t|t',
    'upgrade must install the narrow immutable manual-version boundary without anonymous access',
  );
  assert.equal(
    await scalar("select concat(to_regprocedure('public.save_narrative_settings(boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)') is not null, '|', has_function_privilege('authenticated', 'public.save_narrative_settings(boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)', 'EXECUTE'), '|', not has_function_privilege('anon', 'public.save_narrative_settings(boolean,text,jsonb,bigint,bigint,integer,integer,integer,numeric,integer)', 'EXECUTE'), '|', has_function_privilege('service_role', 'public.store_narrative_secret(uuid,text,text)', 'EXECUTE'), '|', not has_function_privilege('authenticated', 'public.store_narrative_secret(uuid,text,text)', 'EXECUTE'));"),
    't|t|t|t|t',
    'upgrade must install owner settings commands while keeping Vault writes service-only',
  );

  const rows = JSON.parse(await scalar(`
select coalesce(jsonb_agg(jsonb_build_object(
  'ownerId', owner_id,
  'scheduleKey', schedule_key,
  'scheduleType', schedule_type,
  'cronExpression', cron_expression,
  'enabled', enabled,
  'payload', payload
) order by schedule_key), '[]'::jsonb)::text
from public.schedules
where owner_id = '${ownerId}';
`)) as ScheduleRecord[];
  const byKey = new Map(rows.map((row) => [row.scheduleKey, row]));

  assert.deepEqual(byKey.get('legacy-manual'), {
    ownerId,
    scheduleKey: 'legacy-manual',
    scheduleType: 'manual',
    cronExpression: null,
    enabled: true,
    payload: { kind: 'short_dialogue' },
  });
  assert.deepEqual(byKey.get('legacy-unsupported'), {
    ownerId,
    scheduleKey: 'legacy-unsupported',
    scheduleType: 'automatic',
    cronExpression: '*/15 9 * * *',
    enabled: false,
    payload: { kind: 'daily_event' },
  });
  assert.equal(byKey.get('legacy-daily')?.enabled, true, 'valid legacy daily schedule must remain enabled');
  assert.equal(byKey.get('legacy-weekly')?.enabled, true, 'valid legacy weekly schedule must remain enabled');

  const queued: Array<Omit<QueuedJob, 'id'>> = [];
  const dependencies: ScheduleDependencies = {
    now: () => new Date('2026-08-17T00:00:00Z'),
    authenticate: async () => null,
    listSchedules: async () => rows,
    budgetState: async () => 'normal',
    insertQueuedJob: async (job) => {
      queued.push(job);
      return { id: `upgrade-job-${queued.length}`, ...job };
    },
    queueAccessJob: async () => { throw new Error('access scheduling is outside this upgrade test'); },
  };
  await runSchedules(dependencies);
  assert.deepEqual(
    queued.map((job) => job.scheduleKey),
    [`${ownerId}:legacy-daily:2026-08-17`, `${ownerId}:legacy-weekly:2026-08-17`],
    'only enabled supported automatic schedules may queue after upgrade',
  );

  const invalidEnable = await runPsql(`
update public.schedules set enabled = true
where owner_id = '${ownerId}' and schedule_key = 'legacy-unsupported';
`);
  assert.notEqual(invalidEnable.code, 0, 'unsupported legacy cron must not be re-enabled unchanged');
  assert.match(
    `${invalidEnable.stdout}\n${invalidEnable.stderr}`,
    /schedules_supported_cron_check/,
    'invalid re-enable must fail at the supported-cron constraint',
  );
  assert.equal(
    await scalar(`select concat(enabled, '|', cron_expression) from public.schedules where owner_id = '${ownerId}' and schedule_key = 'legacy-unsupported';`),
    'f|*/15 9 * * *',
    'failed re-enable must preserve the disabled legacy expression',
  );

  await requireSuccess('corrected legacy cron could not be enabled', runPsql(`
update public.schedules
set cron_expression = '15 9 * * *', enabled = true
where owner_id = '${ownerId}' and schedule_key = 'legacy-unsupported';
`));
  assert.equal(
    await scalar(`select concat(enabled, '|', cron_expression) from public.schedules where owner_id = '${ownerId}' and schedule_key = 'legacy-unsupported';`),
    't|15 9 * * *',
    'correcting the expression must permit re-enabling the schedule',
  );
} catch (error) {
  primaryError = error;
} finally {
  try {
    await resetTo(headApplied ? undefined : '202608140010');
  } catch (restoreError) {
    primaryError = new AggregateError(
      [primaryError, restoreError].filter((error) => error !== undefined),
      'schedule migration upgrade test and database restoration failed',
    );
  }
}

if (primaryError) throw primaryError;
console.log('PASS: migration 010 schedules upgrade safely through 011/current head, settings privileges stay narrow, and only supported enabled automatic rows queue.');
