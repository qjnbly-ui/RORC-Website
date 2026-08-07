create table if not exists public.rorc_receptionist_form_drafts (
  id uuid primary key default gen_random_uuid(),
  token_hash text not null unique,
  form_id text not null check (form_id in ('membership', 'rental', 'sponsor')),
  caller_phone_e164 text,
  answers jsonb not null default '{}'::jsonb,
  draft_status text not null default 'draft' check (draft_status in ('draft', 'opened', 'expired')),
  expires_at timestamptz not null,
  last_opened_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rorc_receptionist_form_drafts_token_hash_check check (token_hash ~ '^[a-f0-9]{64}$'),
  constraint rorc_receptionist_form_drafts_phone_check check (
    caller_phone_e164 is null or caller_phone_e164 ~ E'^\\+[1-9][0-9]{7,14}$'
  ),
  constraint rorc_receptionist_form_drafts_answers_object_check check (jsonb_typeof(answers) = 'object')
);

create index if not exists rorc_receptionist_form_drafts_expires_idx
  on public.rorc_receptionist_form_drafts (expires_at);

drop trigger if exists rorc_receptionist_form_drafts_set_updated_at on public.rorc_receptionist_form_drafts;
create trigger rorc_receptionist_form_drafts_set_updated_at
before update on public.rorc_receptionist_form_drafts
for each row execute function public.set_updated_at();

alter table public.rorc_receptionist_form_drafts enable row level security;
revoke all on table public.rorc_receptionist_form_drafts from anon, authenticated;
grant select, insert, update, delete on table public.rorc_receptionist_form_drafts to service_role;
