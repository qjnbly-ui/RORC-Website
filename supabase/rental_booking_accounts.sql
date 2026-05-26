-- Rental booking account claim flow, step 2.
-- Run after the base schema, rental_requests migrations, and rental_booking_accounts_step_1_enum.sql.

create extension if not exists "pgcrypto";

insert into public.account_type_permissions (
  account_type,
  can_sign_in,
  can_manage_members,
  bypass_time_windows,
  allowed_days,
  allowed_start_time,
  allowed_end_time,
  notes
) values (
  'Rental Account',
  false,
  false,
  false,
  '{}'::smallint[],
  null,
  null,
  'Limited booking portal account; no facility sign-in privileges.'
)
on conflict (account_type) do update set
  can_sign_in = excluded.can_sign_in,
  can_manage_members = excluded.can_manage_members,
  bypass_time_windows = excluded.bypass_time_windows,
  allowed_days = excluded.allowed_days,
  allowed_start_time = excluded.allowed_start_time,
  allowed_end_time = excluded.allowed_end_time,
  notes = excluded.notes,
  updated_at = now();

alter table public.rental_requests
  add column if not exists booking_number text,
  add column if not exists claim_token_hash text,
  add column if not exists claim_token_expires_at timestamptz,
  add column if not exists claimed_account_id uuid references public.accounts(id) on delete set null,
  add column if not exists claimed_member_id uuid references public.account_members(id) on delete set null,
  add column if not exists claimed_at timestamptz;

create unique index if not exists idx_rental_requests_booking_number_unique
  on public.rental_requests (booking_number)
  where booking_number is not null;

create unique index if not exists idx_rental_requests_claim_token_hash_unique
  on public.rental_requests (claim_token_hash)
  where claim_token_hash is not null;

create index if not exists idx_rental_requests_claimed_member_id
  on public.rental_requests (claimed_member_id);

create index if not exists idx_rental_requests_claimed_account_id
  on public.rental_requests (claimed_account_id);

create table if not exists public.rental_booking_sequences (
  booking_year integer primary key,
  last_value integer not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.rental_booking_sequences (booking_year, last_value)
select
  (match_values.parts)[1]::integer as booking_year,
  max((match_values.parts)[2]::integer) as last_value
from public.rental_requests
cross join lateral regexp_match(booking_number, '^RORC-([0-9]{4})-([0-9]+)$') as match_values(parts)
where booking_number ~ '^RORC-[0-9]{4}-[0-9]+$'
group by (match_values.parts)[1]::integer
on conflict (booking_year) do update set
  last_value = greatest(public.rental_booking_sequences.last_value, excluded.last_value),
  updated_at = now();

drop trigger if exists trg_rental_booking_sequences_updated_at on public.rental_booking_sequences;
create trigger trg_rental_booking_sequences_updated_at
before update on public.rental_booking_sequences
for each row
execute function public.set_updated_at();

create or replace function public.next_rental_booking_number(event_date_value date)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  target_year integer;
  next_value integer;
begin
  target_year := coalesce(extract(year from event_date_value)::integer, extract(year from timezone('America/Los_Angeles', now()))::integer);

  insert into public.rental_booking_sequences (booking_year, last_value)
  values (target_year, 1)
  on conflict (booking_year) do update
    set last_value = public.rental_booking_sequences.last_value + 1,
        updated_at = now()
  returning last_value into next_value;

  return 'RORC-' || target_year::text || '-' || lpad(next_value::text, 4, '0');
end;
$$;

create or replace function public.set_rental_booking_number()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if nullif(btrim(coalesce(new.booking_number, '')), '') is null then
    new.booking_number := public.next_rental_booking_number(new.event_date);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_set_rental_booking_number on public.rental_requests;
create trigger trg_set_rental_booking_number
before insert on public.rental_requests
for each row
execute function public.set_rental_booking_number();

do $$
declare
  rental_row record;
begin
  for rental_row in
    select id, event_date
    from public.rental_requests
    where booking_number is null or btrim(booking_number) = ''
    order by event_date nulls last, created_at, id
  loop
    update public.rental_requests
    set booking_number = public.next_rental_booking_number(rental_row.event_date)
    where id = rental_row.id;
  end loop;
end $$;

create table if not exists public.rental_change_requests (
  id uuid primary key default gen_random_uuid(),
  rental_request_id uuid not null references public.rental_requests(id) on delete cascade,
  requester_member_id uuid not null references public.account_members(id) on delete cascade,
  request_type text not null default 'update',
  status text not null default 'pending',
  requested_payload jsonb not null default '{}'::jsonb,
  requester_snapshot jsonb not null default '{}'::jsonb,
  review_notes text,
  reviewed_by_member_id uuid references public.account_members(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rental_change_requests_type_valid check (request_type in ('update', 'cancel')),
  constraint rental_change_requests_status_valid check (status in ('pending', 'approved', 'rejected', 'canceled'))
);

create index if not exists idx_rental_change_requests_rental_status
  on public.rental_change_requests (rental_request_id, status, created_at desc);

create index if not exists idx_rental_change_requests_requester
  on public.rental_change_requests (requester_member_id, created_at desc);

drop trigger if exists trg_rental_change_requests_updated_at on public.rental_change_requests;
create trigger trg_rental_change_requests_updated_at
before update on public.rental_change_requests
for each row
execute function public.set_updated_at();

alter table public.rental_change_requests enable row level security;

drop policy if exists rental_change_requests_admin_all on public.rental_change_requests;
create policy rental_change_requests_admin_all on public.rental_change_requests
for all using (public.is_admin())
with check (public.is_admin());

drop policy if exists rental_change_requests_requester_read on public.rental_change_requests;
create policy rental_change_requests_requester_read on public.rental_change_requests
for select using (requester_member_id = public.current_account_member_id());

drop policy if exists rental_change_requests_requester_insert on public.rental_change_requests;
create policy rental_change_requests_requester_insert on public.rental_change_requests
for insert with check (
  requester_member_id = public.current_account_member_id()
  and status = 'pending'
);

drop policy if exists rental_requests_claimed_member_read on public.rental_requests;
create policy rental_requests_claimed_member_read on public.rental_requests
for select using (
  claimed_member_id = public.current_account_member_id()
  or public.is_admin()
);

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin
      execute 'alter publication supabase_realtime add table public.rental_change_requests';
    exception
      when duplicate_object then null;
      when undefined_object then null;
    end;
  end if;
end $$;
