create or replace function public.protect_heater_use_update()
returns trigger
language plpgsql
as $$
begin
  if old.end_at is not null
     and new.end_at is not null
     and old.end_at <> new.end_at
     and not public.is_admin() then
    raise exception 'Cannot overwrite an existing thermostat end time on thermostat use row %.', old.id;
  end if;

  return new;
end;
$$;
