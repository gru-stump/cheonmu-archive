import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const draftId = randomUUID();
const versionId = randomUUID();

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
insert into public.drafts (id, owner_id, kind, title)
values ('${draftId}', '10000000-0000-0000-0000-000000000001', 'daily_event', 'concurrent review');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content)
values ('${versionId}', '10000000-0000-0000-0000-000000000001', '${draftId}', 1, '{"body":"concurrent body"}');
update public.drafts set status = 'reviewing' where id = '${draftId}';
`);
if (setup.code !== 0) throw new Error(`review concurrency setup failed\n${setup.stdout}\n${setup.stderr}`);

let releaseSecond;
const firstReviewed = new Promise((resolve) => { releaseSecond = resolve; });
const first = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.review_draft_atomic('${draftId}', '${versionId}', 'reviewing', 'approve_public', null, 'concurrent-first-${draftId}');
\\echo FIRST_REVIEWED
select pg_sleep(2);
commit;
`, (stdout) => { if (stdout.includes('FIRST_REVIEWED')) releaseSecond(); });

await Promise.race([
  firstReviewed,
  first.then((result) => {
    if (result.code !== 0) throw new Error(`first review failed before holding its lock\n${result.stdout}\n${result.stderr}`);
    throw new Error('first review exited before reporting that it held the draft lock');
  }),
]);
const second = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.review_draft_atomic('${draftId}', '${versionId}', 'reviewing', 'approve_public', null, 'concurrent-second-${draftId}');
commit;
`);

const [firstResult, secondResult] = await Promise.all([first, second]);
if (firstResult.code !== 0) throw new Error(`first review failed\n${firstResult.stdout}\n${firstResult.stderr}`);
if (secondResult.code === 0 || !secondResult.stderr.includes('stale_review')) {
  throw new Error(`second review did not lose the optimistic race\n${secondResult.stdout}\n${secondResult.stderr}`);
}

const verification = await runPsql(`
select concat(
  (select count(*) from public.draft_review_actions where draft_id = '${draftId}'), ',',
  (select count(*) from public.memory_items where source_draft_version_id = '${versionId}'), ',',
  (select count(*) from public.publish_jobs where draft_version_id = '${versionId}'), ',',
  (select status from public.drafts where id = '${draftId}')
);
`);
if (verification.code !== 0 || !verification.stdout.includes('1,1,1,approved')) {
  throw new Error(`unexpected concurrent review state\n${verification.stdout}\n${verification.stderr}`);
}
console.log('PASS: concurrent public approvals serialize; one atomic review, continuity write, and publish job survive.');
