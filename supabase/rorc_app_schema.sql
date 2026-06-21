-- RORC App MVP schema
-- Sources:
-- 1) AppSheet Inspect round 1
-- 2) AppSheet Inspect round 2 MVP findings
-- 3) Current Membership, TimeSheet, and Heater Use spreadsheet structure
--
-- Scope for this first app build:
-- - Shared accounts / household memberships
-- - Individual account members
-- - Sign in / sign out
-- - Heater use
-- - Group heater pay
--
-- Deferred intentionally:
-- - Contracts
-- - Banners
-- - Projects/materials/steps
-- - Tutorials
-- - Window inventory/orders
-- - Messaging/notifications

create extension if not exists "pgcrypto";
create extension if not exists "citext";

do $$
begin
  if not exists (select 1 from pg_type where typname = 'membership_account_type') then
    create type public.membership_account_type as enum (
      'Active Membership',
      'Weight Room Only',
      'Work Exchange Membership Program',
      'Open Gym Only',
      'Billed Monthly',
      'Account Manager',
      'RESTRICTED ACCOUNT',
      'Account Past Due NO ACCESS ALLOWED'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'timesheet_kind') then
    create type public.timesheet_kind as enum ('Member', 'Guest');
  end if;

  if not exists (select 1 from pg_type where typname = 'timesheet_pass') then
    create type public.timesheet_pass as enum ('Day Pass', 'Open Gym');
  end if;

  if not exists (select 1 from pg_type where typname = 'heater_event') then
    create type public.heater_event as enum (
      'RORC',
      'KBYD',
      'MEMBER USE',
      'OPEN GYM',
      'RENTAL (All Day Or Hourly Rentals)'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'heater_state') then
    create type public.heater_state as enum ('On', 'Off');
  end if;

  if not exists (select 1 from pg_type where typname = 'account_billing_status') then
    create type public.account_billing_status as enum (
      'none',
      'incomplete',
      'trialing',
      'active',
      'past_due',
      'canceled',
      'unpaid',
      'paused'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'signup_status') then
    create type public.signup_status as enum (
      'submitted',
      'awaiting_payment',
      'active',
      'rejected',
      'canceled'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'automation_job_kind') then
    create type public.automation_job_kind as enum (
      'voice_monkey_sign_in',
      'voice_monkey_sign_out',
      'voice_monkey_after_hours',
      'heater_on',
      'heater_off',
      'closing_reminder',
      'admin_sms',
      'billing_sync'
    );
  end if;

  if not exists (select 1 from pg_type where typname = 'automation_job_status') then
    create type public.automation_job_status as enum (
      'pending',
      'processing',
      'completed',
      'failed',
      'canceled'
    );
  end if;
