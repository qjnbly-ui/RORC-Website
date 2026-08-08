-- Durable kiosk invalidation versions plus private Supabase Realtime Broadcasts.
--
-- Broadcast payloads intentionally contain only invalidation metadata. Clients
-- must re-read authorized rows after receiving an invalidation; source row data
-- is never copied into realtime.messages.

create schema if not exists app_private;

revoke all on schema app_private from public, anon, authenticated, service_role;

create table public.kiosk_sync_versions (
  scope text primary key,
  version bigint not null default 0,
  updated_at timestamp with time zone not null default pg_catalog.statement_timestamp(),
  constraint kiosk_sync_versions_scope_check
    check (scope in ('attendance', 'directory', 'heater', 'calendar', 'settings')),
  constraint kiosk_sync_versions_version_check
    check (version >= 0)
);

comment on table public.kiosk_sync_versions is
  'Durable scope versions used by Kiosk and Account Manager clients to detect missed invalidations after reconnect or wake.';

insert into public.kiosk_sync_versions (scope)
values
  ('attendance'),
  ('directory'),
  ('heater'),
  ('calendar'),
  ('settings')
on conflict (scope) do nothing;

alter table public.kiosk_sync_versions enable row level security;

revoke all on table public.kiosk_sync_versions from public, anon, authenticated;
grant select on table public.kiosk_sync_versions to authenticated;

create or replace function app_private.is_kiosk_or_account_manager()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.account_members as actor
      where actor.auth_user_id = (select auth.uid())
        and actor.account_type in (
          'Kiosk Account'::public.membership_account_type,
          'Account Manager'::public.membership_account_type
        )
    );
$$;

create policy kiosk_sync_versions_authorized_read
on public.kiosk_sync_versions
for select
to authenticated
using ((select app_private.is_kiosk_or_account_manager()));

create or replace function app_private.bump_kiosk_sync_version()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_scope text := tg_argv[0];
  next_version bigint;
  changed_at timestamp with time zone;
begin
  if target_scope is null
     or target_scope not in ('attendance', 'directory', 'heater', 'calendar', 'settings') then
    raise exception 'Invalid kiosk sync scope: %', target_scope;
  end if;

  update public.kiosk_sync_versions as sync_version
  set
    version = sync_version.version + 1,
    updated_at = pg_catalog.clock_timestamp()
  where sync_version.scope = target_scope
  returning
    sync_version.version,
    sync_version.updated_at
  into next_version, changed_at;

  if not found then
    raise exception 'Missing kiosk sync version row for scope: %', target_scope;
  end if;

  perform realtime.send(
    pg_catalog.jsonb_build_object(
      'scope', target_scope,
      'version', next_version,
      'changedAt', changed_at
    ),
    'invalidate',
    'rorc:kiosk:v1',
    true
  );

  return null;
end;
$$;

comment on function app_private.bump_kiosk_sync_version() is
  'Statement-level trigger helper that atomically advances one fixed kiosk scope and emits a private invalidation.';

-- One version increment and one Broadcast per changed source table statement.
drop trigger if exists trg_kiosk_sync_invalidation on public.timesheet_entries;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.timesheet_entries
for each statement
execute function app_private.bump_kiosk_sync_version('attendance');

drop trigger if exists trg_kiosk_sync_invalidation on public.accounts;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.accounts
for each statement
execute function app_private.bump_kiosk_sync_version('directory');

drop trigger if exists trg_kiosk_sync_invalidation on public.account_members;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.account_members
for each statement
execute function app_private.bump_kiosk_sync_version('directory');

drop trigger if exists trg_kiosk_sync_invalidation on public.account_type_permissions;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.account_type_permissions
for each statement
execute function app_private.bump_kiosk_sync_version('directory');

drop trigger if exists trg_kiosk_sync_invalidation on public.account_billing;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.account_billing
for each statement
execute function app_private.bump_kiosk_sync_version('directory');

drop trigger if exists trg_kiosk_sync_invalidation on public.heater_use_entries;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.heater_use_entries
for each statement
execute function app_private.bump_kiosk_sync_version('heater');

drop trigger if exists trg_kiosk_sync_invalidation on public.heater_use_group_members;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.heater_use_group_members
for each statement
execute function app_private.bump_kiosk_sync_version('heater');

