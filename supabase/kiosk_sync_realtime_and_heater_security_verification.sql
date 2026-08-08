-- Read-only post-migration checks for
-- 20260808105304_kiosk_sync_realtime_and_heater_security.sql plus
-- 20260808105941_allow_policy_helper_execution.sql.
-- Expected: five rows, all non-negative versions.
select scope, version, updated_at
from public.kiosk_sync_versions
order by scope;

-- Expected: authenticated has SELECT at the grant layer but no client write
-- privileges; anon has no table privileges. RLS then limits authenticated
-- SELECT to Kiosk and Account Manager users.
select
  pg_catalog.has_table_privilege('anon', 'public.kiosk_sync_versions', 'SELECT') as anon_select,
  pg_catalog.has_table_privilege('authenticated', 'public.kiosk_sync_versions', 'SELECT') as authenticated_select,
  pg_catalog.has_table_privilege('authenticated', 'public.kiosk_sync_versions', 'INSERT') as authenticated_insert,
  pg_catalog.has_table_privilege('authenticated', 'public.kiosk_sync_versions', 'UPDATE') as authenticated_update,
  pg_catalog.has_table_privilege('authenticated', 'public.kiosk_sync_versions', 'DELETE') as authenticated_delete;

-- Expected source mapping: 12 statement-level triggers (36 event rows) with
-- the scope shown in each trigger definition. Existing publication membership
-- is not modified.
select
  event_object_table as source_table,
  action_orientation,
  action_statement
from information_schema.triggers
where trigger_schema = 'public'
  and trigger_name = 'trg_kiosk_sync_invalidation'
order by event_object_table, event_manipulation;

-- Expected: every helper is SECURITY DEFINER with search_path="". Authenticated
-- EXECUTE is true only for the five helpers referenced by RLS policies; trigger
-- helpers remain false. Anon and service_role remain false for every helper.
select
  procedure.proname as function_name,
  pg_catalog.pg_get_function_identity_arguments(procedure.oid) as arguments,
  owner.rolname as owner,
  procedure.prosecdef as security_definer,
  procedure.proconfig,
  pg_catalog.has_function_privilege('anon', procedure.oid, 'EXECUTE') as anon_execute,
  pg_catalog.has_function_privilege('authenticated', procedure.oid, 'EXECUTE') as authenticated_execute,
  pg_catalog.has_function_privilege('service_role', procedure.oid, 'EXECUTE') as service_role_execute
from pg_catalog.pg_proc as procedure
join pg_catalog.pg_namespace as namespace
  on namespace.oid = procedure.pronamespace
join pg_catalog.pg_roles as owner
  on owner.oid = procedure.proowner
where namespace.nspname = 'app_private'
order by procedure.proname;

-- Expected: one topic-specific permissive SELECT policy plus one restrictive
-- INSERT policy whose WITH CHECK rejects extension=broadcast.
select policyname, permissive, cmd, roles, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'realtime'
  and tablename = 'messages'
order by cmd, policyname;

-- Expected: both true. SECURITY DEFINER trigger helpers are explicitly owned
-- by postgres, which keeps database-originated sends outside client RLS.
select
  pg_catalog.has_table_privilege('postgres', 'realtime.messages', 'INSERT') as postgres_can_insert,
  role.rolbypassrls as postgres_bypasses_rls
from pg_catalog.pg_roles as role
where role.rolname = 'postgres';

-- Expected: Kiosk/Account Manager SELECT-only table access, plus heater UPDATE
-- USING and WITH CHECK expressions backed by app_private helpers.
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_catalog.pg_policies
where schemaname = 'public'
  and tablename in (
    'kiosk_sync_versions',
    'heater_use_entries',
    'heater_use_group_members'
  )
order by tablename, cmd, policyname;

-- Expected: unchanged from the pre-migration publication: account_members,
-- account_type_permissions, door_access_entries, member_notifications,
-- rental_change_requests, and timesheet_entries. This query is here
-- specifically to catch accidental publication churn during review/deployment.
select
  publication.pubname,
  namespace.nspname as schema_name,
  relation.relname as table_name
from pg_catalog.pg_publication as publication
join pg_catalog.pg_publication_rel as publication_relation
  on publication_relation.prpubid = publication.oid
join pg_catalog.pg_class as relation
  on relation.oid = publication_relation.prrelid
join pg_catalog.pg_namespace as namespace
  on namespace.oid = relation.relnamespace
where publication.pubname = 'supabase_realtime'
order by namespace.nspname, relation.relname;
