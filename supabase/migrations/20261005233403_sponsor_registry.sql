create table public.sponsor_banners (
 id uuid primary key default gen_random_uuid(), source_key text unique,
 name text not null check(length(name)>0), status text not null default 'active' check(status in ('active','ordered','taken_down')),
 owner text not null default '', phone text not null default '', email text not null default '', notes text not null default '',
 artwork_url text not null default '', source_data jsonb not null default '{}',
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.sponsor_banner_years (
 banner_id uuid not null references public.sponsor_banners(id), year integer not null check(year between 1900 and 2200),
 payment_status text not null default 'unknown' check(payment_status in ('unknown','unpaid','paid','complimentary')),
 amount_cents integer check(amount_cents >= 0), paid_date date, expiration_date date,
 payment_method text not null default '', invoice_id text not null default '', payment_id text not null default '', notes text not null default '',
 updated_at timestamptz not null default now(), primary key(banner_id,year)
);
create table public.sponsor_banner_history (
 id bigint generated always as identity primary key, banner_id uuid not null references public.sponsor_banners(id),
 year integer, changed_at timestamptz not null default now(), record jsonb not null
);
alter table public.sponsor_banners enable row level security;
alter table public.sponsor_banner_years enable row level security;
alter table public.sponsor_banner_history enable row level security;
revoke all on public.sponsor_banners, public.sponsor_banner_years, public.sponsor_banner_history from anon, authenticated;
grant all on public.sponsor_banners, public.sponsor_banner_years, public.sponsor_banner_history to service_role;
grant usage, select on sequence public.sponsor_banner_history_id_seq to service_role;
create function public.record_sponsor_year_history() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if TG_OP='UPDATE' then
   insert into public.sponsor_banner_history(banner_id,year,record) values(old.banner_id,old.year,to_jsonb(old));
 end if;
 new.updated_at=now();
 return new;
end $$;
revoke all on function public.record_sponsor_year_history() from public, anon, authenticated;
grant execute on function public.record_sponsor_year_history() to service_role;
create trigger sponsor_year_history before update on public.sponsor_banner_years for each row execute function public.record_sponsor_year_history();
