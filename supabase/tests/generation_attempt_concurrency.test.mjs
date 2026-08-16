import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const draftId = randomUUID();
const jobId = randomUUID();
const winnerToken = randomUUID();
const loserToken = randomUUID();

function runPsql(sql, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; onStdout?.(stdout); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(sql);
  });
}

const setup = await runPsql(`
update public.provider_settings set enabled = true where id = '12000000-0000-0000-0000-000000000001';
insert into public.drafts (id, owner_id, kind, title)
values ('${draftId}', '10000000-0000-0000-0000-000000000001', 'daily_event', 'concurrent generation');
insert into public.generation_jobs (id, owner_id, draft_id, schedule_key, scheduled_for, payload)
values ('${jobId}', '10000000-0000-0000-0000-000000000001', '${draftId}', 'attempt-${jobId}', '2026-08-15T00:00:00Z',
  '{"source":"schedule","budgetPolicy":"block_at_risk","kind":"daily_event"}');
`);
if (setup.code !== 0) throw new Error(`attempt concurrency setup failed\n${setup.stdout}\n${setup.stderr}`);

const freezeSql = (token) => `select public.freeze_generation_context(
  '${jobId}', '${draftId}', 'new', 'concurrent-key-${jobId}',
  array['15000000-0000-0000-0000-000000000001'],
  '[{"versionId":"15000000-0000-0000-0000-000000000001","memoryType":"canon","content":"frozen","tokenCount":1}]',
  '12000000-0000-0000-0000-000000000001', '${token}'
);`;

let signalWinner;
const winnerFrozen = new Promise((resolve) => { signalWinner = resolve; });
const winner = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
${freezeSql(winnerToken)}
\\echo WINNER_FROZEN
select pg_sleep(2);
commit;
`, (stdout) => { if (stdout.includes('WINNER_FROZEN')) signalWinner(); });

await Promise.race([
  winnerFrozen,
  winner.then((result) => {
    if (result.code !== 0) throw new Error(`winner failed before holding its lock\n${result.stdout}\n${result.stderr}`);
    throw new Error('winner exited before reporting that it held the job lock');
  }),
]);
const loser = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
${freezeSql(loserToken)}
commit;
`);
const [winnerResult, loserResult] = await Promise.all([winner, loser]);
if (winnerResult.code !== 0) throw new Error(`winner freeze failed\n${winnerResult.stdout}\n${winnerResult.stderr}`);
if (loserResult.code === 0 || !loserResult.stderr.includes('duplicate_generation')) {
  throw new Error(`second freeze did not lose the race\n${loserResult.stdout}\n${loserResult.stderr}`);
}

const cleanup = await runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.abort_generation_attempt('${jobId}', '${loserToken}', 'concurrent-key-${jobId}', 'freeze_failed');
reset role;
commit;
select concat(attempt_token, ',', idempotency_key, ',', status) from public.generation_jobs where id = '${jobId}';
`);
if (cleanup.code !== 0 || !cleanup.stdout.includes('"outcome": "stale"') || !cleanup.stdout.includes(`${winnerToken},concurrent-key-${jobId},queued`)) {
  throw new Error(`loser cleanup mutated the winner\n${cleanup.stdout}\n${cleanup.stderr}`);
}
console.log('PASS: concurrent duplicate freeze cleanup is scoped to the losing attempt and preserves the winner.');