end $$;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.accounts (
  id uuid primary key default gen_random_uuid(),
  account_number text not null unique,
  membership_details text,
  notes_on_account text,
  expiration_date date,
  billing_id_heater text,
  heater_pin text,
  marks_against_account text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_accounts_account_number
  on public.accounts (account_number);

drop trigger if exists trg_accounts_updated_at on public.accounts;
create trigger trg_accounts_updated_at
before update on public.accounts
for each row
execute function public.set_updated_at();

create table if not exists public.account_members (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.accounts(id) on delete restrict,
  member_name text not null,
  account_type public.membership_account_type not null default 'Active Membership',
  allow_heater_use boolean not null default false,
  phone_number text,
  email_address citext,
  image_path text,
  date_of_birth date,
  guardian_member_id uuid references public.account_members(id) on delete set null,
  can_access_independently boolean not null default true,
  allow_guest_entry boolean not null default false,
  is_billing_owner boolean not null default false,
  auth_user_id uuid references auth.users(id) on delete set null,
  legacy_source_row_number integer unique,
  legacy_member_name text,
  legacy_account_type text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint account_members_member_name_not_blank check (btrim(member_name) <> '')
);

alter table public.account_members
  add column if not exists allow_heater_use boolean not null default false,
  add column if not exists date_of_birth date,
  add column if not exists guardian_member_id uuid references public.account_members(id) on delete set null,
  add column if not exists can_access_independently boolean not null default true;

create index if not exists idx_account_members_account_id
  on public.account_members (account_id);

create index if not exists idx_account_members_email_address
  on public.account_members (email_address);

create index if not exists idx_account_members_account_type
  on public.account_members (account_type);

create index if not exists idx_account_members_allow_heater_use
  on public.account_members (allow_heater_use);

create index if not exists idx_account_members_date_of_birth
  on public.account_members (date_of_birth);

create index if not exists idx_account_members_guardian_member_id
  on public.account_members (guardian_member_id);

create unique index if not exists idx_account_members_auth_user_id_unique
  on public.account_members (auth_user_id)
  where auth_user_id is not null;

create unique index if not exists idx_account_members_account_member_name_unique
  on public.account_members (account_id, member_name);

create unique index if not exists idx_account_members_one_billing_owner
  on public.account_members (account_id)
  where is_billing_owner = true;

drop trigger if exists trg_account_members_updated_at on public.account_members;
create trigger trg_account_members_updated_at
before update on public.account_members
for each row
execute function public.set_updated_at();

create table if not exists public.account_type_permissions (
  account_type public.membership_account_type primary key,
  can_sign_in boolean not null default false,
  can_manage_members boolean not null default false,
  bypass_time_windows boolean not null default false,
  allowed_days smallint[] not null default '{}',
  allowed_start_time time,
  allowed_end_time time,
  notes text,
  updated_at timestamptz not null default now()
);

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
  ('Active Membership', true, false, false, array[0,1,2,3,4,5,6]::smallint[], time '06:50', time '21:10', 'Member access safety window for nominal 7am-9pm hours.'),
  ('Work Exchange Membership Program', true, false, false, array[0,1,2,3,4,5,6]::smallint[], time '06:50', time '21:10', 'Member access safety window for nominal 7am-9pm hours.'),
  ('Weight Room Only', true, false, false, array[0,1,2,3,4,5,6]::smallint[], time '06:50', time '21:10', 'Weight room membership access during member hours.'),
  ('Open Gym Only', true, false, false, array[2,4]::smallint[], time '17:50', time '20:10', 'Open Gym Only access on Tuesdays and Thursdays from 6pm-8pm, with a 10-minute safety window.'),
  ('Billed Monthly', true, false, false, array[0,1,2,3,4,5,6]::smallint[], time '06:50', time '21:10', 'Billed monthly access safety window for nominal 7am-9pm hours.'),
  ('Account Manager', true, true, true, '{}'::smallint[], null, null, 'Admin role with unrestricted access.'),
  ('RESTRICTED ACCOUNT', false, false, false, '{}'::smallint[], null, null, 'Restricted account pending approval or restoration.'),
  ('Account Past Due NO ACCESS ALLOWED', false, false, false, '{}'::smallint[], null, null, 'Past-due account with no access.')
on conflict (account_type) do update set
  can_sign_in = excluded.can_sign_in,
  can_manage_members = excluded.can_manage_members,
  bypass_time_windows = excluded.bypass_time_windows,
  allowed_days = excluded.allowed_days,
  allowed_start_time = excluded.allowed_start_time,
  allowed_end_time = excluded.allowed_end_time,
  notes = excluded.notes,
  updated_at = now();

drop trigger if exists trg_account_type_permissions_updated_at on public.account_type_permissions;
create trigger trg_account_type_permissions_updated_at
before update on public.account_type_permissions
for each row
execute function public.set_updated_at();

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    begin
      execute 'alter publication supabase_realtime add table public.account_members';
    exception
      when duplicate_object then
        null;
    end;

    begin
      execute 'alter publication supabase_realtime add table public.account_type_permissions';
    exception
      when duplicate_object then
        null;
    end;
  end if;
end $$;

create table if not exists public.member_credentials (
  account_member_id uuid primary key references public.account_members(id) on delete cascade,
  pin_hash text,
  must_reset_pin boolean not null default true,
  updated_at timestamptz not null default now()
);

drop trigger if exists trg_member_credentials_updated_at on public.member_credentials;
create trigger trg_member_credentials_updated_at
before update on public.member_credentials
for each row
execute function public.set_updated_at();

create table if not exists public.account_billing (
  account_id uuid primary key references public.accounts(id) on delete cascade,
  stripe_customer_id text,
  stripe_subscription_id text,
  stripe_status text,
  billing_status public.account_billing_status not null default 'none',
  current_period_end timestamptz,
  last_sync timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists idx_account_billing_stripe_customer_id
  on public.account_billing (stripe_customer_id);

create index if not exists idx_account_billing_stripe_subscription_id
  on public.account_billing (stripe_subscription_id);

drop trigger if exists trg_account_billing_updated_at on public.account_billing;
create trigger trg_account_billing_updated_at
before update on public.account_billing
for each row
execute function public.set_updated_at();

create table if not exists public.signup_contracts (
  id uuid primary key default gen_random_uuid(),
  account_id uuid references public.accounts(id) on delete set null,
  primary_member_id uuid references public.account_members(id) on delete set null,
  requested_account_number text,
  applicant_name text not null,
  applicant_email citext,
  applicant_phone text,
  requested_account_type public.membership_account_type not null default 'Active Membership',
  contract_payload jsonb not null default '{}'::jsonb,
  contract_signed_at timestamptz,
  stripe_checkout_session_id text,
  signup_status public.signup_status not null default 'submitted',
  admin_review_status text not null default 'pending',
  admin_reviewed_at timestamptz,
  admin_reviewed_by_member_id uuid references public.account_members(id) on delete set null,
  admin_review_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint signup_contracts_admin_review_status_check
    check (admin_review_status in ('pending', 'approved', 'rejected'))
);

create index if not exists idx_signup_contracts_signup_status
  on public.signup_contracts (signup_status, created_at desc);

create index if not exists idx_signup_contracts_admin_review
  on public.signup_contracts (admin_review_status, created_at desc);

create index if not exists idx_signup_contracts_account_id
  on public.signup_contracts (account_id);

drop trigger if exists trg_signup_contracts_updated_at on public.signup_contracts;
create trigger trg_signup_contracts_updated_at
before update on public.signup_contracts
for each row
execute function public.set_updated_at();

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

create table if not exists public.timesheet_entries (
  id uuid primary key default gen_random_uuid(),
  log_id text not null unique default gen_random_uuid()::text,
  member_or_guest public.timesheet_kind not null,
  member_id uuid references public.account_members(id) on delete set null,
  guest_name text,
  day_pass_or_open_gym public.timesheet_pass,
  member_entered_with_id uuid references public.account_members(id) on delete set null,
  liability_accepted boolean not null default false,
  signed_in_at timestamptz not null default now(),
  signed_out_at timestamptz,
  additional_guests text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint timesheet_member_requires_member_id check (
    member_or_guest <> 'Member' or member_id is not null
  ),
  constraint timesheet_guest_requires_guest_details check (
    member_or_guest <> 'Guest'
    or (
      guest_name is not null
      and btrim(guest_name) <> ''
      and member_entered_with_id is not null
      and liability_accepted = true
    )
  ),
  constraint timesheet_sign_out_after_sign_in check (
    signed_out_at is null or signed_out_at >= signed_in_at
  )
);

create index if not exists idx_timesheet_entries_member_id
  on public.timesheet_entries (member_id);

create index if not exists idx_timesheet_entries_member_entered_with_id
  on public.timesheet_entries (member_entered_with_id);

create index if not exists idx_timesheet_entries_signed_in_at
  on public.timesheet_entries (signed_in_at desc);

create index if not exists idx_timesheet_entries_currently_signed_in
  on public.timesheet_entries (signed_in_at desc)
  where signed_out_at is null;

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    execute 'alter publication supabase_realtime add table public.timesheet_entries';
  end if;
exception
  when duplicate_object then
    null;
end $$;

drop trigger if exists trg_timesheet_entries_updated_at on public.timesheet_entries;
create trigger trg_timesheet_entries_updated_at
before update on public.timesheet_entries
for each row
execute function public.set_updated_at();

create table if not exists public.heater_use_entries (
  id uuid primary key default gen_random_uuid(),
  used_on date not null default current_date,
  system_type text not null default 'heat',
  event public.heater_event,
  responsible_member_id uuid references public.account_members(id) on delete set null,
  group_pay boolean not null default false,
  turn_heater_on public.heater_state not null default 'On',
  target_temperature_f integer,
  start_at timestamptz,
  end_at timestamptz,
  paid boolean not null default false,
  set_a_timer boolean not null default false,
  timer_start time,
  timer_stop time,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint heater_non_group_requires_responsible_member check (
    group_pay = true or responsible_member_id is not null
  ),
  constraint heater_use_entries_system_type_check check (
    system_type in ('heat', 'ac')
  ),
  constraint heater_end_after_start check (
    start_at is null or end_at is null or end_at >= start_at
  )
);

alter table public.heater_use_entries
  add column if not exists system_type text not null default 'heat',
  add column if not exists target_temperature_f integer;

alter table public.heater_use_entries
  drop constraint if exists heater_use_entries_system_type_check,
  add constraint heater_use_entries_system_type_check check (system_type in ('heat', 'ac'));

create index if not exists idx_heater_use_entries_used_on
  on public.heater_use_entries (used_on desc);

create index if not exists idx_heater_use_entries_system_type
  on public.heater_use_entries (system_type, start_at desc);

create index if not exists idx_heater_use_entries_responsible_member_id
  on public.heater_use_entries (responsible_member_id);

drop trigger if exists trg_heater_use_entries_updated_at on public.heater_use_entries;
create trigger trg_heater_use_entries_updated_at
before update on public.heater_use_entries
for each row
execute function public.set_updated_at();

create table if not exists public.heater_use_group_members (
  heater_use_entry_id uuid not null references public.heater_use_entries(id) on delete cascade,
  account_member_id uuid not null references public.account_members(id) on delete restrict,
  added_at timestamptz not null default now(),
  primary key (heater_use_entry_id, account_member_id)
);

create index if not exists idx_heater_use_group_members_account_member_id
  on public.heater_use_group_members (account_member_id);

create table if not exists public.admin_alerts (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  alert_kind text not null,
  account_member_id uuid references public.account_members(id) on delete set null,
  context jsonb not null default '{}'::jsonb,
  resolved_at timestamptz
);

create index if not exists idx_admin_alerts_created_at
  on public.admin_alerts (created_at desc);

create index if not exists idx_admin_alerts_unresolved
  on public.admin_alerts (created_at desc)
  where resolved_at is null;

create table if not exists public.billing_line_items (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  account_member_id uuid not null references public.account_members(id) on delete restrict,
  timesheet_entry_id uuid references public.timesheet_entries(id) on delete cascade,
  heater_use_entry_id uuid references public.heater_use_entries(id) on delete cascade,
  amount_cents integer not null check (amount_cents >= 0),
  reason text not null,
  posted_to_stripe_at timestamptz,
  payment_method text,
  payment_recorded_at timestamptz,
  payment_recorded_by_member_id uuid references public.account_members(id) on delete set null,
  payment_note text,
  stripe_invoice_id text,
  stripe_invoice_url text,
  constraint billing_line_items_payment_method_valid
    check (payment_method is null or payment_method in ('cash', 'check', 'stripe_invoice', 'other'))
);

alter table public.billing_line_items
  add column if not exists payment_method text,
  add column if not exists payment_recorded_at timestamptz,
  add column if not exists payment_recorded_by_member_id uuid references public.account_members(id) on delete set null,
  add column if not exists payment_note text,
  add column if not exists stripe_invoice_id text,
  add column if not exists stripe_invoice_url text;

alter table public.billing_line_items
  drop constraint if exists billing_line_items_payment_method_valid,
  add constraint billing_line_items_payment_method_valid
    check (payment_method is null or payment_method in ('cash', 'check', 'stripe_invoice', 'other'));

alter table public.billing_line_items
  drop constraint if exists billing_line_items_timesheet_entry_id_fkey,
  add constraint billing_line_items_timesheet_entry_id_fkey
    foreign key (timesheet_entry_id) references public.timesheet_entries(id) on delete cascade;

alter table public.billing_line_items
  drop constraint if exists billing_line_items_payment_recorded_by_member_id_fkey,
  add constraint billing_line_items_payment_recorded_by_member_id_fkey
    foreign key (payment_recorded_by_member_id) references public.account_members(id) on delete set null;

alter table public.billing_line_items
  drop constraint if exists billing_line_items_heater_use_entry_id_fkey,
  add constraint billing_line_items_heater_use_entry_id_fkey
    foreign key (heater_use_entry_id) references public.heater_use_entries(id) on delete cascade;

create index if not exists idx_billing_line_items_account_member_id
  on public.billing_line_items (account_member_id, created_at desc);

create index if not exists idx_billing_line_items_timesheet_entry_id
  on public.billing_line_items (timesheet_entry_id);

create index if not exists idx_billing_line_items_heater_use_entry_id
  on public.billing_line_items (heater_use_entry_id);

create index if not exists idx_billing_line_items_payment_method
  on public.billing_line_items (payment_method, payment_recorded_at desc);

create index if not exists idx_billing_line_items_stripe_invoice_id
  on public.billing_line_items (stripe_invoice_id)
  where stripe_invoice_id is not null;

create unique index if not exists idx_billing_line_items_guest_fee_unique
  on public.billing_line_items (timesheet_entry_id, account_member_id)
  where timesheet_entry_id is not null;

create table if not exists public.door_access_entries (
  id uuid primary key default gen_random_uuid(),
  requested_by_member_id uuid not null references public.account_members(id) on delete restrict,
  access_requested_at timestamptz not null default now(),
  request_status text not null default 'sent',
  request_source text not null default 'app',
  note text,
  created_at timestamptz not null default now(),
  constraint door_access_entries_status_valid check (request_status in ('sent', 'failed')),
  constraint door_access_entries_source_valid check (request_source in ('app', 'admin', 'kiosk'))
);

create index if not exists idx_door_access_entries_requested_by
  on public.door_access_entries (requested_by_member_id, access_requested_at desc);

create index if not exists idx_door_access_entries_access_requested_at
  on public.door_access_entries (access_requested_at desc);

do $$
begin
  if exists (
    select 1
    from pg_publication
    where pubname = 'supabase_realtime'
  ) then
    execute 'alter publication supabase_realtime add table public.door_access_entries';
  end if;
exception
  when duplicate_object then
    null;
end $$;

create unique index if not exists idx_billing_line_items_heater_fee_unique
  on public.billing_line_items (heater_use_entry_id, account_member_id)
  where heater_use_entry_id is not null;

create table if not exists public.automation_jobs (
  id uuid primary key default gen_random_uuid(),
  kind public.automation_job_kind not null,
  job_status public.automation_job_status not null default 'pending',
  run_after timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb,
  attempts integer not null default 0 check (attempts >= 0),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_automation_jobs_pending
  on public.automation_jobs (run_after, created_at)
  where job_status = 'pending';

create index if not exists idx_automation_jobs_kind
  on public.automation_jobs (kind, created_at desc);

drop trigger if exists trg_automation_jobs_updated_at on public.automation_jobs;
create trigger trg_automation_jobs_updated_at
before update on public.automation_jobs
for each row
execute function public.set_updated_at();

create table if not exists public.scheduled_member_messages (
  id uuid primary key default gen_random_uuid(),
  created_by_member_id uuid references public.account_members(id) on delete set null,
  rental_request_id uuid references public.rental_requests(id) on delete set null,
  title text not null,
  message text not null default '',
  member_ids jsonb not null default '[]'::jsonb,
  channels jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz not null,
  schedule_label text,
  dispatch_id uuid not null default gen_random_uuid(),
  status text not null default 'scheduled',
  sent_at timestamptz,
  canceled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_member_messages_status_valid check (
    status in ('scheduled', 'processing', 'sent', 'failed', 'canceled')
  ),
  constraint scheduled_member_messages_member_ids_array check (
    jsonb_typeof(member_ids) = 'array'
  )
);

create index if not exists idx_scheduled_member_messages_due
  on public.scheduled_member_messages (status, scheduled_for);

create index if not exists idx_scheduled_member_messages_rental
  on public.scheduled_member_messages (rental_request_id, scheduled_for desc);

drop trigger if exists trg_scheduled_member_messages_updated_at on public.scheduled_member_messages;
create trigger trg_scheduled_member_messages_updated_at
before update on public.scheduled_member_messages
for each row
execute function public.set_updated_at();

create or replace view public.timesheet_entries_with_duration
with (security_invoker = true) as
select
  te.*,
  case
    when te.signed_out_at is null then null
    else extract(epoch from (te.signed_out_at - te.signed_in_at)) / 60
  end as total_minutes
from public.timesheet_entries te;

create or replace view public.currently_signed_in
with (security_invoker = true) as
select *
from public.timesheet_entries
where signed_out_at is null;

drop view if exists public.heater_use_entries_with_duration;
create view public.heater_use_entries_with_duration
with (security_invoker = true) as
select
  hue.*,
  case
    when hue.start_at is null or hue.end_at is null then null
    else extract(epoch from (hue.end_at - hue.start_at)) / 3600
  end as run_hours
from public.heater_use_entries hue;

grant select on public.heater_use_entries_with_duration to anon, authenticated, service_role;

create or replace function public.current_account_member_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
  from public.account_members
  where auth_user_id = auth.uid()
  limit 1;
$$;

create or replace function public.current_account_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select account_id
  from public.account_members
  where auth_user_id = auth.uid()
  limit 1;
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    exists (
      select 1
      from public.account_members
      where auth_user_id = auth.uid()
        and account_type = 'Account Manager'
    ),
    false
  );
$$;

create or replace function public.is_kiosk()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    exists (
      select 1
      from public.account_members
      where auth_user_id = auth.uid()
        and account_type = 'Kiosk Account'
    ),
    false
  );
$$;

create or replace function public.can_read_heater_use_entry(
  heater_entry_id uuid,
  responsible_member uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.current_account_member_id() is not null,
    false
  );
$$;

create or replace function public.can_read_heater_group_member(
  heater_entry_id uuid,
  group_account_member uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.current_account_member_id() is not null,
    false
  );
$$;

create or replace function public.account_billing_allows_access(
  account uuid,
  member_type public.membership_account_type
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select case
    when member_type = 'Account Manager' then true
    else coalesce(
      (
        select billing_status in ('none', 'trialing', 'active')
        from public.account_billing
        where account_id = account
      ),
      true
    )
  end;
$$;

create or replace function public.member_has_access(member uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select atp.can_sign_in
      from public.account_members am
      join public.account_type_permissions atp on atp.account_type = am.account_type
      where am.id = member
        and public.account_billing_allows_access(am.account_id, am.account_type)
    ),
    false
  );
$$;

create or replace function public.member_can_use_heater(member uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select am.allow_heater_use
      from public.account_members am
      where am.id = member
        and public.account_billing_allows_access(am.account_id, am.account_type)
    ),
    false
  );
