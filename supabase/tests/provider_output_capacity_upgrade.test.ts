import { spawn } from 'node:child_process';

const root = process.cwd();
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

const owner = 'c2800000-0000-0000-0000-000000000001';
const provider = 'c2810000-0000-0000-0000-000000000001';

try {
  await run('npx', ['supabase', 'db', 'reset', '--local', '--yes', '--version', '202608170027', '--no-seed']);
  await psql(`
insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, created_at, updated_at)
values ('${owner}', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
  'provider-capacity-upgrade@local.invalid', '', now(), now(), now());
insert into public.owner_profiles (owner_id, display_name) values ('${owner}', 'provider capacity upgrade');
insert into public.provider_settings (
  id, owner_id, provider_key, enabled, configuration, model_key,
  max_input_tokens, max_output_tokens, max_revision_output_tokens,
  input_cost_micros_per_million, output_cost_micros_per_million, fixed_cost_micros, pricing_verified_at
) values (
  '${provider}', '${owner}', 'openai', true, '{}', 'gpt-5-mini',
  4000, 4000, 2000, 250000, 2000000, 0, public.narrative_business_date(current_timestamp)
);
`);

  await run('npx', ['supabase', 'migration', 'up', '--local']);
  const result = (await psql(`
select version from supabase_migrations.schema_migrations order by version desc limit 1;
select concat(max_input_tokens, '|', max_output_tokens, '|', max_revision_output_tokens)
from public.provider_settings where id = '${provider}';
`)).trim().split(/\r?\n/);

  if (result[0] !== '202608170028' || result[1] !== '4000|8000|2000') {
    throw new Error(`027→028 did not expand the existing GPT-5 mini output capacity\n${result.join('\n')}`);
  }
  console.log('PASS: actual 027→028 upgrade expands existing GPT-5 mini output capacity without changing input or revision limits.');
} finally {
  await run('npx', ['supabase', 'db', 'reset', '--local', '--yes']);
}
