create table if not exists public.member_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_member_id uuid not null references public.account_members(id) on delete cascade,
  created_by_member_id uuid references public.account_members(id) on delete set null,
  title text not null,
  message text not null default '',
  channels jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_member_notifications_recipient_created
  on public.member_notifications (recipient_member_id, created_at desc);