$$;

create or replace function public.member_can_bring_guests(member uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select am.allow_guest_entry
      from public.account_members am
      where am.id = member
        and public.account_billing_allows_access(am.account_id, am.account_type)
    ),
    false
  );
$$;

create or replace function public.is_sign_in_authorized(
  member uuid,
  signed_in_time timestamptz default now()
)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  rule record;
  local_signed_in timestamp;
  local_day smallint;
  local_time time;
begin
  if member is null then
    return false;
  end if;

  select atp.*
  into rule
  from public.account_members am
  join public.account_type_permissions atp on atp.account_type = am.account_type
  where am.id = member
    and public.account_billing_allows_access(am.account_id, am.account_type);

  if not found or rule.can_sign_in = false then
    return false;
  end if;

  if rule.bypass_time_windows then
    return true;
  end if;

  local_signed_in := signed_in_time at time zone 'America/Los_Angeles';
  local_day := extract(dow from local_signed_in)::smallint;
  local_time := local_signed_in::time;

  if cardinality(rule.allowed_days) > 0 and not (local_day = any(rule.allowed_days)) then
    return false;
  end if;

  if rule.allowed_start_time is not null and rule.allowed_end_time is not null then
    if rule.allowed_start_time <= rule.allowed_end_time then
      return local_time >= rule.allowed_start_time and local_time <= rule.allowed_end_time;
    end if;

    return local_time >= rule.allowed_start_time or local_time <= rule.allowed_end_time;
  end if;

  return true;
