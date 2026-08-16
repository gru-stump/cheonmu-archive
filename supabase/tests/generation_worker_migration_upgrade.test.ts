import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const migrations = join(root, 'supabase', 'migrations');
const command = (name: string) => process.platform === 'win32' ? `${name}.cmd` : name;
type ProcessResult = { code: number | null; stdout: string; stderr: string };
function runProcess(file: string, args: string[], input?: string): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: root, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      shell: process.platform === 'win32' && file === command('npx'),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}
async function run(file: string, args: string[]) {
  const result = await runProcess(command(file), args);
  if (result.code !== 0) throw new Error(`${file} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
async function psql(sql: string) {
  const result = await runProcess('docker', ['exec', '-i', 'supabase_db_cheonmu-narrative', 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], sql);
  if (result.code !== 0) throw new Error(`psql failed\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

const historical = readdirSync(migrations).filter((name) => /^2026081400(0[1-9]|1[0-9])_.*\.sql$/.test(name)).sort();
const before = new Map(historical.map((name) => [name, createHash('sha256').update(readFileSync(join(migrations, name))).digest('hex')]));

try {
  await run('npx', ['supabase', 'db', 'reset', '--local', '--yes', '--version', '202608140019', '--no-seed']);
  const owner = 'b0200000-0000-0000-0000-000000000001';
  await psql(`
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('${owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'worker-upgrade@example.invalid', '', now(), now(), now());
insert into public.owner_profiles (owner_id, display_name) values ('${owner}', 'worker upgrade');
insert into public.narrative_admin_settings (owner_id, manual_generation_enabled, schedule_automation_enabled)
values ('${owner}', true, true);
insert into public.provider_settings (id, owner_id, provider_key, enabled, configuration, model_key, max_input_tokens, max_output_tokens,
  max_revision_output_tokens, input_cost_micros_per_million, output_cost_micros_per_million, fixed_cost_micros, pricing_verified_at)
values ('b0210000-0000-0000-0000-000000000001', '${owner}', 'fake-local-provider', true, '{"mode":"fixture"}', 'upgrade-model', 4096, 1024, 256, 0, 0, 0, public.narrative_business_date(current_timestamp));
insert into public.budget_periods (id, owner_id, period_start, period_end, currency, limit_micros, daily_limit_micros)
values ('b0220000-0000-0000-0000-000000000001', '${owner}', current_date - 1, current_date + 1, 'USD', 100000, 100000);
insert into public.drafts (id, owner_id, kind, status, title) values
  ('b0230000-0000-0000-0000-000000000001', '${owner}', 'daily_event', 'queued', 'queued'),
  ('b0230000-0000-0000-0000-000000000002', '${owner}', 'daily_event', 'queued', 'frozen'),
  ('b0230000-0000-0000-0000-000000000003', '${owner}', 'daily_event', 'queued', 'running'),
  ('b0230000-0000-0000-0000-000000000004', '${owner}', 'daily_event', 'queued', 'completed'),
  ('b0230000-0000-0000-0000-000000000005', '${owner}', 'daily_event', 'queued', 'failed');
alter table public.drafts disable trigger drafts_require_transition_rpc;
update public.drafts set status = 'generating' where id = 'b0230000-0000-0000-0000-000000000003';
update public.drafts set status = 'generated' where id = 'b0230000-0000-0000-0000-000000000004';
alter table public.drafts enable trigger drafts_require_transition_rpc;
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, status, payload, provider_setting_id) values
  ('b0240000-0000-0000-0000-000000000001', '${owner}', 'b0230000-0000-0000-0000-000000000001', 'upgrade-queued', now(), 'queued', '{"source":"manual","mode":"new","kind":"daily_event","manualRequestKey":"upgrade-queued"}', 'b0210000-0000-0000-0000-000000000001'),
  ('b0240000-0000-0000-0000-000000000002', '${owner}', 'b0230000-0000-0000-0000-000000000002', 'upgrade-frozen', now(), 'queued', '{"source":"manual","mode":"new","kind":"daily_event","manualRequestKey":"upgrade-frozen"}', 'b0210000-0000-0000-0000-000000000001'),
  ('b0240000-0000-0000-0000-000000000003', '${owner}', 'b0230000-0000-0000-0000-000000000003', 'upgrade-running', now(), 'running', '{"source":"manual","mode":"new","kind":"daily_event","manualRequestKey":"upgrade-running"}', 'b0210000-0000-0000-0000-000000000001'),
  ('b0240000-0000-0000-0000-000000000004', '${owner}', 'b0230000-0000-0000-0000-000000000004', 'upgrade-completed', now(), 'completed', '{"source":"manual","mode":"new","kind":"daily_event","manualRequestKey":"upgrade-completed"}', 'b0210000-0000-0000-0000-000000000001'),
  ('b0240000-0000-0000-0000-000000000005', '${owner}', 'b0230000-0000-0000-0000-000000000005', 'upgrade-failed', now(), 'failed', '{"source":"manual","mode":"new","kind":"daily_event","manualRequestKey":"upgrade-failed"}', 'b0210000-0000-0000-0000-000000000001');
update public.generation_jobs set idempotency_key = case id
    when 'b0240000-0000-0000-0000-000000000002' then 'upgrade-frozen'
    else 'upgrade-running' end,
  generation_mode = 'new', attempt_token = case id
    when 'b0240000-0000-0000-0000-000000000002' then 'b0250000-0000-4000-8000-000000000002'::uuid
    else 'b0250000-0000-4000-8000-000000000003'::uuid end,
  context_version_ids = array['upgrade-context'], context_snapshot = '[{"versionId":"upgrade-context","memoryType":"canon","content":"frozen","tokenCount":1}]',
  model_key = 'upgrade-model', max_input_tokens = 4096, max_output_tokens = 1024, max_revision_output_tokens = 256,
  input_cost_micros_per_million = 0, output_cost_micros_per_million = 0, fixed_cost_micros = 0, worst_case_cost_micros = 0
where id in ('b0240000-0000-0000-0000-000000000002', 'b0240000-0000-0000-0000-000000000003');
insert into public.budget_entries (owner_id, budget_period_id, generation_job_id, amount_micros, entry_type, daily_bucket_date, description)
values ('${owner}', 'b0220000-0000-0000-0000-000000000001', 'b0240000-0000-0000-0000-000000000003', 0, 'reservation', public.narrative_business_date(current_timestamp), 'upgrade running reservation');
`);

  await run('npx', ['supabase', 'migration', 'up', '--local']);
  const version = (await psql(`select version from supabase_migrations.schema_migrations order by version desc limit 1;`)).trim();
  if (version !== '202608140020') throw new Error(`expected migration 020, got ${version}`);
  const result = await psql(`
select concat(status, '|', coalesce(worker_failure_code, ''), '|', provider_dispatch_recorded_at is null, '|', worker_attempt_count)
from public.generation_jobs where id in (
  'b0240000-0000-0000-0000-000000000001', 'b0240000-0000-0000-0000-000000000002',
  'b0240000-0000-0000-0000-000000000003', 'b0240000-0000-0000-0000-000000000004',
  'b0240000-0000-0000-0000-000000000005'
) order by id;
select count(*) from public.generation_jobs where provider_dispatch_recorded_at is not null;
`);
  const lines = result.trim().split(/\r?\n/);
  if (lines.length !== 6
    || lines[0] !== 'queued||t|0'
    || lines[1] !== 'failed|worker_legacy_frozen|t|0'
    || lines[2] !== 'failed|worker_legacy_running|t|0'
    || lines[3] !== 'completed||t|0'
    || lines[4] !== 'failed||t|0'
    || lines[5] !== '0') {
    throw new Error(`019→020 did not migrate legacy states fail-closed without side-effect evidence\n${result}`);
  }
  for (const [name, hash] of before) {
    const after = createHash('sha256').update(readFileSync(join(migrations, name))).digest('hex');
    if (after !== hash) throw new Error(`historical migration changed during 019→020 upgrade test: ${name}`);
  }
  console.log('PASS: actual 019→020 upgrade fails legacy frozen/running rows closed, preserves terminal rows, fabricates no provider fence, and leaves migrations 001–019 unchanged.');
} finally {
  await run('npx', ['supabase', 'db', 'reset', '--local', '--yes']);
}
