-- Run this second, after membership_signup_flow_step_1_enums.sql succeeds.
-- Do not combine the enum step and this step in one SQL editor run.

create extension if not exists "pgcrypto";
create extension if not exists "citext";


alter table public.accounts
  add column if not exists heater_pin text;

alter table public.account_members
  add column if not exists date_of_birth date,
  add column if not exists guardian_member_id uuid references public.account_members(id) on delete set null,
  add column if not exists can_access_independently boolean not null default true;

create index if not exists idx_account_members_date_of_birth
  on public.account_members (date_of_birth);

create index if not exists idx_account_members_guardian_member_id
  on public.account_members (guardian_member_id);

insert into public.account_type_permissions (
  account_type,
  can_sign_in,
  can_manage_members,
  bypass_time_windows,
  allowed_days,
  allowed_start_time,
  allowed_end_time,
  notes
) values
  ('Weight Room Only', true, false, false, array[0,1,2,3,4,5,6]::smallint[], time '06:50', time '21:10', 'Weight room membership access during member hours.')
on conflict (account_type) do update set
  can_sign_in = excluded.can_sign_in,
  can_manage_members = excluded.can_manage_members,
  bypass_time_windows = excluded.bypass_time_windows,
  allowed_days = excluded.allowed_days,
  allowed_start_time = excluded.allowed_start_time,
  allowed_end_time = excluded.allowed_end_time,
  notes = excluded.notes,
  updated_at = now();

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
  am.can_access_independently,
  a.heater_pin
from public.account_members am
join public.accounts a
  on a.id = am.account_id
left join public.account_billing ab
  on ab.account_id = a.id;

-- Account invite contract flow. Invited users 13+ must accept the contract before login access.
create table if not exists public.account_invitations (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete cascade,
  invited_by_member_id uuid references public.account_members(id) on delete set null,
  invited_email citext,
  invited_name text not null,
  invited_phone text,
  invited_date_of_birth date not null,
  account_type public.membership_account_type not null default 'Active Membership',
  token_hash text not null unique,
  invitation_status text not null default 'pending',
  expires_at timestamptz not null default (now() + interval '30 days'),
  accepted_at timestamptz,
  accepted_member_id uuid references public.account_members(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_invitations_status_check
    check (invitation_status in ('pending', 'accepted', 'expired', 'canceled'))
);

create index if not exists idx_account_invitations_account_status
  on public.account_invitations (account_id, invitation_status);

create index if not exists idx_account_invitations_email_status
  on public.account_invitations (invited_email, invitation_status);

drop trigger if exists trg_account_invitations_updated_at on public.account_invitations;
create trigger trg_account_invitations_updated_at
before update on public.account_invitations
for each row
execute function public.set_updated_at();

alter table public.account_invitations enable row level security;

drop policy if exists account_invitations_admin_only on public.account_invitations;
create policy account_invitations_admin_only on public.account_invitations
for all using (public.is_admin())
with check (public.is_admin());

-- Minor fields and Day Pass/Open Gym guest permission enforcement.
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

-- Admin approval gate for all signed contracts.

insert into public.account_type_permissions (
  account_type,
  can_sign_in,
  can_manage_members,
  bypass_time_windows,
  allowed_days,
  allowed_start_time,
  allowed_end_time,
  notes
) values
  ('RESTRICTED ACCOUNT', false, false, false, '{}'::smallint[], null, null, 'Restricted account pending approval or restoration.')
on conflict (account_type) do update set
  can_sign_in = excluded.can_sign_in,
  can_manage_members = excluded.can_manage_members,
  bypass_time_windows = excluded.bypass_time_windows,
  allowed_days = excluded.allowed_days,
  allowed_start_time = excluded.allowed_start_time,
  allowed_end_time = excluded.allowed_end_time,
  notes = excluded.notes,
  updated_at = now();

alter table public.signup_contracts
  add column if not exists admin_review_status text not null default 'pending',
  add column if not exists admin_reviewed_at timestamptz,
  add column if not exists admin_reviewed_by_member_id uuid references public.account_members(id) on delete set null,
  add column if not exists admin_review_notes text;

do $$
begin
  alter table public.signup_contracts
    add constraint signup_contracts_admin_review_status_check
    check (admin_review_status in ('pending', 'approved', 'rejected'));
exception
  when duplicate_object then null;
end $$;

create index if not exists idx_signup_contracts_admin_review
  on public.signup_contracts (admin_review_status, created_at desc);
