alter table public.sponsor_banner_submissions
  add column if not exists stripe_invoice_sent_at timestamptz;
