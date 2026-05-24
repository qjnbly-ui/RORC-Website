alter table public.rental_requests
  add column if not exists public_event_start_time text,
  add column if not exists public_event_end_time text;
