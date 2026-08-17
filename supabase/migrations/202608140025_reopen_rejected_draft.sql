-- Let the registered owner resume work on an exact rejected draft version.

create function public.reopen_rejected_draft(p_draft_id uuid, p_expected_version_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  locked_draft public.drafts;
  locked_version public.draft_versions;
begin
  if auth.role() is distinct from 'authenticated' or auth.uid() is null then
    raise exception 'reopen caller is not authorized' using errcode = '42501';
  end if;

  select draft.* into locked_draft
  from public.drafts as draft
  where draft.id = p_draft_id
  for update;

  if locked_draft.id is null or locked_draft.owner_id is distinct from auth.uid() then
    raise exception 'reopen target not found' using errcode = 'P0002';
  end if;

  select version.* into locked_version
  from public.draft_versions as version
  where version.id = p_expected_version_id
    and version.owner_id = locked_draft.owner_id
    and version.draft_id = locked_draft.id
    and version.version_number = (
      select max(latest.version_number)
      from public.draft_versions as latest
      where latest.owner_id = locked_draft.owner_id
        and latest.draft_id = locked_draft.id
    )
  for update;

  if locked_draft.status is distinct from 'rejected' or locked_version.id is null then
    raise exception 'stale_reopen' using errcode = 'P0001';
  end if;

  update public.drafts
  set status = 'reviewing', updated_at = now()
  where id = locked_draft.id and status = 'rejected';

  insert into public.audit_events (owner_id, event_type, entity_type, entity_id, payload)
  values (
    locked_draft.owner_id,
    'draft_review_reopened',
    'draft',
    locked_draft.id,
    jsonb_build_object('versionId', locked_version.id, 'previousState', 'rejected', 'restoredState', 'reviewing')
  );

  return jsonb_build_object('status', 'reviewing');
end;
$$;

revoke all on function public.reopen_rejected_draft(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.reopen_rejected_draft(uuid, uuid) to authenticated;