end;
$$;

create or replace function public.protect_account_member_update()
returns trigger
language plpgsql
as $$
begin
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if old.auth_user_id is distinct from auth.uid() then
    raise exception 'Only the linked member can update this account member row.';
  end if;

  if (to_jsonb(new) - 'phone_number' - 'email_address' - 'image_path' - 'updated_at')
     is distinct from
     (to_jsonb(old) - 'phone_number' - 'email_address' - 'image_path' - 'updated_at') then
    raise exception 'Members can only update their own contact fields.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_account_member_update on public.account_members;
create trigger trg_protect_account_member_update
before update on public.account_members
for each row
execute function public.protect_account_member_update();

create or replace function public.protect_timesheet_update()
returns trigger
language plpgsql
as $$
begin
  if old.signed_out_at is not null
     and new.signed_out_at is not null
     and old.signed_out_at <> new.signed_out_at then
    raise exception 'Cannot overwrite an existing sign-out time on timesheet row %.', old.id;
  end if;

  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if (to_jsonb(new) - 'signed_out_at' - 'updated_at')
     is distinct from
     (to_jsonb(old) - 'signed_out_at' - 'updated_at') then
    raise exception 'Members can only update sign-out time.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_timesheet_update on public.timesheet_entries;
create trigger trg_protect_timesheet_update
before update on public.timesheet_entries
for each row
execute function public.protect_timesheet_update();

