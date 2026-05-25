-- Adds AC use tracking to rental requests.
alter table public.rental_requests
  add column if not exists addon_ac boolean not null default false;
