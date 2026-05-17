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
  'enabled', true,
  'step1_url', 'https://api-v2.voicemonkey.io/announcement?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=stage-only-announcement&text=Welcome%20to%20the%20Ruth%20Oben%20Chain%20Recreation%20center.&chime=soundbank%3A%2F%2Fsoundlibrary%2Falarms%2Fbeeps_and_bloops%2Fintro_02&voice=Joanna',
  'step2_url', 'https://api-v2.voicemonkey.io/trigger?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=all-lights-on',
  'sms_to', '+15418916772'
)),
('gym_lights_off', jsonb_build_object(
  'enabled', true,
  'step1_url', 'https://api-v2.voicemonkey.io/announcement?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=front-door-announcement&text=%20Closing%20the%20gym%20now.%20Thank%20you%20for%20spending%20time%20with%20us.%20Please%20close%20the%20door%20when%20you%20exit.%20&chime=soundbank%3A%2F%2Fsoundlibrary%2Falarms%2Fbeeps_and_bloops%2Fintro_02&voice=Matthew&character_display=%20',
  'step2_url', 'https://api-v2.voicemonkey.io/trigger?token=1f3e0ed4c447604419dfed7d277cda79_90cb39a4dfc7ff4c222a54e3e93f4e80&device=close-the-gym',
  'sms_to', '+15418916772'
)),
('heater_on', jsonb_build_object('enabled', true)),
('heater_off', jsonb_build_object('enabled', true))
on conflict (id) do nothing;
