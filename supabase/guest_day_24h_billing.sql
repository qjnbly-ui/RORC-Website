create or replace function public.normalize_guest_day_name(value text)
returns text
language sql
immutable
as $$
  select nullif(regexp_replace(lower(btrim(coalesce(value, ''))), '\s+', ' ', 'g'), '');
$$;

create or replace function public.bill_guest_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  sponsor_account_id uuid;
  guest_day_count integer;
  used_free_guests integer;
  free_guests_remaining integer;
  billable_guest_count integer;
begin
  if new.member_or_guest <> 'Guest'
     or new.member_entered_with_id is null
     or new.day_pass_or_open_gym <> 'Day Pass' then
    return new;
  end if;

  select am.account_id
  into sponsor_account_id
  from public.account_members am
  where am.id = new.member_entered_with_id;

  if sponsor_account_id is null then
    return new;
  end if;

  with new_guest_names as (
    select distinct public.normalize_guest_day_name(raw_name) as guest_key
    from unnest(array_prepend(new.guest_name, coalesce(new.additional_guests, array[]::text[]))) as guest_names(raw_name)
    where public.normalize_guest_day_name(raw_name) is not null
  )
  select count(*)
  into guest_day_count
  from new_guest_names ng
  where not exists (
    select 1
    from public.timesheet_entries te
    join public.account_members am on am.id = te.member_entered_with_id
    cross join lateral unnest(array_prepend(te.guest_name, coalesce(te.additional_guests, array[]::text[]))) as prior_guest_names(raw_name)
    where te.member_or_guest = 'Guest'
      and te.day_pass_or_open_gym = 'Day Pass'
      and am.account_id = sponsor_account_id
      and te.id <> new.id
      and te.signed_in_at < new.signed_in_at
      and te.signed_in_at >= new.signed_in_at - interval '24 hours'
      and public.normalize_guest_day_name(prior_guest_names.raw_name) = ng.guest_key
  );

  if guest_day_count <= 0 then
    return new;
  end if;

  with prior_guest_entries as (
    select
      te.id,
      te.signed_in_at,
      public.normalize_guest_day_name(prior_guest_names.raw_name) as guest_key
    from public.timesheet_entries te
    join public.account_members am on am.id = te.member_entered_with_id
    cross join lateral unnest(array_prepend(te.guest_name, coalesce(te.additional_guests, array[]::text[]))) as prior_guest_names(raw_name)
    where te.member_or_guest = 'Guest'
      and te.day_pass_or_open_gym = 'Day Pass'
      and am.account_id = sponsor_account_id
      and te.id <> new.id
      and te.signed_in_at < new.signed_in_at
      and public.normalize_guest_day_name(prior_guest_names.raw_name) is not null
  )
  select count(*)
  into used_free_guests
  from prior_guest_entries p
  where date_trunc('month', p.signed_in_at at time zone 'America/Los_Angeles')
      = date_trunc('month', new.signed_in_at at time zone 'America/Los_Angeles')
    and not exists (
      select 1
      from prior_guest_entries earlier
      where earlier.guest_key = p.guest_key
        and earlier.signed_in_at < p.signed_in_at
        and earlier.signed_in_at >= p.signed_in_at - interval '24 hours'
    );

  free_guests_remaining := greatest(0, 10 - used_free_guests);
  billable_guest_count := greatest(0, guest_day_count - free_guests_remaining);

  if billable_guest_count = 0 then
    return new;
  end if;

  insert into public.billing_line_items (
    account_member_id,
    timesheet_entry_id,
    amount_cents,
    reason
  ) values (
    new.member_entered_with_id,
    new.id,
    billable_guest_count * 25,
    'Guest Day Pass fee for ' || billable_guest_count || ' guest day(s) after 10 free/month'
  )
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists trg_bill_guest_entry on public.timesheet_entries;
create trigger trg_bill_guest_entry
after insert on public.timesheet_entries
for each row
execute function public.bill_guest_entry();

create index if not exists idx_timesheet_entries_guest_day_lookup
  on public.timesheet_entries (member_entered_with_id, signed_in_at desc)
  where member_or_guest = 'Guest'
    and day_pass_or_open_gym = 'Day Pass';
