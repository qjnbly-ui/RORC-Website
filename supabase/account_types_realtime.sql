-- Enables Supabase Realtime for account type and account permission changes.
-- Run in Supabase SQL editor.

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