drop trigger if exists trg_kiosk_sync_invalidation on public.events;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.events
for each statement
execute function app_private.bump_kiosk_sync_version('calendar');

drop trigger if exists trg_kiosk_sync_invalidation on public.rental_requests;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.rental_requests
for each statement
execute function app_private.bump_kiosk_sync_version('calendar');

drop trigger if exists trg_kiosk_sync_invalidation on public.rental_change_requests;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.rental_change_requests
for each statement
execute function app_private.bump_kiosk_sync_version('calendar');

drop trigger if exists trg_kiosk_sync_invalidation on public.calendar_event_requests;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.calendar_event_requests
for each statement
execute function app_private.bump_kiosk_sync_version('calendar');

drop trigger if exists trg_kiosk_sync_invalidation on public.automation_settings;
create trigger trg_kiosk_sync_invalidation
after insert or update or delete on public.automation_settings
for each statement
execute function app_private.bump_kiosk_sync_version('settings');

-- Notifications use an account-specific topic. Transition tables collapse a
-- bulk insert/update/delete into at most one Broadcast per affected account.
-- The transition relation names below are trigger-local pseudo-relations; all
-- persistent database objects remain schema-qualified.
create or replace function app_private.broadcast_member_notification_invalidation()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  affected_account_id uuid;
  changed_at timestamp with time zone := pg_catalog.clock_timestamp();
begin
  if tg_op = 'INSERT' then
    for affected_account_id in
      select distinct account_member.account_id
      from rorc_notification_new_rows as notification
      join public.account_members as account_member
        on account_member.id = notification.recipient_member_id
    loop
      perform realtime.send(
        pg_catalog.jsonb_build_object(
          'scope', 'notifications',
          'changedAt', changed_at
        ),
        'invalidate',
        pg_catalog.format(
          'rorc:account:%s:notifications:v1',
          affected_account_id::text
        ),
        true
      );
    end loop;
  elsif tg_op = 'UPDATE' then
    for affected_account_id in
      select distinct account_member.account_id
      from (
        select old_notification.recipient_member_id
        from rorc_notification_old_rows as old_notification
        union
        select new_notification.recipient_member_id
        from rorc_notification_new_rows as new_notification
      ) as changed_notification
      join public.account_members as account_member
        on account_member.id = changed_notification.recipient_member_id
    loop
      perform realtime.send(
        pg_catalog.jsonb_build_object(
          'scope', 'notifications',
          'changedAt', changed_at
        ),
        'invalidate',
        pg_catalog.format(
          'rorc:account:%s:notifications:v1',
          affected_account_id::text
        ),
        true
      );
    end loop;
  elsif tg_op = 'DELETE' then
    for affected_account_id in
      select distinct account_member.account_id
      from rorc_notification_old_rows as notification
      join public.account_members as account_member
        on account_member.id = notification.recipient_member_id
    loop
      perform realtime.send(
        pg_catalog.jsonb_build_object(
          'scope', 'notifications',
          'changedAt', changed_at
        ),
        'invalidate',
        pg_catalog.format(
          'rorc:account:%s:notifications:v1',
          affected_account_id::text
        ),
        true
      );
    end loop;
  else
    raise exception 'Unsupported member notification trigger operation: %', tg_op;
  end if;

  return null;
end;
$$;

drop trigger if exists trg_member_notifications_account_invalidate_insert
  on public.member_notifications;
create trigger trg_member_notifications_account_invalidate_insert
after insert on public.member_notifications
referencing new table as rorc_notification_new_rows
for each statement
execute function app_private.broadcast_member_notification_invalidation();

drop trigger if exists trg_member_notifications_account_invalidate_update
  on public.member_notifications;
create trigger trg_member_notifications_account_invalidate_update
after update on public.member_notifications
referencing old table as rorc_notification_old_rows
            new table as rorc_notification_new_rows
for each statement
execute function app_private.broadcast_member_notification_invalidation();

drop trigger if exists trg_member_notifications_account_invalidate_delete
  on public.member_notifications;
create trigger trg_member_notifications_account_invalidate_delete
after delete on public.member_notifications
referencing old table as rorc_notification_old_rows
for each statement
execute function app_private.broadcast_member_notification_invalidation();

