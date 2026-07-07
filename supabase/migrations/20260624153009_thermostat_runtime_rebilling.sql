create or replace function public.bill_heater_use_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  heat_rate_cents_per_hour integer := 1300;
  ac_standard_rate_cents_per_hour integer := 200;
  ac_bulk_rate_cents_per_hour integer := 150;
  ac_bulk_threshold_hours numeric := 8;
  applied_rate_cents_per_hour integer;
  runtime_hours numeric;
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

  if exists (
    select 1
    from public.billing_line_items
    where heater_use_entry_id = new.id
      and (
        payment_recorded_at is not null
        or posted_to_stripe_at is not null
        or stripe_invoice_id is not null
      )
  ) then
    return new;
  end if;

  runtime_hours := extract(epoch from (new.end_at - new.start_at)) / 3600.0;
  reason_text := case
    when coalesce(new.system_type, 'heat') = 'ac' then 'AC use'
    else 'Heater use'
  end;
  applied_rate_cents_per_hour := case
    when coalesce(new.system_type, 'heat') = 'ac' and runtime_hours > ac_bulk_threshold_hours then ac_bulk_rate_cents_per_hour
    when coalesce(new.system_type, 'heat') = 'ac' then ac_standard_rate_cents_per_hour
    else heat_rate_cents_per_hour
  end;

  total_cents := greatest(
    0,
    ceiling(runtime_hours * applied_rate_cents_per_hour)::integer
  );

  delete from public.billing_line_items
  where heater_use_entry_id = new.id
    and payment_recorded_at is null
    and posted_to_stripe_at is null
    and stripe_invoice_id is null;

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

drop trigger if exists trg_bill_heater_use_entry on public.heater_use_entries;
create trigger trg_bill_heater_use_entry
after insert or update of start_at, end_at, system_type, group_pay, responsible_member_id on public.heater_use_entries
for each row
when (new.end_at is not null)
execute function public.bill_heater_use_entry();
