create table if not exists public.sponsor_banner_submissions (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  sponsorship_type text not null,
  amount_cents integer not null,
  business_name text not null,
  contact_name text not null,
  email_address text not null,
  phone_number text,
  banner_text text,
  design_requests text,
  payment_method text not null,
  price_acknowledged boolean not null default false,
  logo_files jsonb not null default '[]'::jsonb,
  status text not null default 'submitted',
  constraint sponsor_banner_submissions_type_valid check (sponsorship_type in ('new', 'renewal')),
  constraint sponsor_banner_submissions_amount_valid check (amount_cents in (12500, 10000)),
  constraint sponsor_banner_submissions_payment_method_valid check (payment_method in ('mail_check', 'stripe_invoice')),
  constraint sponsor_banner_submissions_status_valid check (status in ('submitted', 'invoiced', 'paid', 'complete', 'canceled'))
);

create index if not exists idx_sponsor_banner_submissions_created_at
  on public.sponsor_banner_submissions (created_at desc);

create index if not exists idx_sponsor_banner_submissions_status
  on public.sponsor_banner_submissions (status, created_at desc);

alter table public.sponsor_banner_submissions enable row level security;

drop policy if exists sponsor_banner_submissions_admin_read on public.sponsor_banner_submissions;
create policy sponsor_banner_submissions_admin_read on public.sponsor_banner_submissions
for select using (public.is_admin());

drop policy if exists sponsor_banner_submissions_admin_write on public.sponsor_banner_submissions;
create policy sponsor_banner_submissions_admin_write on public.sponsor_banner_submissions
for all using (public.is_admin())
with check (public.is_admin());

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'sponsor-submissions',
  'sponsor-submissions',
  false,
  10485760,
  array['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'application/pdf']::text[]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;
