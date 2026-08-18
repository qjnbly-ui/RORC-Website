create table if not exists public.automation_settings (
  id text primary key,
  config jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create or replace function public.set_automation_settings_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_automation_settings_updated_at on public.automation_settings;
create trigger trg_automation_settings_updated_at
before update on public.automation_settings
for each row
execute function public.set_automation_settings_updated_at();

insert into public.automation_settings (id, config)
values
('gym_lights_on', jsonb_build_object(
  'enabled', false,
  'sms_to', '+15418916772'
)),
('gym_lights_off', jsonb_build_object(
  'enabled', false,
  'sms_to', '+15418916772'
)),
('heater_on', jsonb_build_object('enabled', true)),
('heater_off', jsonb_build_object('enabled', true))
on conflict (id) do nothing;
