create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.scheduled_member_messages (
  id uuid primary key default gen_random_uuid(),
  created_by_member_id uuid references public.account_members(id) on delete set null,
  rental_request_id uuid references public.rental_requests(id) on delete set null,
  title text not null,
  message text not null default '',
  member_ids jsonb not null default '[]'::jsonb,
  channels jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz not null,
  schedule_label text,
  dispatch_id uuid not null default gen_random_uuid(),
  status text not null default 'scheduled',
  sent_at timestamptz,
  canceled_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_member_messages_status_valid check (
    status in ('scheduled', 'processing', 'sent', 'failed', 'canceled')
  ),
  constraint scheduled_member_messages_member_ids_array check (
    jsonb_typeof(member_ids) = 'array'
  )
);

create index if not exists idx_scheduled_member_messages_due
  on public.scheduled_member_messages (status, scheduled_for);

create index if not exists idx_scheduled_member_messages_rental
  on public.scheduled_member_messages (rental_request_id, scheduled_for desc);

drop trigger if exists trg_scheduled_member_messages_updated_at on public.scheduled_member_messages;
create trigger trg_scheduled_member_messages_updated_at
before update on public.scheduled_member_messages
for each row
execute function public.set_updated_at();

alter table public.scheduled_member_messages enable row level security;

drop policy if exists scheduled_member_messages_admin_all on public.scheduled_member_messages;
create policy scheduled_member_messages_admin_all on public.scheduled_member_messages
for all
using (
  exists (
    select 1 from public.account_members m
    where m.auth_user_id = auth.uid()
      and m.account_type = 'Account Manager'
  )
)
with check (
  exists (
    select 1 from public.account_members m
    where m.auth_user_id = auth.uid()
      and m.account_type = 'Account Manager'
  )
);
