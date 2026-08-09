do $$
begin
  if (
    select count(*)
    from public.heater_use_entries
    where end_at is null
      and turn_heater_on = 'On'::public.heater_state
  ) > 1 then
    raise exception 'Cannot enforce thermostat mutual exclusion while multiple active runtimes exist.';
  end if;
end
$$;

create unique index if not exists idx_heater_use_entries_one_active_thermostat
  on public.heater_use_entries ((true))
  where end_at is null
    and turn_heater_on = 'On'::public.heater_state;

drop index if exists public.idx_heater_use_entries_one_active_per_system;
