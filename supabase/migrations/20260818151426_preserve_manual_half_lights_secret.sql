-- Preserve the manual half-light action before removing the source-code
-- fallback. Derive it inside the protected settings table so the credential is
-- never copied into this migration or application source.
update public.automation_settings
set config = jsonb_set(
  config,
  '{manual_half_lights_off_url}',
  to_jsonb(regexp_replace(
    config ->> 'step2_url',
    'device=[^&]+',
    'device=turn-half-the-lights-off'
  )),
  true
)
where id = 'gym_lights_on'
  and nullif(config ->> 'step2_url', '') is not null
  and nullif(config ->> 'manual_half_lights_off_url', '') is null;
