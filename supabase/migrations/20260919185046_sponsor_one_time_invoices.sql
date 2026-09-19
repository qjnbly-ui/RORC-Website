-- Apply before deploying the sponsor invoice action. Existing RLS remains in force.
alter table public.sponsor_banner_submissions
  add column if not exists stripe_invoice_id text,
  add column if not exists stripe_invoice_url text,
  add column if not exists stripe_invoice_status text,
  add column if not exists invoice_started_at timestamptz;
create unique index if not exists sponsor_banner_invoice_unique
  on public.sponsor_banner_submissions (stripe_invoice_id)
  where stripe_invoice_id is not null;
