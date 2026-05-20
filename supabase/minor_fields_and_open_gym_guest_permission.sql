alter table public.account_members
  add column if not exists date_of_birth date,
  add column if not exists guardian_member_id uuid references public.account_members(id) on delete set null,
  add column if not exists can_access_independently boolean not null default true;

create index if not exists idx_account_members_date_of_birth
  on public.account_members (date_of_birth);

create index if not exists idx_account_members_guardian_member_id
  on public.account_members (guardian_member_id);

create or replace function public.alert_unauthorized_sign_in()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.member_or_guest = 'Member'
     and not public.is_sign_in_authorized(new.member_id, new.signed_in_at) then
    insert into public.admin_alerts (alert_kind, account_member_id, context)
    values (
      'unauthorized_sign_in',
      new.member_id,
      jsonb_build_object(
        'timesheet_entry_id', new.id,
        'signed_in_at', new.signed_in_at
      )
    );
  elsif new.member_or_guest = 'Guest'
        and not (
          public.is_sign_in_authorized(new.member_entered_with_id, new.signed_in_at)
          and (
            new.day_pass_or_open_gym = 'Open Gym'
            or public.member_can_bring_guests(new.member_entered_with_id)
          )
        ) then
    insert into public.admin_alerts (alert_kind, account_member_id, context)
    values (
      'unauthorized_guest_sign_in',
      new.member_entered_with_id,
      jsonb_build_object(
        'timesheet_entry_id', new.id,
        'guest_name', new.guest_name,
        'signed_in_at', new.signed_in_at
      )
    );
  end if;

  return new;
end;
$$;

create or replace function public.enqueue_timesheet_insert_automation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  job_kind public.automation_job_kind;
begin
  if new.member_or_guest = 'Member'
     and public.is_sign_in_authorized(new.member_id, new.signed_in_at) then
    job_kind := 'voice_monkey_sign_in';
  elsif new.member_or_guest = 'Guest'
        and public.is_sign_in_authorized(new.member_entered_with_id, new.signed_in_at)
        and (
          new.day_pass_or_open_gym = 'Open Gym'
          or public.member_can_bring_guests(new.member_entered_with_id)
        ) then
    job_kind := 'voice_monkey_sign_in';
  else
    job_kind := 'admin_sms';
  end if;

  insert into public.automation_jobs (kind, payload)
  values (
    job_kind,
    jsonb_build_object(
      'timesheet_entry_id', new.id,
      'member_or_guest', new.member_or_guest,
      'member_id', new.member_id,
      'guest_name', new.guest_name,
      'member_entered_with_id', new.member_entered_with_id,
      'signed_in_at', new.signed_in_at
    )
  );

  return new;
end;
$$;

drop policy if exists timesheet_entries_member_insert on public.timesheet_entries;
create policy timesheet_entries_member_insert on public.timesheet_entries
for insert with check (
  public.is_admin()
  or (
    public.is_kiosk()
    and member_or_guest = 'Member'
    and public.is_sign_in_authorized(member_id, signed_in_at)
  )
  or (
    public.is_kiosk()
    and member_or_guest = 'Guest'
    and public.is_sign_in_authorized(member_entered_with_id, signed_in_at)
    and (
      day_pass_or_open_gym = 'Open Gym'
      or public.member_can_bring_guests(member_entered_with_id)
    )
    and liability_accepted = true
  )
  or (
    member_or_guest = 'Member'
    and exists (
      select 1
      from public.account_members am
      where am.id = member_id
        and am.account_id = public.current_account_id()
    )
    and public.is_sign_in_authorized(member_id, signed_in_at)
  )
  or (
    member_or_guest = 'Guest'
    and member_entered_with_id = public.current_account_member_id()
    and public.is_sign_in_authorized(member_entered_with_id, signed_in_at)
    and (
      day_pass_or_open_gym = 'Open Gym'
      or public.member_can_bring_guests(member_entered_with_id)
    )
    and liability_accepted = true
  )
);

create or replace view public.account_member_profiles
with (security_invoker = true) as
select
  am.id as account_member_id,
  am.account_id,
  a.account_number,
  am.member_name,
  am.account_type,
  am.legacy_account_type,
  am.phone_number,
  am.email_address,
  am.image_path,
  am.allow_guest_entry,
  am.is_billing_owner,
  a.membership_details,
  a.notes_on_account,
  a.expiration_date,
  a.billing_id_heater,
  a.marks_against_account,
  ab.stripe_status,
  ab.billing_status,
  ab.current_period_end,
  ab.last_sync,
  am.allow_heater_use,
  am.created_at,
  am.updated_at,
  am.date_of_birth,
  am.guardian_member_id,
  am.can_access_independently
from public.account_members am
join public.accounts a
  on a.id = am.account_id
left join public.account_billing ab
  on ab.account_id = a.id;
