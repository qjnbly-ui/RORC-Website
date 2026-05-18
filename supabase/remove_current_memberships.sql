begin;

drop function if exists public.sync_current_memberships_to_app_tables();
drop table if exists public.current_memberships;

notify pgrst, 'reload schema';

commit;