create or replace function public.sign_out_member_guests()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.signed_out_at is null
     and new.signed_out_at is not null
     and new.member_or_guest = 'Member'
     and new.member_id is not null then
    update public.timesheet_entries
    set signed_out_at = new.signed_out_at
    where member_or_guest = 'Guest'
      and member_entered_with_id = new.member_id
      and signed_out_at is null;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sign_out_member_guests on public.timesheet_entries;
create trigger trg_sign_out_member_guests
after update of signed_out_at on public.timesheet_entries
for each row
execute function public.sign_out_member_guests();

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

drop trigger if exists trg_protect_heater_use_update on public.heater_use_entries;
create trigger trg_protect_heater_use_update
before update on public.heater_use_entries
for each row
execute function public.protect_heater_use_update();

create or replace function public.auto_sign_out_open_rows(sign_out_time timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.timesheet_entries
  set signed_out_at = sign_out_time
  where signed_out_at is null;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

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

drop trigger if exists trg_alert_unauthorized_sign_in on public.timesheet_entries;
create trigger trg_alert_unauthorized_sign_in
after insert on public.timesheet_entries
for each row
execute function public.alert_unauthorized_sign_in();

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

drop trigger if exists trg_enqueue_timesheet_insert_automation on public.timesheet_entries;
create trigger trg_enqueue_timesheet_insert_automation
after insert on public.timesheet_entries
for each row
execute function public.enqueue_timesheet_insert_automation();

create or replace function public.enqueue_timesheet_sign_out_automation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.signed_out_at is null
     and new.signed_out_at is not null
     and not exists (
       select 1
       from public.timesheet_entries
       where signed_out_at is null
     ) then
    insert into public.automation_jobs (kind, payload)
    values (
      'voice_monkey_sign_out',
      jsonb_build_object(
        'last_timesheet_entry_id', new.id,
        'signed_out_at', new.signed_out_at
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enqueue_timesheet_sign_out_automation on public.timesheet_entries;
create trigger trg_enqueue_timesheet_sign_out_automation
after update of signed_out_at on public.timesheet_entries
for each row
execute function public.enqueue_timesheet_sign_out_automation();

create or replace function public.enqueue_heater_automation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.automation_jobs (kind, payload)
    values (
      'heater_on',
      jsonb_build_object(
        'heater_use_entry_id', new.id,
        'responsible_member_id', new.responsible_member_id,
        'group_pay', new.group_pay,
        'start_at', new.start_at,
        'event', new.event
      )
    );
  elsif tg_op = 'UPDATE'
        and old.end_at is null
        and new.end_at is not null then
    insert into public.automation_jobs (kind, payload)
    values (
      'heater_off',
      jsonb_build_object(
        'heater_use_entry_id', new.id,
        'responsible_member_id', new.responsible_member_id,
        'group_pay', new.group_pay,
        'start_at', new.start_at,
        'end_at', new.end_at,
        'event', new.event
      )
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enqueue_heater_insert_automation on public.heater_use_entries;
create trigger trg_enqueue_heater_insert_automation
after insert on public.heater_use_entries
for each row
execute function public.enqueue_heater_automation();

drop trigger if exists trg_enqueue_heater_end_automation on public.heater_use_entries;
create trigger trg_enqueue_heater_end_automation
after update of end_at on public.heater_use_entries
for each row
execute function public.enqueue_heater_automation();

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

drop trigger if exists trg_bill_heater_use_entry on public.heater_use_entries;
create trigger trg_bill_heater_use_entry
after update of end_at on public.heater_use_entries
for each row
when (old.end_at is null and new.end_at is not null)
execute function public.bill_heater_use_entry();

alter table public.accounts enable row level security;
alter table public.account_members enable row level security;
alter table public.account_type_permissions enable row level security;
alter table public.member_credentials enable row level security;
alter table public.account_billing enable row level security;
alter table public.signup_contracts enable row level security;
alter table public.account_invitations enable row level security;
alter table public.timesheet_entries enable row level security;
alter table public.heater_use_entries enable row level security;
alter table public.heater_use_group_members enable row level security;
alter table public.admin_alerts enable row level security;
alter table public.billing_line_items enable row level security;
alter table public.door_access_entries enable row level security;
alter table public.automation_jobs enable row level security;

drop policy if exists accounts_member_read on public.accounts;
create policy accounts_member_read on public.accounts
for select using (
  id = public.current_account_id()
  or public.is_admin()
);

drop policy if exists accounts_admin_write on public.accounts;
create policy accounts_admin_write on public.accounts
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists account_type_permissions_member_read on public.account_type_permissions;
create policy account_type_permissions_member_read on public.account_type_permissions
for select using (auth.uid() is not null);

drop policy if exists account_type_permissions_admin_write on public.account_type_permissions;
create policy account_type_permissions_admin_write on public.account_type_permissions
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists account_members_member_read on public.account_members;
create policy account_members_member_read on public.account_members
for select using (
  auth_user_id = auth.uid()
  or account_id = public.current_account_id()
  or public.is_admin()
);

drop policy if exists account_members_self_update on public.account_members;
create policy account_members_self_update on public.account_members
for update using (auth_user_id = auth.uid())
with check (auth_user_id = auth.uid());

drop policy if exists account_members_admin_write on public.account_members;
create policy account_members_admin_write on public.account_members
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists member_credentials_admin_only on public.member_credentials;
create policy member_credentials_admin_only on public.member_credentials
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists account_billing_owner_read on public.account_billing;
create policy account_billing_owner_read on public.account_billing
for select using (
  exists (
    select 1
    from public.account_members am
    where am.account_id = account_billing.account_id
      and am.auth_user_id = auth.uid()
      and am.is_billing_owner = true
  )
  or public.is_admin()
);

drop policy if exists account_billing_admin_only on public.account_billing;
create policy account_billing_admin_only on public.account_billing
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists signup_contracts_admin_only on public.signup_contracts;
create policy signup_contracts_admin_only on public.signup_contracts
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists account_invitations_admin_only on public.account_invitations;
create policy account_invitations_admin_only on public.account_invitations
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists timesheet_entries_member_read on public.timesheet_entries;
create policy timesheet_entries_member_read on public.timesheet_entries
for select using (
  member_id = public.current_account_member_id()
  or exists (
    select 1
    from public.account_members am
    where am.id = timesheet_entries.member_id
      and am.account_id = public.current_account_id()
  )
  or member_entered_with_id = public.current_account_member_id()
  or exists (
    select 1
    from public.account_members am
    where am.id = timesheet_entries.member_entered_with_id
      and am.account_id = public.current_account_id()
  )
  or public.is_admin()
  or public.is_kiosk()
);

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

drop policy if exists timesheet_entries_member_sign_out on public.timesheet_entries;
create policy timesheet_entries_member_sign_out on public.timesheet_entries
for update using (
  member_id = public.current_account_member_id()
  or exists (
    select 1
    from public.account_members am
    where am.id = timesheet_entries.member_id
      and am.account_id = public.current_account_id()
  )
  or member_entered_with_id = public.current_account_member_id()
  or exists (
    select 1
    from public.account_members am
    where am.id = timesheet_entries.member_entered_with_id
      and am.account_id = public.current_account_id()
  )
  or public.is_admin()
  or public.is_kiosk()
);

drop policy if exists timesheet_entries_admin_delete on public.timesheet_entries;
create policy timesheet_entries_admin_delete on public.timesheet_entries
for delete using (public.is_admin());

drop policy if exists heater_use_entries_member_read on public.heater_use_entries;
create policy heater_use_entries_member_read on public.heater_use_entries
for select using (
  public.can_read_heater_use_entry(id, responsible_member_id)
  or public.is_admin()
);

drop policy if exists heater_use_entries_member_insert on public.heater_use_entries;
create policy heater_use_entries_member_insert on public.heater_use_entries
for insert with check (
  public.is_admin()
  or (
    group_pay = false
    and responsible_member_id = public.current_account_member_id()
    and public.member_can_use_heater(responsible_member_id)
  )
);

drop policy if exists heater_use_entries_member_update on public.heater_use_entries;
create policy heater_use_entries_member_update on public.heater_use_entries
for update using (
  responsible_member_id = public.current_account_member_id()
  or public.is_admin()
);

drop policy if exists heater_use_entries_admin_delete on public.heater_use_entries;
create policy heater_use_entries_admin_delete on public.heater_use_entries
for delete using (public.is_admin());

drop policy if exists heater_use_group_members_member_read on public.heater_use_group_members;
create policy heater_use_group_members_member_read on public.heater_use_group_members
for select using (
  public.can_read_heater_group_member(heater_use_entry_id, account_member_id)
  or public.is_admin()
);

drop policy if exists heater_use_group_members_admin_write on public.heater_use_group_members;
create policy heater_use_group_members_admin_write on public.heater_use_group_members
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists admin_alerts_admin_only on public.admin_alerts;
create policy admin_alerts_admin_only on public.admin_alerts
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists billing_line_items_member_read on public.billing_line_items;
create policy billing_line_items_member_read on public.billing_line_items
for select using (
  account_member_id = public.current_account_member_id()
  or exists (
    select 1
    from public.account_members charge_member
    join public.account_members current_member
      on current_member.account_id = charge_member.account_id
    where charge_member.id = billing_line_items.account_member_id
      and current_member.auth_user_id = auth.uid()
      and current_member.is_billing_owner = true
  )
  or public.is_admin()
);

drop policy if exists billing_line_items_admin_write on public.billing_line_items;
create policy billing_line_items_admin_write on public.billing_line_items
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists door_access_entries_member_read on public.door_access_entries;
create policy door_access_entries_member_read on public.door_access_entries
for select using (
  requested_by_member_id = public.current_account_member_id()
  or public.is_admin()
);

drop policy if exists door_access_entries_admin_write on public.door_access_entries;
create policy door_access_entries_admin_write on public.door_access_entries
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists automation_jobs_admin_only on public.automation_jobs;
create policy automation_jobs_admin_only on public.automation_jobs
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists scheduled_member_messages_admin_all on public.scheduled_member_messages;
create policy scheduled_member_messages_admin_all on public.scheduled_member_messages
for all using (public.is_admin())
with check (public.is_admin());

alter table public.account_members
  add column if not exists legacy_account_type text;

update public.account_members
set allow_heater_use = true
where allow_heater_use = false
  and account_type in ('Account Manager', 'Kiosk Account', 'Special Access Account', 'Active Membership', 'Weight Room Only', 'Work Exchange Membership Program');

update public.account_members
set allow_guest_entry = true
where allow_guest_entry = false
  and account_type = 'Account Manager';

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
