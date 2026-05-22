-- Adds heat/AC distinction to thermostat records.
-- Run in Supabase before deploying AC thermostat usage.

alter table public.heater_use_entries
  add column if not exists system_type text not null default 'heat',
  add column if not exists target_temperature_f integer;

alter table public.heater_use_entries
  drop constraint if exists heater_use_entries_system_type_check,
  add constraint heater_use_entries_system_type_check check (system_type in ('heat', 'ac'));

create index if not exists idx_heater_use_entries_system_type
  on public.heater_use_entries (system_type, start_at desc);

create or replace function public.bill_heater_use_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  heat_rate_cents_per_hour integer := 1300;
  ac_rate_cents_per_hour integer := 200;
  applied_rate_cents_per_hour integer;
  total_cents integer;
  participant_count integer;
  base_cents integer;
  extra_cents integer;
  reason_text text;
  participant record;
begin
  if new.start_at is null or new.end_at is null then
    return new;
  end if;

  reason_text := case
    when coalesce(new.system_type, 'heat') = 'ac' then 'AC use'
    else 'Heater use'
  end;
  applied_rate_cents_per_hour := case
    when coalesce(new.system_type, 'heat') = 'ac' then ac_rate_cents_per_hour
    else heat_rate_cents_per_hour
  end;

  total_cents := greatest(
    0,
    ceiling((extract(epoch from (new.end_at - new.start_at)) / 3600.0) * applied_rate_cents_per_hour)::integer
  );

  if total_cents = 0 then
    return new;
  end if;

  if new.group_pay then
    select count(*)
    into participant_count
    from public.heater_use_group_members
    where heater_use_entry_id = new.id;

    if participant_count = 0 then
      insert into public.admin_alerts (alert_kind, account_member_id, context)
      values (
        'heater_group_pay_without_members',
        new.responsible_member_id,
        jsonb_build_object('heater_use_entry_id', new.id)
      );
      return new;
    end if;

    base_cents := total_cents / participant_count;
    extra_cents := total_cents % participant_count;

    for participant in
      select
        account_member_id,
        row_number() over (order by added_at, account_member_id) as participant_index
      from public.heater_use_group_members
      where heater_use_entry_id = new.id
    loop
      insert into public.billing_line_items (
        account_member_id,
        heater_use_entry_id,
        amount_cents,
        reason
      ) values (
        participant.account_member_id,
        new.id,
        base_cents + case when participant.participant_index <= extra_cents then 1 else 0 end,
        reason_text || ' group share'
      )
      on conflict do nothing;
    end loop;
  elsif new.responsible_member_id is not null then
    insert into public.billing_line_items (
      account_member_id,
      heater_use_entry_id,
      amount_cents,
      reason
    ) values (
      new.responsible_member_id,
      new.id,
      total_cents,
      reason_text
    )
    on conflict do nothing;
  end if;

  return new;
end;
$$;
