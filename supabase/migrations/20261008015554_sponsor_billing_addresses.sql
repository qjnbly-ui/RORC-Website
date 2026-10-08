alter table public.sponsor_banners add column if not exists billing_address jsonb not null default '{}'::jsonb;
alter table public.sponsor_banner_submissions add column if not exists billing_address jsonb not null default '{}'::jsonb;
comment on column public.sponsor_banners.billing_address is 'Private billing address; never publish in sponsor gallery.';
comment on column public.sponsor_banner_submissions.billing_address is 'Private billing address supplied for banner billing.';
