-- A failed focused revision must never strand an existing draft in `queued`.
-- The immutable source version remains the review target, while unrelated new
-- generation failures keep their existing queue semantics.
create function narrative_private.restore_reviewable_draft_after_failed_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if coalesce(new.generation_mode, new.worker_generation_mode, new.payload ->> 'mode') <> 'revise_selection'
    or new.draft_id is null
    or new.source_draft_version_id is null
    or exists (
      select 1
      from public.draft_versions as produced
      where produced.generation_job_id = new.id
    )
    or not exists (
      select 1
      from public.draft_versions as source
      where source.id = new.source_draft_version_id
        and source.owner_id = new.owner_id
        and source.draft_id = new.draft_id
        and source.version_number = (
          select max(latest.version_number)
          from public.draft_versions as latest
          where latest.owner_id = new.owner_id
            and latest.draft_id = new.draft_id
        )
    )
    or exists (
      select 1
      from public.generation_jobs as active
      where active.owner_id = new.owner_id
        and active.draft_id = new.draft_id
        and active.id <> new.id
        and active.status in ('queued', 'running')
    ) then
    return new;
  end if;

  update public.drafts
  set status = 'reviewing', updated_at = now()
  where id = new.draft_id
    and owner_id = new.owner_id
    and status in ('queued', 'generating');

  return new;
end;
$$;

create trigger generation_failure_restores_revision_review
after update of status on public.generation_jobs
for each row
when (old.status is distinct from new.status and new.status = 'failed')
execute function narrative_private.restore_reviewable_draft_after_failed_revision();

-- Repair rows stranded before this invariant existed, including the current
-- production draft that exposed the issue.
update public.drafts as draft
set status = 'reviewing', updated_at = now()
from public.generation_jobs as failed
where failed.owner_id = draft.owner_id
  and failed.draft_id = draft.id
  and failed.status = 'failed'
  and coalesce(failed.generation_mode, failed.worker_generation_mode, failed.payload ->> 'mode') = 'revise_selection'
  and failed.source_draft_version_id is not null
  and draft.status in ('queued', 'generating')
  and not exists (
    select 1 from public.draft_versions as produced
    where produced.generation_job_id = failed.id
  )
  and exists (
    select 1
    from public.draft_versions as source
    where source.id = failed.source_draft_version_id
      and source.owner_id = failed.owner_id
      and source.draft_id = failed.draft_id
      and source.version_number = (
        select max(latest.version_number)
        from public.draft_versions as latest
        where latest.owner_id = failed.owner_id
          and latest.draft_id = failed.draft_id
      )
  )
  and not exists (
    select 1
    from public.generation_jobs as active
    where active.owner_id = failed.owner_id
      and active.draft_id = failed.draft_id
      and active.id <> failed.id
      and active.status in ('queued', 'running')
  );

revoke all on function narrative_private.restore_reviewable_draft_after_failed_revision()
from public, anon, authenticated, service_role;
