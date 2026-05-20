alter type public.membership_account_type
  add value if not exists 'Weight Room Only';

alter table public.accounts
  add column if not exists heater_pin text;

alter table public.account_members
  add column if not exists date_of_birth date,
  add column if not exists guardian_member_id uuid references public.account_members(id) on delete set null,
  add column if not exists can_access_independently boolean not null default true;

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
  a.heater_pin,
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

-- Admin approval gate for all signed contracts.
alter type public.membership_account_type
  add value if not exists 'RESTRICTED ACCOUNT';

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
