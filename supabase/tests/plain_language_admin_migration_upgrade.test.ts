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
      cwd: root,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32' && file === command('npx'),
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

const historical = readdirSync(migrations)
  .filter((name) => /^2026081400(0[1-9]|1[0-9]|2[0-2])_.*\.sql$/.test(name))
  .sort();
const before = new Map(historical.map((name) => [
  name,
  createHash('sha256').update(readFileSync(join(migrations, name))).digest('hex'),
]));

const owner = 'c2200000-0000-0000-0000-000000000001';
const provider = 'c2210000-0000-0000-0000-000000000001';
const period = 'c2220000-0000-0000-0000-000000000001';
const queued = 'c2230000-0000-0000-0000-000000000001';
const completed = 'c2230000-0000-0000-0000-000000000002';
const failed = 'c2230000-0000-0000-0000-000000000003';

try {
  await run('npx', ['supabase', 'db', 'reset', '--local', '--yes', '--version', '202608140022', '--no-seed']);
  await psql(`
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('${owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'plain-language-upgrade@local.invalid', '', now(), now(), now());
insert into public.owner_profiles (owner_id, display_name) values ('${owner}', 'plain language upgrade');
insert into public.provider_settings (
  id, owner_id, provider_key, enabled, configuration, model_key,
  max_input_tokens, max_output_tokens, max_revision_output_tokens,
  input_cost_micros_per_million, output_cost_micros_per_million, fixed_cost_micros, pricing_verified_at
) values (
  '${provider}', '${owner}', 'openai', true,
  '{"vaultSecretName":"narrative_${owner}_openai"}', 'gpt-5-mini',
  8192, 2048, 512, 250000, 2000000, 0, public.narrative_business_date(current_timestamp)
);
insert into public.budget_periods (id, owner_id, currency, period_start, period_end, limit_micros, daily_limit_micros)
values ('${period}', '${owner}', 'USD', current_date - 1, current_date + 1, 100000000, 100000000);
insert into public.narrative_admin_settings (owner_id, manual_generation_enabled, schedule_automation_enabled, krw_per_usd)
values ('${owner}', true, true, 1380);
select vault.create_secret('fixture-value', 'narrative_${owner}_openai', 'plain language upgrade fixture');
insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, status, payload, worker_completed_at) values
  ('${queued}', '${owner}', 'upgrade-queued', now() + interval '1 hour', 'queued', '{"source":"access","kind":"short_dialogue","budgetPolicy":"block_at_risk"}', null),
  ('${completed}', '${owner}', 'upgrade-completed', now() - interval '2 hours', 'completed', '{"source":"access","kind":"short_dialogue","budgetPolicy":"block_at_risk"}', now() - interval '1 hour');
insert into public.generation_jobs (id, owner_id, schedule_key, scheduled_for, status, payload, failure_code, failure_at)
values ('${failed}', '${owner}', 'upgrade-failed', now() - interval '3 hours', 'failed',
  '{"source":"access","kind":"short_dialogue","budgetPolicy":"block_at_risk"}', 'provider_outcome_unknown', now() - interval '2 hours');
`);

  await run('npx', ['supabase', 'migration', 'up', '--local']);
  const result = await psql(`
select version from supabase_migrations.schema_migrations order by version desc limit 1;
begin;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '${owner}';
set local role authenticated;
select concat(public.quote_narrative_access_cost() ->> 'maximumCostMicros', '|', public.quote_narrative_access_cost() ->> 'maximumCostKrw');
select concat(
  count(*) filter (where item ? 'createdAt'), '|',
  count(*) filter (where item ->> 'completedAt' is not null), '|',
  count(*) filter (where item ->> 'failedAt' is not null)
) from jsonb_array_elements(public.get_narrative_dashboard() -> 'queue') item;
select public.cancel_queued_generation_job('${queued}') ->> 'status';
commit;
select concat(provider.enabled, '|', settings.manual_generation_enabled, '|', settings.schedule_automation_enabled, '|', provider.model_key)
from public.provider_settings as provider
join public.narrative_admin_settings as settings on settings.owner_id = provider.owner_id
where provider.id = '${provider}';
select count(*) from vault.secrets where name = 'narrative_${owner}_openai';
select concat(max_input_tokens, '|', max_output_tokens, '|', max_revision_output_tokens)
from public.provider_settings where id = '${provider}';
`);
  const lines = result.trim().split(/\r?\n/);
  if (lines.length !== 7
    || lines[0] !== '202608140023'
    || lines[1] !== '9000|12'
    || lines[2] !== '3|1|1'
    || lines[3] !== 'cancelled'
    || lines[4] !== 't|t|t|gpt-5-mini'
    || lines[5] !== '1'
    || lines[6] !== '4000|4000|2000') {
    throw new Error(`022→023 did not preserve settings/history or normalize the legacy GPT-5 mini limits\n${result}`);
  }

  for (const [name, hash] of before) {
    const after = createHash('sha256').update(readFileSync(join(migrations, name))).digest('hex');
    if (after !== hash) throw new Error(`historical migration changed during 022→023 upgrade test: ${name}`);
  }
  console.log('PASS: actual 022→023 upgrade preserves provider, budget, secret, and job history while normalizing legacy GPT-5 mini limits.');
} finally {
  await run('npx', ['supabase', 'db', 'reset', '--local', '--yes']);
}
