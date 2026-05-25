alter table public.rental_requests
  add column if not exists is_private_event boolean not null default true,
  add column if not exists special_access_discount boolean not null default false;
