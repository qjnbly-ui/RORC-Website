-- Clears stuck thermostat state in Supabase without deleting history.
--
-- Use this when the app shows Heat/AC as "Currently On" even though the
-- visible records are complete or the Turn Off/Set Temp controls cannot find
-- an active thermostat record.
--
-- What this does:
-- - closes any open thermostat records by setting end_at to start_at/created_at
--   so the billing trigger calculates $0 for the cleanup close
-- - marks every affected record as Off
-- - clears stale timer fields
-- - cancels pending/processing heater_on/heater_off automation jobs for those rows
--
-- Run the whole file in the Supabase SQL editor.

create temp table if not exists thermostat_cleanup_targets (
  id uuid primary key
) on commit drop;

truncate table thermostat_cleanup_targets;

insert into thermostat_cleanup_targets (id)
select id
from public.heater_use_entries
where
  end_at is null
  or turn_heater_on <> 'Off'::public.heater_state
on conflict do nothing;

select
  'before_cleanup' as phase,
  hue.id,
  hue.system_type,
  hue.turn_heater_on,
  hue.start_at,
  hue.end_at,
  hue.set_a_timer,
  hue.timer_start,
  hue.timer_stop,
  hue.responsible_member_id,
  am.member_name
from public.heater_use_entries hue
left join public.account_members am on am.id = hue.responsible_member_id
where hue.id in (select id from thermostat_cleanup_targets)
order by hue.start_at desc nulls last, hue.created_at desc;

-- Close open rows at their start time so this reset does not create a real
-- usage charge from a stale multi-day duration.
update public.heater_use_entries hue
set
  end_at = coalesce(hue.start_at, hue.created_at, now()),
  turn_heater_on = 'Off'::public.heater_state,
  set_a_timer = false,
  timer_start = null,
  timer_stop = null,
  note = concat_ws(
    E'\n',
    nullif(hue.note, ''),
    'System cleanup: reset stuck thermostat state.'
  )
where hue.id in (select id from thermostat_cleanup_targets)
  and hue.end_at is null;

-- Normalize rows that already had an end_at but still carried stale "On" or
-- timer state. This does not touch end_at, so the existing protected end time
-- is preserved.
update public.heater_use_entries hue
set
  turn_heater_on = 'Off'::public.heater_state,
  set_a_timer = false,
  timer_start = null,
  timer_stop = null,
  note = concat_ws(
    E'\n',
    nullif(hue.note, ''),
    'System cleanup: reset stale completed thermostat state.'
  )
where hue.id in (select id from thermostat_cleanup_targets)
  and hue.end_at is not null
  and hue.turn_heater_on <> 'Off'::public.heater_state;

update public.automation_jobs job
set
  job_status = 'canceled'::public.automation_job_status,
  updated_at = now()
where job.kind in ('heater_on'::public.automation_job_kind, 'heater_off'::public.automation_job_kind)
  and job.job_status in ('pending'::public.automation_job_status, 'processing'::public.automation_job_status)
  and job.payload ->> 'heater_use_entry_id' in (
    select id::text from thermostat_cleanup_targets
  );

select
  'after_cleanup_remaining_problem_rows' as phase,
  hue.id,
  hue.system_type,
  hue.turn_heater_on,
  hue.start_at,
  hue.end_at,
  hue.set_a_timer,
  hue.timer_start,
  hue.timer_stop,
  hue.responsible_member_id,
  am.member_name
from public.heater_use_entries hue
left join public.account_members am on am.id = hue.responsible_member_id
where
  hue.end_at is null
  or hue.turn_heater_on <> 'Off'::public.heater_state
order by hue.start_at desc nulls last, hue.created_at desc;