-- Realtime Authorization evaluates this helper only while joining a private
-- Broadcast topic. It authorizes Kiosk/Account Manager users for the facility
-- topic and any linked account member for that account's notification topic.
create or replace function app_private.can_receive_rorc_broadcast(requested_topic text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.account_members as actor
      where actor.auth_user_id = (select auth.uid())
        and (
          (
            $1 = 'rorc:kiosk:v1'
            and actor.account_type in (
              'Kiosk Account'::public.membership_account_type,
              'Account Manager'::public.membership_account_type
            )
          )
          or $1 = pg_catalog.format(
            'rorc:account:%s:notifications:v1',
            actor.account_id::text
          )
        )
    );
$$;

drop policy if exists rorc_app_private_broadcast_receive on realtime.messages;
create policy rorc_app_private_broadcast_receive
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (
    select app_private.can_receive_rorc_broadcast(
      (select realtime.topic())
    )
  )
);

comment on policy rorc_app_private_broadcast_receive on realtime.messages is
  'Receive-only access to the exact RORC private Broadcast topic families.';

-- Realtime grants INSERT at the table layer so that projects can opt into
-- client-sent Broadcast/Presence. This restrictive policy keeps database
-- triggers as the only Broadcast writers even if a permissive client INSERT
-- policy is added later. It does not prohibit a future Presence-only policy.
drop policy if exists rorc_app_deny_client_broadcast_write on realtime.messages;
create policy rorc_app_deny_client_broadcast_write
on realtime.messages
as restrictive
for insert
to anon, authenticated
with check (realtime.messages.extension is distinct from 'broadcast');

comment on policy rorc_app_deny_client_broadcast_write on realtime.messages is
  'Rejects client-sent Broadcast messages; RORC invalidations are database-triggered.';

-- Heater rows are readable only by Account Managers, Kiosk users, the
-- responsible member, or a recorded group-pay participant.
create or replace function app_private.can_read_heater_use_entry(
  heater_entry_id uuid,
  responsible_member_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.account_members as actor
      where actor.auth_user_id = (select auth.uid())
        and (
          actor.account_type in (
            'Kiosk Account'::public.membership_account_type,
            'Account Manager'::public.membership_account_type
          )
          or actor.id = $2
          or exists (
            select 1
            from public.heater_use_group_members as participant
            where participant.heater_use_entry_id = $1
              and participant.account_member_id = actor.id
          )
        )
    );
$$;

create or replace function app_private.can_read_heater_group_members(
  heater_entry_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select auth.uid()) is not null
    and coalesce(
      app_private.can_read_heater_use_entry(
        $1,
        (
          select heater_entry.responsible_member_id
          from public.heater_use_entries as heater_entry
          where heater_entry.id = $1
        )
      ),
      false
    );
$$;

create or replace function app_private.can_manage_heater_use_entry(
  heater_entry_id uuid,
  responsible_member_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select auth.uid()) is not null
    and exists (
      select 1
      from public.account_members as actor
      where actor.auth_user_id = (select auth.uid())
        and (
          actor.account_type in (
            'Kiosk Account'::public.membership_account_type,
            'Account Manager'::public.membership_account_type
          )
          or actor.id = $2
          or exists (
            select 1
            from public.heater_use_group_members as participant
            where participant.heater_use_entry_id = $1
              and participant.account_member_id = actor.id
          )
        )
    );
$$;

drop policy if exists heater_use_entries_member_read on public.heater_use_entries;
create policy heater_use_entries_member_read
on public.heater_use_entries
for select
to authenticated
using (
  (
    select app_private.can_read_heater_use_entry(
      heater_use_entries.id,
      heater_use_entries.responsible_member_id
    )
  )
);

drop policy if exists heater_use_group_members_member_read
  on public.heater_use_group_members;
create policy heater_use_group_members_member_read
on public.heater_use_group_members
for select
to authenticated
using (
  (
    select app_private.can_read_heater_group_members(
      heater_use_group_members.heater_use_entry_id
    )
  )
);

