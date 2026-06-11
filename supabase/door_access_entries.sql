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

alter table public.door_access_entries enable row level security;

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
