create extension if not exists pgcrypto;
create extension if not exists citext;
create role anon; create role authenticated; create role service_role;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create function public.set_updated_at() returns trigger language plpgsql as $$begin new.updated_at=now();return new;end$$;
create table public.accounts(id uuid primary key);
create table public.account_members(id uuid primary key, auth_user_id uuid, account_id uuid, account_type text, member_name text,email_address text);
-- Rental request status enum
do $$
begin
  if not exists (select 1 from pg_type where typname = 'rental_status') then
    create type public.rental_status as enum (
      'submitted',
      'pending_review',
      'confirmed',
      'rejected',
      'canceled'
    );
  end if;
end $$;

create table if not exists public.rental_requests (
  id uuid primary key default gen_random_uuid(),

  -- Contact info
  contact_name text not null,
  contact_phone text not null,
  contact_email citext not null,
  contact_address text not null,

  -- Event details
  event_type text not null,
  event_date date not null,
  event_start_time text not null,
  event_end_time text not null,
  public_event_start_time text,
  public_event_end_time text,
  estimated_attendance integer not null,
  food_or_drinks boolean not null default false,
  alcohol text not null default 'No',
  rental_type text not null default 'all_day',
  rental_hours numeric(5,2),
  is_private_event boolean not null default true,
  special_access_discount boolean not null default false,

  -- Equipment & add-ons
  addon_tables boolean not null default false,
  addon_chairs boolean not null default false,
  addon_tarp boolean not null default false,
  addon_heater boolean not null default false,
  addon_cleaning_maintenance boolean not null default false,
  addon_ac boolean not null default false,
  addon_early_setup boolean not null default false,
  addon_early_day_rental boolean not null default false,
  addon_late_cleanup boolean not null default false,
  addon_late_day_rental boolean not null default false,

  -- Estimated cost in cents (calculated client-side, stored for reference)
  estimated_total_cents integer not null default 0,

  -- Agreements
  agreed_to_no_guarantee boolean not null default false,
  agreed_to_guidelines boolean not null default false,

  -- Admin fields
  rental_status public.rental_status not null default 'submitted',
  admin_notes text,
  reviewed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint rental_requests_agreements_required check (
    agreed_to_no_guarantee = true and agreed_to_guidelines = true
  ),
  constraint rental_requests_alcohol_valid check (
    alcohol in ('Yes', 'No', 'Maybe')
  ),
  constraint rental_requests_event_type_valid check (
    event_type in ('Birthday Party', 'Private Party', 'Meeting', 'Memorial Service', 'Other')
  ),
  constraint rental_requests_rental_type_valid check (
    rental_type in ('all_day', 'hourly')
  ),
  constraint rental_requests_rental_hours_valid check (
    rental_hours is null or (rental_hours > 0 and rental_hours <= 9)
  ),
  constraint rental_requests_attendance_positive check (
    estimated_attendance > 0
  )
);

create index if not exists idx_rental_requests_created_at
  on public.rental_requests (created_at desc);

create index if not exists idx_rental_requests_status
  on public.rental_requests (rental_status, created_at desc);

create index if not exists idx_rental_requests_event_date
  on public.rental_requests (event_date);

drop trigger if exists trg_rental_requests_updated_at on public.rental_requests;
create trigger trg_rental_requests_updated_at
before update on public.rental_requests
for each row
execute function public.set_updated_at();


alter table public.rental_requests add column event_name text,add column claimed_member_id uuid,add column claimed_account_id uuid,add column billing_finalized_at timestamptz,add column payment_status text not null default 'unbilled';
create table public.billing_line_items(id uuid primary key default gen_random_uuid(),rental_request_id uuid references public.rental_requests(id) on delete cascade,amount_cents integer,posted_to_stripe_at timestamptz,stripe_invoice_id text);
create table public.events(id uuid primary key default gen_random_uuid(),title text,event_type text,start_at timestamptz,end_at timestamptz,all_day boolean default false,is_public boolean default false,status text default 'confirmed',rental_request_id uuid references public.rental_requests(id),created_by text,created_at timestamptz default now(),updated_at timestamptz default now());
create table public.rental_change_requests(id uuid primary key default gen_random_uuid(),rental_request_id uuid references public.rental_requests(id),requester_member_id uuid references public.account_members(id),request_type text,status text default 'pending',requested_payload jsonb,requester_snapshot jsonb,review_notes text,reviewed_by_member_id uuid,reviewed_at timestamptz,created_at timestamptz default now(),updated_at timestamptz default now());
grant all on all tables in schema public to service_role;
grant usage on schema auth to service_role;
insert into account_members values('11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111112',null,'Account Manager','Test Manager','manager@example.invalid'),('22222222-2222-4222-8222-222222222222','22222222-2222-4222-8222-222222222223',null,'Rental Account','Test Renter','renter@example.invalid'),('33333333-3333-4333-8333-333333333333','33333333-3333-4333-8333-333333333334',null,'Rental Account','Other Renter','other@example.invalid');
