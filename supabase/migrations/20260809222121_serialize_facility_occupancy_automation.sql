create schema if not exists app_private;

create table if not exists app_private.facility_occupancy_state (
  singleton boolean primary key default true check (singleton),
  is_occupied boolean not null,
  transition_version bigint not null default 0 check (transition_version >= 0),
  last_transition_at timestamptz not null default now()
);

revoke all on table app_private.facility_occupancy_state
from public, anon, authenticated;
grant usage on schema app_private to service_role;
grant select on table app_private.facility_occupancy_state to service_role;

insert into app_private.facility_occupancy_state (singleton, is_occupied)
select
  true,
  exists (
    select 1
    from public.timesheet_entries entry
    where entry.signed_out_at is null
      and (
        (
          entry.member_or_guest = 'Member'
          and public.is_sign_in_authorized(entry.member_id, entry.signed_in_at)
        )
        or (
          entry.member_or_guest = 'Guest'
          and public.is_sign_in_authorized(entry.member_entered_with_id, entry.signed_in_at)
          and (
            entry.day_pass_or_open_gym = 'Open Gym'
            or public.member_can_bring_guests(entry.member_entered_with_id)
          )
        )
      )
  )
on conflict (singleton) do nothing;

create or replace function public.enqueue_timesheet_insert_automation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  is_authorized boolean;
begin
  is_authorized := (
    new.member_or_guest = 'Member'
    and public.is_sign_in_authorized(new.member_id, new.signed_in_at)
  ) or (
    new.member_or_guest = 'Guest'
    and public.is_sign_in_authorized(new.member_entered_with_id, new.signed_in_at)
    and (
      new.day_pass_or_open_gym = 'Open Gym'
      or public.member_can_bring_guests(new.member_entered_with_id)
    )
  );

  if not is_authorized then
    insert into public.automation_jobs (kind, payload)
    values (
      'admin_sms',
      jsonb_build_object(
        'timesheet_entry_id', new.id,
        'member_or_guest', new.member_or_guest,
        'member_id', new.member_id,
        'guest_name', new.guest_name,
        'member_entered_with_id', new.member_entered_with_id,
        'signed_in_at', new.signed_in_at
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enqueue_timesheet_sign_out_automation on public.timesheet_entries;
drop function if exists public.enqueue_timesheet_sign_out_automation();

create or replace function app_private.enqueue_facility_occupancy_transition()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  was_occupied boolean;
  now_occupied boolean;
  next_version bigint;
  transition_entry public.timesheet_entries%rowtype;
  transition_member_name text;
begin
  select state.is_occupied
  into was_occupied
  from app_private.facility_occupancy_state state
  where state.singleton = true
  for update;

  if not found then
    raise exception 'Facility occupancy state is not initialized.';
  end if;

  select exists (
    select 1
    from public.timesheet_entries entry
    where entry.signed_out_at is null
      and (
        (
          entry.member_or_guest = 'Member'
          and public.is_sign_in_authorized(entry.member_id, entry.signed_in_at)
        )
        or (
          entry.member_or_guest = 'Guest'
          and public.is_sign_in_authorized(entry.member_entered_with_id, entry.signed_in_at)
          and (
            entry.day_pass_or_open_gym = 'Open Gym'
            or public.member_can_bring_guests(entry.member_entered_with_id)
          )
        )
      )
  ) into now_occupied;

  if now_occupied = was_occupied then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  update app_private.facility_occupancy_state
  set
    is_occupied = now_occupied,
    transition_version = transition_version + 1,
    last_transition_at = now()
  where singleton = true
  returning transition_version into next_version;

  if now_occupied then
    select entry.*
    into transition_entry
    from public.timesheet_entries entry
    where entry.signed_out_at is null
      and (
        (
          entry.member_or_guest = 'Member'
          and public.is_sign_in_authorized(entry.member_id, entry.signed_in_at)
        )
        or (
          entry.member_or_guest = 'Guest'
          and public.is_sign_in_authorized(entry.member_entered_with_id, entry.signed_in_at)
          and (
            entry.day_pass_or_open_gym = 'Open Gym'
            or public.member_can_bring_guests(entry.member_entered_with_id)
          )
        )
      )
    order by entry.signed_in_at asc, entry.id asc
    limit 1;
  else
    select entry.*
    into transition_entry
    from public.timesheet_entries entry
    where entry.signed_out_at is not null
    order by
      entry.signed_out_at desc,
      case when entry.member_or_guest = 'Member' then 0 else 1 end,
      entry.id asc
    limit 1;
  end if;

  select member.member_name
  into transition_member_name
  from public.account_members member
  where member.id = coalesce(
    transition_entry.member_id,
    transition_entry.member_entered_with_id
  );

  insert into public.automation_jobs (kind, payload)
  values (
    case
      when now_occupied then 'voice_monkey_sign_in'::public.automation_job_kind
      else 'voice_monkey_sign_out'::public.automation_job_kind
    end,
    jsonb_build_object(
      'transition_version', next_version,
      'timesheet_entry_id', transition_entry.id,
      'member_or_guest', transition_entry.member_or_guest,
      'member_id', transition_entry.member_id,
      'guest_name', transition_entry.guest_name,
      'member_entered_with_id', transition_entry.member_entered_with_id,
      'member_name', coalesce(
        case
          when transition_entry.member_or_guest = 'Guest' then transition_entry.guest_name
          else transition_member_name
        end,
        transition_member_name,
        'Unknown'
      ),
      'signed_in_at', transition_entry.signed_in_at,
      'signed_out_at', transition_entry.signed_out_at
    )
  );

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

alter function app_private.enqueue_facility_occupancy_transition() owner to postgres;
revoke execute on function app_private.enqueue_facility_occupancy_transition()
from public, anon, authenticated, service_role;

drop trigger if exists trg_enqueue_facility_occupancy_insert on public.timesheet_entries;
create trigger trg_enqueue_facility_occupancy_insert
after insert on public.timesheet_entries
for each row
execute function app_private.enqueue_facility_occupancy_transition();

drop trigger if exists trg_enqueue_facility_occupancy_sign_out on public.timesheet_entries;
create trigger trg_enqueue_facility_occupancy_sign_out
after update of signed_out_at on public.timesheet_entries
for each row
when (old.signed_out_at is distinct from new.signed_out_at)
execute function app_private.enqueue_facility_occupancy_transition();

drop trigger if exists trg_enqueue_facility_occupancy_delete on public.timesheet_entries;
create trigger trg_enqueue_facility_occupancy_delete
after delete on public.timesheet_entries
for each row
execute function app_private.enqueue_facility_occupancy_transition();

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
    job_status = 'pending',
    run_after = now(),
    last_error = 'Recovered after the previous worker lease expired.'
  where kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
    and job_status = 'processing'
    and updated_at < now() - interval '5 minutes'
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
  set
    job_status = 'canceled',
    last_error = 'Superseded by a newer facility occupancy transition.'
  where older.kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
    and older.job_status = 'pending'
    and exists (
      select 1
      from public.automation_jobs newer
      where newer.kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
        and coalesce((newer.payload ->> 'transition_version')::bigint, 0)
          > coalesce((older.payload ->> 'transition_version')::bigint, 0)
    );

  select job.id
  into claimed_id
  from public.automation_jobs job
  where job.kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
    and job.job_status = 'pending'
    and job.run_after <= now()
  order by
    coalesce((job.payload ->> 'transition_version')::bigint, 0) desc,
    job.created_at asc
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  return query
  update public.automation_jobs job
  set
    job_status = 'processing',
    attempts = job.attempts + 1,
    last_error = null
  where job.id = claimed_id
    and job.job_status = 'pending'
  returning job.*;
end;
$$;

create or replace function public.facility_automation_snapshot()
returns table (is_occupied boolean, transition_version bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select state.is_occupied, state.transition_version
  from app_private.facility_occupancy_state state
  where state.singleton = true;
$$;

revoke execute on function public.claim_facility_automation_job()
from public, anon, authenticated;
revoke execute on function public.facility_automation_snapshot()
from public, anon, authenticated;
grant execute on function public.claim_facility_automation_job() to service_role;
grant execute on function public.facility_automation_snapshot() to service_role;
grant select, update on table public.automation_jobs to service_role;

update public.automation_jobs
set
  job_status = 'canceled',
  last_error = 'Superseded when authoritative facility occupancy automation was enabled.'
where kind in ('voice_monkey_sign_in', 'voice_monkey_sign_out')
  and job_status in ('pending', 'processing')
  and not (payload ? 'transition_version');

comment on table app_private.facility_occupancy_state is
  'Singleton serialized state for authoritative first-in and last-out automation.';

comment on function public.claim_facility_automation_job() is
  'Atomically claims the newest due facility occupancy transition for the service-role worker.';
