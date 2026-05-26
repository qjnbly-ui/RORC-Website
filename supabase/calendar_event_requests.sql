create table if not exists public.calendar_event_requests (
  id uuid primary key default gen_random_uuid(),
  requester_member_id uuid not null references public.account_members(id) on delete cascade,
  target_event_id uuid references public.events(id) on delete set null,
  request_type text not null check (request_type in ('create', 'update', 'delete')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'canceled')),
  event_payload jsonb not null default '{}'::jsonb,
  requester_snapshot jsonb not null default '{}'::jsonb,
  review_notes text,
  reviewed_by_member_id uuid references public.account_members(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists calendar_event_requests_requester_idx
  on public.calendar_event_requests (requester_member_id, created_at desc);

create index if not exists calendar_event_requests_status_idx
  on public.calendar_event_requests (status, created_at desc);

create index if not exists calendar_event_requests_target_event_idx
  on public.calendar_event_requests (target_event_id)
  where target_event_id is not null;

create or replace function public.touch_calendar_event_requests_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_calendar_event_requests_updated_at on public.calendar_event_requests;
create trigger touch_calendar_event_requests_updated_at
before update on public.calendar_event_requests
for each row
execute function public.touch_calendar_event_requests_updated_at();

alter table public.calendar_event_requests enable row level security;

notify pgrst, 'reload schema';