-- The replaced public helpers returned true for every authenticated user and
-- were exposed as RPC-callable SECURITY DEFINER functions. Their only live
-- dependencies were the two policies replaced immediately above.
drop function if exists public.can_read_heater_use_entry(uuid, uuid);
drop function if exists public.can_read_heater_group_member(uuid, uuid);

drop policy if exists heater_use_entries_member_update on public.heater_use_entries;
create policy heater_use_entries_member_update
on public.heater_use_entries
for update
to authenticated
using (
  (
    select app_private.can_manage_heater_use_entry(
      heater_use_entries.id,
      heater_use_entries.responsible_member_id
    )
  )
)
with check (
  (
    select app_private.can_manage_heater_use_entry(
      heater_use_entries.id,
      heater_use_entries.responsible_member_id
    )
  )
);

-- Account Managers retain correction privileges. Kiosk users retain facility
-- operations but cannot overwrite a finalized end time. Ordinary responsible
-- members can change only the active operational fields used by the app.
create or replace function app_private.protect_heater_use_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_user_id uuid := auth.uid();
  actor_account_type public.membership_account_type;
begin
  -- Trusted server/database work has no end-user JWT and remains governed by
  -- service-role/database privileges rather than client RLS.
  if actor_user_id is null then
    return new;
  end if;

  select actor.account_type
  into actor_account_type
  from public.account_members as actor
  where actor.auth_user_id = actor_user_id;

  if actor_account_type = 'Account Manager'::public.membership_account_type then
    return new;
  end if;

  if old.end_at is not null
     and new.end_at is distinct from old.end_at then
    raise exception
      'Cannot overwrite an existing thermostat end time on thermostat use row %.',
      old.id;
  end if;

  if actor_account_type = 'Kiosk Account'::public.membership_account_type then
    return new;
  end if;

  if old.end_at is not null
     and (
       pg_catalog.to_jsonb(new) - 'updated_at'
       is distinct from
       pg_catalog.to_jsonb(old) - 'updated_at'
     ) then
    raise exception 'Closed thermostat use row % is immutable.', old.id;
  end if;

  if (
    pg_catalog.to_jsonb(new)
      - 'end_at'
      - 'turn_heater_on'
      - 'target_temperature_f'
      - 'updated_at'
  ) is distinct from (
    pg_catalog.to_jsonb(old)
      - 'end_at'
      - 'turn_heater_on'
      - 'target_temperature_f'
      - 'updated_at'
  ) then
    raise exception
      'Only thermostat state, end time, and target temperature may be changed on thermostat use row %.',
      old.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_protect_heater_use_update on public.heater_use_entries;
create trigger trg_protect_heater_use_update
before update on public.heater_use_entries
for each row
execute function app_private.protect_heater_use_update();

drop function if exists public.protect_heater_use_update();

-- These helpers are reachable only through policies/triggers. Direct RPC-style
-- execution is intentionally unavailable to every API role. Explicit postgres
-- ownership keeps trigger-originated realtime.send calls on the privileged
-- database path rather than the client authorization path.
alter function app_private.is_kiosk_or_account_manager() owner to postgres;
alter function app_private.bump_kiosk_sync_version() owner to postgres;
alter function app_private.broadcast_member_notification_invalidation() owner to postgres;
alter function app_private.can_receive_rorc_broadcast(text) owner to postgres;
alter function app_private.can_read_heater_use_entry(uuid, uuid) owner to postgres;
alter function app_private.can_read_heater_group_members(uuid) owner to postgres;
alter function app_private.can_manage_heater_use_entry(uuid, uuid) owner to postgres;
alter function app_private.protect_heater_use_update() owner to postgres;

revoke execute on function app_private.is_kiosk_or_account_manager()
  from public, anon, authenticated, service_role;
revoke execute on function app_private.bump_kiosk_sync_version()
  from public, anon, authenticated, service_role;
revoke execute on function app_private.broadcast_member_notification_invalidation()
  from public, anon, authenticated, service_role;
revoke execute on function app_private.can_receive_rorc_broadcast(text)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.can_read_heater_use_entry(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.can_read_heater_group_members(uuid)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.can_manage_heater_use_entry(uuid, uuid)
  from public, anon, authenticated, service_role;
revoke execute on function app_private.protect_heater_use_update()
  from public, anon, authenticated, service_role;
