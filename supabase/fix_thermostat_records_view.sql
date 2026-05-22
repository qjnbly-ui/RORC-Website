-- Repairs heater_use_entries_with_duration after adding Heat/AC columns.
-- Run this if Supabase reports:
-- ERROR 42P16: cannot change name of view column "run_hours" to "system_type"

alter table public.heater_use_entries
  add column if not exists system_type text not null default 'heat',
  add column if not exists target_temperature_f integer;

alter table public.heater_use_entries
  drop constraint if exists heater_use_entries_system_type_check,
  add constraint heater_use_entries_system_type_check check (system_type in ('heat', 'ac'));

create index if not exists idx_heater_use_entries_system_type
  on public.heater_use_entries (system_type, start_at desc);

drop view if exists public.heater_use_entries_with_duration;
create view public.heater_use_entries_with_duration
with (security_invoker = true) as
select
  hue.*,
  case
    when hue.start_at is null or hue.end_at is null then null
    else extract(epoch from (hue.end_at - hue.start_at)) / 3600
  end as run_hours
from public.heater_use_entries hue;

grant select on public.heater_use_entries_with_duration to anon, authenticated, service_role;
