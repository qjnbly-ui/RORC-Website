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
  total_cents integer;
  participant_count integer;
  base_cents integer;
  extra_cents integer;
  participant record;
begin
  -- AC usage is tracked now but not billed yet.
  if coalesce(new.system_type, 'heat') <> 'heat' then
    return new;
  end if;

  if new.start_at is null or new.end_at is null then
    return new;
  end if;

  total_cents := greatest(
    0,
    ceiling((extract(epoch from (new.end_at - new.start_at)) / 3600.0) * 1300)::integer
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
        'Heater use group share'
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
      'Heater use'
    )
    on conflict do nothing;
  end if;

  return new;
end;
$$;
