-- Adds Standard Maintenance Fee tracking to rental requests.
alter table public.rental_requests
  add column if not exists addon_cleaning_maintenance boolean not null default false;
