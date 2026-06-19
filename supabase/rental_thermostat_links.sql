create table if not exists public.rental_thermostat_links (
  rental_request_id uuid not null references public.rental_requests(id) on delete cascade,
  heater_use_entry_id uuid not null references public.heater_use_entries(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by_member_id uuid references public.account_members(id) on delete set null,
  ignored_at timestamptz,
  primary key (rental_request_id, heater_use_entry_id)
);

create index if not exists idx_rental_thermostat_links_heater_use_entry
  on public.rental_thermostat_links (heater_use_entry_id);

create index if not exists idx_rental_thermostat_links_open
  on public.rental_thermostat_links (rental_request_id, ignored_at);

alter table public.rental_thermostat_links enable row level security;

drop policy if exists rental_thermostat_links_admin_read on public.rental_thermostat_links;
create policy rental_thermostat_links_admin_read on public.rental_thermostat_links
for select using (public.is_admin());

drop policy if exists rental_thermostat_links_admin_write on public.rental_thermostat_links;
create policy rental_thermostat_links_admin_write on public.rental_thermostat_links
for all using (public.is_admin())
with check (public.is_admin());
