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

alter table public.rental_requests enable row level security;

-- Anonymous users can submit rental requests (as long as agreements are checked)
drop policy if exists rental_requests_anon_insert on public.rental_requests;
create policy rental_requests_anon_insert on public.rental_requests
for insert
to anon, authenticated
with check (
  agreed_to_no_guarantee = true
  and agreed_to_guidelines = true
);

-- Only admins can view and manage submissions
drop policy if exists rental_requests_admin_all on public.rental_requests;
create policy rental_requests_admin_all on public.rental_requests
for all using (public.is_admin())
with check (public.is_admin());

-- Enqueue an admin_sms automation job when a new rental request is submitted
create or replace function public.enqueue_rental_request_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.automation_jobs (kind, payload)
  values (
    'admin_sms',
    jsonb_build_object(
      'alert_kind', 'rental_request',
      'rental_request_id', new.id,
      'contact_name', new.contact_name,
      'contact_phone', new.contact_phone,
      'contact_email', new.contact_email,
      'event_type', new.event_type,
      'event_date', new.event_date::text,
      'event_start_time', new.event_start_time,
      'event_end_time', new.event_end_time,
      'public_event_start_time', new.public_event_start_time,
      'public_event_end_time', new.public_event_end_time,
      'estimated_attendance', new.estimated_attendance,
      'estimated_total_cents', new.estimated_total_cents,
      'submitted_at', new.created_at
    )
  );
  return new;
end;
$$;

drop trigger if exists trg_enqueue_rental_request_notification on public.rental_requests;
create trigger trg_enqueue_rental_request_notification
after insert on public.rental_requests
for each row
execute function public.enqueue_rental_request_notification();
