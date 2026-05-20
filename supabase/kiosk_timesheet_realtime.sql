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
