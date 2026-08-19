-- VoiceMonkey v3 uses bearer authentication and device IDs. Remove the retired
-- v2 webhook URLs, which embedded obsolete credentials in configuration data.
update public.automation_settings
set config = config
  - 'step1_url'
  - 'step2_url'
  - 'half_lights_step2_url'
  - 'manual_half_lights_off_url'
where id in ('gym_lights_on', 'gym_lights_off');
