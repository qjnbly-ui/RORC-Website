-- Adds account invitations for 13+ users who must accept the contract before access.
-- Under-13 users are added directly by their account owner/guardian without a login.

create extension if not exists "citext";

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
