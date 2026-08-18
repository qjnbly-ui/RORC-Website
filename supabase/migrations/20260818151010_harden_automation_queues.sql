-- Retire queue producers that have no worker. Their real actions are already
-- performed synchronously by the heater and rental APIs.
drop trigger if exists trg_enqueue_heater_insert_automation on public.heater_use_entries;
drop trigger if exists trg_enqueue_heater_end_automation on public.heater_use_entries;
drop function if exists public.enqueue_heater_automation();

drop trigger if exists trg_enqueue_rental_request_notification on public.rental_requests;
drop function if exists public.enqueue_rental_request_notification();

-- The authoritative occupancy trigger handles opening/closing. Unauthorized
-- entries remain recorded by admin_alerts instead of entering a dead SMS queue.
drop trigger if exists trg_enqueue_timesheet_insert_automation on public.timesheet_entries;
drop function if exists public.enqueue_timesheet_insert_automation();

update public.automation_jobs
set
  job_status = 'canceled',
  last_error = 'Canceled during queue cleanup: this legacy job kind has no worker.'
where kind in ('heater_on', 'heater_off', 'admin_sms')
  and job_status in ('pending', 'processing');

-- An expired lease is safe to retry only if no external side effect had begun.
create or replace function public.claim_facility_automation_job()
returns setof public.automation_jobs
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed_id uuid;
begin
  update public.automation_jobs
  set
    job_status = 'failed',
    last_error = 'Worker lease expired during an external action; manual review is required to avoid a duplicate.'
  where kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
    and job_status = 'processing'
    and updated_at < now() - interval '5 minutes'
    and nullif(payload ->> 'in_flight_step', '') is not null;

  update public.automation_jobs
  set
    job_status = 'pending',
    run_after = now(),
    last_error = 'Recovered before any external action began.'
  where kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
    and job_status = 'processing'
    and updated_at < now() - interval '5 minutes'
    and nullif(payload ->> 'in_flight_step', '') is null
    and attempts < 3;

  update public.automation_jobs
  set
    job_status = 'failed',
    last_error = coalesce(last_error, 'Worker lease expired after the retry limit.')
  where kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
    and job_status = 'processing'
    and updated_at < now() - interval '5 minutes'
    and attempts >= 3;

  update public.automation_jobs older
  set job_status = 'canceled', last_error = 'Superseded by a newer facility occupancy transition.'
  where older.kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
    and older.job_status = 'pending'
    and exists (
      select 1 from public.automation_jobs newer
      where newer.kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
        and coalesce((newer.payload ->> 'transition_version')::bigint, 0)
          > coalesce((older.payload ->> 'transition_version')::bigint, 0)
    );

  select job.id into claimed_id
  from public.automation_jobs job
  where job.kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
    and job.job_status = 'pending'
    and job.run_after <= now()
  order by coalesce((job.payload ->> 'transition_version')::bigint, 0) desc, job.created_at asc
  for update skip locked
  limit 1;

  if claimed_id is null then return; end if;

  return query
  update public.automation_jobs job
  set job_status = 'processing', attempts = job.attempts + 1, last_error = null
  where job.id = claimed_id and job.job_status = 'pending'
  returning job.*;
end;
$$;

revoke execute on function public.claim_facility_automation_job() from public, anon, authenticated;
grant execute on function public.claim_facility_automation_job() to service_role;

-- Atomically claim scheduled work. Stale processing jobs are deliberately not
-- retried because SMS and in-app delivery providers do not offer a shared
-- transaction with Postgres.
create or replace function public.claim_scheduled_member_message()
returns setof public.scheduled_member_messages
language plpgsql
security invoker
set search_path = ''
as $$
declare
  claimed_id uuid;
begin
  update public.scheduled_member_messages
  set
    status = 'failed',
    last_error = 'Worker lease expired; not retried automatically to avoid duplicate delivery.'
  where status = 'processing'
    and updated_at < now() - interval '15 minutes';

  select message.id into claimed_id
  from public.scheduled_member_messages message
  where message.status = 'scheduled'
    and message.scheduled_for <= now()
  order by message.scheduled_for asc, message.created_at asc
  for update skip locked
  limit 1;

  if claimed_id is null then return; end if;

  return query
  update public.scheduled_member_messages message
  set status = 'processing', last_error = null
  where message.id = claimed_id and message.status = 'scheduled'
  returning message.*;
end;
$$;

revoke execute on function public.claim_scheduled_member_message() from public, anon, authenticated;
grant execute on function public.claim_scheduled_member_message() to service_role;
grant select, update on table public.scheduled_member_messages to service_role;

drop index if exists public.idx_scheduled_member_messages_due;
create index if not exists idx_scheduled_member_messages_due
  on public.scheduled_member_messages (scheduled_for, created_at)
  where status = 'scheduled';

comment on function public.claim_scheduled_member_message() is
  'Atomically claims one due scheduled message for the service-role worker.';
