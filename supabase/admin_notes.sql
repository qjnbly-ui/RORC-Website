create table if not exists public.admin_notes (
  id uuid primary key default gen_random_uuid(),
  note_text text not null,
  is_done boolean not null default false,
  created_by_member_id uuid references public.account_members(id) on delete set null,
  completed_by_member_id uuid references public.account_members(id) on delete set null,
  archived_by_member_id uuid references public.account_members(id) on delete set null,
  completed_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint admin_notes_note_text_not_empty check (length(btrim(note_text)) > 0)
);

create index if not exists idx_admin_notes_active
  on public.admin_notes (created_at desc)
  where archived_at is null;

drop trigger if exists trg_admin_notes_updated_at on public.admin_notes;
create trigger trg_admin_notes_updated_at
before update on public.admin_notes
for each row execute function public.set_updated_at();

alter table public.admin_notes enable row level security;

drop policy if exists admin_notes_admin_only on public.admin_notes;
create policy admin_notes_admin_only on public.admin_notes
for all using (public.is_admin())
with check (public.is_admin());
