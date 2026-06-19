alter table public.rental_requests
  add column if not exists payment_status text not null default 'unbilled',
  add column if not exists billing_finalized_at timestamptz,
  add column if not exists billing_finalized_by_member_id uuid references public.account_members(id) on delete set null;

alter table public.rental_requests
  drop constraint if exists rental_requests_payment_status_valid,
  add constraint rental_requests_payment_status_valid
    check (payment_status in ('unbilled', 'unpaid', 'paid', 'waived'));

create index if not exists idx_rental_requests_payment_status
  on public.rental_requests (payment_status, event_date desc);

alter table public.billing_line_items
  add column if not exists rental_request_id uuid references public.rental_requests(id) on delete cascade;

alter table public.billing_line_items
  drop constraint if exists billing_line_items_rental_request_id_fkey,
  add constraint billing_line_items_rental_request_id_fkey
    foreign key (rental_request_id) references public.rental_requests(id) on delete cascade;

create index if not exists idx_billing_line_items_rental_request_id
  on public.billing_line_items (rental_request_id);

create unique index if not exists idx_billing_line_items_rental_fee_unique
  on public.billing_line_items (rental_request_id)
  where rental_request_id is not null;
