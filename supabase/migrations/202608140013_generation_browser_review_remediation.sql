-- Browser owners need exactly one state mutation before the guarded review
-- transaction: submit the latest generated version for review.  Ownership,
-- current state, and version currency are all derived under row locks.
create function public.submit_draft_for_review(
  p_draft_id uuid,
  p_expected_version_id uuid,
  p_expected_state text
)
returns public.drafts
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_draft public.drafts;
  locked_version public.draft_versions;
  submitted_draft public.drafts;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'review submission caller is not authorized' using errcode = '42501';
  end if;
  if p_draft_id is null or p_expected_version_id is null or p_expected_state is distinct from 'generated' then
    raise exception 'invalid_review_submission' using errcode = '22023';
  end if;

  select draft.* into locked_draft
  from public.drafts as draft
  where draft.id = p_draft_id
  for update;

  if locked_draft.id is null or locked_draft.owner_id is distinct from auth.uid() then
    raise exception 'review target not found' using errcode = 'P0002';
  end if;
  if locked_draft.status is distinct from p_expected_state then
    raise exception 'stale_review_submission' using errcode = 'P0001';
  end if;

  select version.* into locked_version
  from public.draft_versions as version
  where version.id = p_expected_version_id
    and version.owner_id = locked_draft.owner_id
    and version.draft_id = locked_draft.id
    and version.version_number = (
      select max(latest.version_number)
      from public.draft_versions as latest
      where latest.draft_id = locked_draft.id
        and latest.owner_id = locked_draft.owner_id
    )
  for update;

  if locked_version.id is null then
    raise exception 'stale_review_submission' using errcode = 'P0001';
  end if;

  update public.drafts
  set status = 'reviewing', updated_at = now()
  where id = locked_draft.id
    and owner_id = locked_draft.owner_id
    and status = 'generated'
  returning * into submitted_draft;

  if submitted_draft.id is null then
    raise exception 'stale_review_submission' using errcode = 'P0001';
  end if;
  return submitted_draft;
end;
$$;

revoke all on function public.submit_draft_for_review(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.submit_draft_for_review(uuid, uuid, text)
  to authenticated;
