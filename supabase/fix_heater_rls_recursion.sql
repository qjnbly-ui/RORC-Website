-- Fix heater RLS recursion.
-- Run this in Supabase SQL editor if reads from heater_use_entries fail with:
-- "infinite recursion detected in policy for relation \"heater_use_entries\"".

-- Ensure helper auth functions exist when this script is run standalone.
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
    responsible_member = public.current_account_member_id()
    or exists (
      select 1
      from public.heater_use_group_members hugm
      where hugm.heater_use_entry_id = heater_entry_id
        and hugm.account_member_id = public.current_account_member_id()
    ),
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
    group_account_member = public.current_account_member_id()
    or exists (
      select 1
      from public.heater_use_entries hue
      where hue.id = heater_entry_id
        and hue.responsible_member_id = public.current_account_member_id()
    ),
    false
  );
$$;

drop policy if exists heater_use_entries_member_read on public.heater_use_entries;
create policy heater_use_entries_member_read on public.heater_use_entries
for select using (
  public.can_read_heater_use_entry(id, responsible_member_id)
  or public.is_admin()
);

drop policy if exists heater_use_group_members_member_read on public.heater_use_group_members;
create policy heater_use_group_members_member_read on public.heater_use_group_members
for select using (
  public.can_read_heater_group_member(heater_use_entry_id, account_member_id)
  or public.is_admin()
);
