-- Constrain the scheduler to the daily/weekly grammar implemented by the Edge dispatcher.
alter table public.schedules
  add column schedule_type text not null default 'automatic',
  alter column cron_expression drop not null;

-- Migration 010 represented manual schedules with a sentinel cron value.
update public.schedules
set schedule_type = 'manual', cron_expression = null
where cron_expression = 'manual';

-- Keep unsupported legacy expressions available for an operator to correct, but
-- prevent them from running under grammar the dispatcher does not implement.
update public.schedules
set enabled = false
where schedule_type = 'automatic'
  and (
    cron_expression is null
    or cron_expression !~ '^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) [*] [*] ([*]|[0-6])$'
  );

alter table public.schedules
  add constraint schedules_schedule_type_check check (schedule_type in ('automatic', 'manual')),
  add constraint schedules_supported_cron_check check (
    (schedule_type = 'manual' and cron_expression is null)
    or
    (
      schedule_type = 'automatic'
      and cron_expression is not null
      and (
        not enabled
        or cron_expression ~ '^([0-9]|[1-5][0-9]) ([0-9]|1[0-9]|2[0-3]) [*] [*] ([*]|[0-6])$'
      )
    )
  ) not valid;

alter table public.schedules
  validate constraint schedules_supported_cron_check;

-- Separate Vault materialization from transport so lookup and argument wiring
-- can be verified without issuing an HTTP request.
create function narrative_private.schedule_dispatch_material()
returns table(url text, body jsonb, headers jsonb)
language plpgsql
security definer
set search_path = ''
as $$
declare
  dispatcher_url text;
  dispatcher_token text;
begin
  select decrypted_secret into dispatcher_url
  from vault.decrypted_secrets where name = 'narrative_schedule_dispatch_url';
  select decrypted_secret into dispatcher_token
  from vault.decrypted_secrets where name = 'narrative_schedule_dispatch_token';
  if dispatcher_url is null or dispatcher_token is null then
    raise exception 'schedule_dispatch_runtime_not_configured' using errcode = 'P0001';
  end if;
  return query select dispatcher_url, jsonb_build_object('action', 'dispatch'),
    jsonb_build_object('content-type', 'application/json', 'x-schedule-dispatch-token', dispatcher_token);
end;
$$;

revoke all on function narrative_private.schedule_dispatch_material()
  from public, anon, authenticated, service_role;

create or replace function narrative_private.invoke_schedule_dispatcher()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare dispatch_request record;
begin
  select material.* into dispatch_request
  from narrative_private.schedule_dispatch_material() as material;
  perform net.http_post(
    url := dispatch_request.url,
    body := dispatch_request.body,
    headers := dispatch_request.headers
  );
end;
$$;

revoke all on function narrative_private.invoke_schedule_dispatcher()
  from public, anon, authenticated, service_role;
