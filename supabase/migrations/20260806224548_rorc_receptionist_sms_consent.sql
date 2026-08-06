create table if not exists public.rorc_receptionist_sms_consent (
  phone_e164 text primary key,
  consent_status text not null default 'opt_out' check (consent_status in ('opt_in', 'opt_out')),
  consent_source text,
  consented_at timestamptz,
  opted_out_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint rorc_receptionist_sms_phone_check check (phone_e164 ~ '^\\+[1-9][0-9]{7,14}$')
);

create index if not exists rorc_receptionist_sms_status_idx
  on public.rorc_receptionist_sms_consent (consent_status);

drop trigger if exists rorc_receptionist_sms_set_updated_at on public.rorc_receptionist_sms_consent;
create trigger rorc_receptionist_sms_set_updated_at
before update on public.rorc_receptionist_sms_consent
for each row execute function public.set_updated_at();

alter table public.rorc_receptionist_sms_consent enable row level security;
revoke all on table public.rorc_receptionist_sms_consent from anon, authenticated;
grant select, insert, update on table public.rorc_receptionist_sms_consent to service_role;
