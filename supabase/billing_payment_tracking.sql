alter table public.billing_line_items
  add column if not exists payment_method text,
  add column if not exists payment_recorded_at timestamptz,
  add column if not exists payment_recorded_by_member_id uuid references public.account_members(id) on delete set null,
  add column if not exists payment_note text,
  add column if not exists stripe_invoice_id text,
  add column if not exists stripe_invoice_url text;

alter table public.billing_line_items
  drop constraint if exists billing_line_items_payment_method_valid,
  add constraint billing_line_items_payment_method_valid
    check (payment_method is null or payment_method in ('cash', 'check', 'stripe_invoice', 'other'));

alter table public.billing_line_items
  drop constraint if exists billing_line_items_payment_recorded_by_member_id_fkey,
  add constraint billing_line_items_payment_recorded_by_member_id_fkey
    foreign key (payment_recorded_by_member_id) references public.account_members(id) on delete set null;

create index if not exists idx_billing_line_items_payment_method
  on public.billing_line_items (payment_method, payment_recorded_at desc);

create index if not exists idx_billing_line_items_stripe_invoice_id
  on public.billing_line_items (stripe_invoice_id)
  where stripe_invoice_id is not null;
