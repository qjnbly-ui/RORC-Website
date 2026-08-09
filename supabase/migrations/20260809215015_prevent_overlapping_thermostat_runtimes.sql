do $$
begin
  if exists (
    select 1
    from public.heater_use_entries
    where end_at is null
      and turn_heater_on = 'On'::public.heater_state
    group by system_type
    having count(*) > 1
  ) then
    raise exception 'Cannot enforce one active thermostat runtime per system while overlapping rows exist.';
  end if;
end
$$;

create unique index if not exists idx_heater_use_entries_one_active_per_system
  on public.heater_use_entries (system_type)
  where end_at is null
    and turn_heater_on = 'On'::public.heater_state;
