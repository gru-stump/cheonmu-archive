import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const container = 'supabase_db_cheonmu-narrative';
const ownerId = '10000000-0000-0000-0000-000000000001';
const draftId = randomUUID();
const versionId = randomUUID();
const approvalId = randomUUID();
const publishJobId = randomUUID();
const firstAttempt = randomUUID();
const secondAttempt = randomUUID();
const key = `publication-race-${randomUUID()}`;

function runPsql(sql, onStdout) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
update public.narrative_admin_settings
set github_repository_owner = 'cheonmu-owner', github_repository_name = 'cheonmu-archive', github_branch = 'main'
where owner_id = '${ownerId}';
select set_config('request.jwt.claim.role', 'service_role', false);
set role service_role;
select public.store_narrative_secret('${ownerId}', 'github', 'publication-concurrency-fixture-value');
reset role;
insert into public.drafts (id, owner_id, kind, title)
values ('${draftId}', '${ownerId}', 'daily_event', 'publication race');
insert into public.draft_versions (id, owner_id, draft_id, version_number, content, continuity_level, continuity_policy_version)
values ('${versionId}', '${ownerId}', '${draftId}', 1,
  '{"title":"race","body":"race body","canonChangeCandidates":[],"unresolvedCallbacks":[],"publication":{"id":"race-record","recordNumber":"88","relationshipStage":7,"date":"2026-08-15","summary":"race","characters":["cheonryeong","muyeong"],"tags":["race"],"related":[],"quote":"race","archiveSnapshot":{"recordIds":[],"recordNumbers":[]}}}'::jsonb,
  'review', 'cheonmu-continuity-v1');
insert into public.draft_review_actions (id, owner_id, draft_id, draft_version_id, idempotency_key, action, expected_state, resulting_state)
values ('${approvalId}', '${ownerId}', '${draftId}', '${versionId}', 'approval-${approvalId}', 'approve_public', 'reviewing', 'approved');
update public.drafts set status = 'approved' where id = '${draftId}';
insert into public.publish_jobs (id, owner_id, draft_id, draft_version_id, status)
values ('${publishJobId}', '${ownerId}', '${draftId}', '${versionId}', 'queued');
`);
if (setup.code !== 0) throw new Error(`publication concurrency setup failed\n${setup.stdout}\n${setup.stderr}`);

let releaseSecond;
const firstClaimed = new Promise((resolve) => { releaseSecond = resolve; });
const first = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_narrative_publication('${ownerId}', '${publishJobId}', '${versionId}', '${key}', '${firstAttempt}') ->> 'outcome';
\\echo FIRST_PUBLICATION_CLAIMED
select pg_sleep(2);
commit;
`, (stdout) => { if (stdout.includes('FIRST_PUBLICATION_CLAIMED')) releaseSecond(); });

await Promise.race([
  firstClaimed,
  first.then((result) => {
    if (result.code !== 0) throw new Error(`first publication failed before holding its claim\n${result.stdout}\n${result.stderr}`);
    throw new Error('first publication exited before reporting its held claim');
  }),
]);

const second = runPsql(`
begin;
select set_config('request.jwt.claim.role', 'service_role', true);
set local role service_role;
select public.claim_narrative_publication('${ownerId}', '${publishJobId}', '${versionId}', '${key}', '${secondAttempt}') ->> 'outcome';
commit;
`);
const [firstResult, secondResult] = await Promise.all([first, second]);
if (firstResult.code !== 0 || !firstResult.stdout.includes('claimed')) {
  throw new Error(`first publication claim failed\n${firstResult.stdout}\n${firstResult.stderr}`);
}
if (secondResult.code === 0 || !secondResult.stderr.includes('publication_in_progress')) {
  throw new Error(`second publisher did not lose the same-key race\n${secondResult.stdout}\n${secondResult.stderr}`);
}

const verification = await runPsql(`
select concat(job.status, '|', draft.status, '|', job.attempt_count, '|', job.idempotency_key, '|', job.attempt_token)
from public.publish_jobs as job join public.drafts as draft on draft.id = job.draft_id
where job.id = '${publishJobId}';
`);
const expected = `publishing|publishing|1|${key}|${firstAttempt}`;
if (verification.code !== 0 || !verification.stdout.includes(expected)) {
  throw new Error(`publication race persisted an invalid state\n${verification.stdout}\n${verification.stderr}`);
}

console.log('PASS: two same-key publishers serialize at the advisory-lock claim and only one attempt reaches publishing.');
