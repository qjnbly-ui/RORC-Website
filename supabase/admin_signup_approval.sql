-- Adds admin review/approval for membership signups and contract invites.
-- New accounts/users remain restricted until an Account Manager approves them.

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
