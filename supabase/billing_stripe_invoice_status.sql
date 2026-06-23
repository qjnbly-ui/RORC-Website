alter table public.billing_line_items
  add column if not exists stripe_invoice_status text;

create index if not exists idx_billing_line_items_stripe_invoice_status
  on public.billing_line_items (stripe_invoice_status)
  where stripe_invoice_status is not null;
