alter table public.rental_requests
  add column if not exists rental_type text not null default 'all_day',
  add column if not exists rental_hours numeric(5,2);

alter table public.rental_requests
  alter column rental_hours type numeric(5,2)
  using case
    when rental_hours is null then null
    else nullif(rental_hours::text, '')::numeric(5,2)
  end;

alter table public.rental_requests
  drop constraint if exists rental_requests_rental_type_valid,
  drop constraint if exists rental_requests_rental_hours_valid;

alter table public.rental_requests
  add constraint rental_requests_rental_type_valid
    check (rental_type in ('all_day', 'hourly')),
  add constraint rental_requests_rental_hours_valid
    check (rental_hours is null or (rental_hours > 0 and rental_hours <= 9));
