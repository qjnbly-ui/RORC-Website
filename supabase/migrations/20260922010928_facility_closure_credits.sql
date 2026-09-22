-- Manager-only API owns all reads and writes. No browser grants or policies.
begin;
create table public.facility_closure_credits (
  id uuid primary key default gen_random_uuid(),
  starts_on date not null,
  reopens_on date not null,
  reason text not null check (length(reason) between 1 and 200),
  status text not null default 'draft' check (status in ('draft','applying','applied','canceled')),
  created_by uuid not null references public.account_members(id),
  created_at timestamptz not null default now(),
  approved_by uuid references public.account_members(id),
  approved_at timestamptz,
  check (reopens_on > starts_on and reopens_on - starts_on <= 366)
);
create table public.facility_closure_credit_accounts (
  id uuid primary key default gen_random_uuid(),
  closure_id uuid not null references public.facility_closure_credits(id),
  account_id uuid not null references public.accounts(id),
  customer_id text,
  account_label text not null,
  state text not null default 'pending' check (state in ('pending','ready','review','excluded','applying','applied')),
  amount_cents integer not null default 0 check (amount_cents >= 0),
  preview jsonb,
  fingerprint text,
  note text,
  claimed_at timestamptz,
  stripe_transaction_id text unique,
  applied_at timestamptz,
  unique (closure_id, account_id),
  unique (closure_id, customer_id),
  check (state <> 'applied' or (stripe_transaction_id is not null and applied_at is not null))
);
create index closure_credit_accounts_account_idx on public.facility_closure_credit_accounts(account_id);
create index closure_credits_created_by_idx on public.facility_closure_credits(created_by);
create index closure_credits_approved_by_idx on public.facility_closure_credits(approved_by);
alter table public.facility_closure_credits enable row level security;
alter table public.facility_closure_credit_accounts enable row level security;
revoke all on public.facility_closure_credits, public.facility_closure_credit_accounts from public, anon, authenticated;
grant select, insert, update on public.facility_closure_credits, public.facility_closure_credit_accounts to service_role;

-- Every state transition takes the closure lock, serializing approval, cancellation,
-- preview updates and claims across tabs. Stripe writes have a stable row-based key.
create function public.manage_facility_closure_credit(p_action text, p_id uuid, p_data jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  c public.facility_closure_credits;
  r public.facility_closure_credit_accounts;
  starts date;
  reopens date;
begin
  if p_action = 'create' then
    perform pg_advisory_xact_lock(74638219);
    starts := (p_data->>'starts_on')::date;
    reopens := (p_data->>'reopens_on')::date;
    if reopens > (now() at time zone 'America/Los_Angeles')::date then
      raise exception 'Enter the actual reopening date after the gym has reopened.';
    end if;
    if exists (select 1 from facility_closure_credits where status <> 'canceled'
      and starts_on < reopens and reopens_on > starts) then
      raise exception 'These dates overlap an existing closure. Open that closure or cancel its unused draft.';
    end if;
    insert into facility_closure_credits(starts_on,reopens_on,reason,created_by)
      values (starts,reopens,p_data->>'reason',(p_data->>'manager_id')::uuid) returning * into c;
    insert into facility_closure_credit_accounts(closure_id,account_id,customer_id,account_label)
      select c.id, a.id, nullif(b.stripe_customer_id,''),
        coalesce(owner.member_name,'Account') || ' · ' || coalesce(a.account_number::text,a.id::text)
      from accounts a left join account_billing b on a.id=b.account_id
      left join lateral (select member_name from account_members where account_id=a.id
        order by is_billing_owner desc nulls last,id limit 1) owner on true
      where nullif(b.stripe_customer_id,'') is not null or exists (
        select 1 from account_members m where m.account_id=a.id
          and m.account_type::text in ('Active Membership','Weight Room Only')
      );
    return to_jsonb(c);
  end if;
  select * into c from facility_closure_credits where id=p_id for update;
  if not found then raise exception 'Closure not found.'; end if;
  if p_action = 'cancel' then
    if c.status <> 'draft' then raise exception 'Only an unused draft can be canceled.'; end if;
    update facility_closure_credits set status='canceled' where id=c.id;
    return '{}'::jsonb;
  elsif p_action = 'begin' then
    if c.status in ('applying','applied') then return to_jsonb(c); end if;
    if c.status <> 'draft' then raise exception 'This closure cannot be applied.'; end if;
    if (select coalesce(jsonb_agg(jsonb_build_object('id',id,'state',state,'fingerprint',fingerprint,'amount_cents',amount_cents) order by id),'[]'::jsonb) from facility_closure_credit_accounts where closure_id=c.id) is distinct from p_data->'expected_rows' then
      raise exception 'The preview changed in another session. Refresh and review the amounts again.';
    end if;
    if exists(select 1 from facility_closure_credit_accounts where closure_id=c.id and state in ('pending','review')) then
      raise exception 'Finish previewing and resolve or exclude every account needing review first.';
    end if;
    if not exists(select 1 from facility_closure_credit_accounts where closure_id=c.id and state='ready' and amount_cents>0) then
      raise exception 'There are no credits to apply.';
    end if;
    update facility_closure_credits set status='applying',approved_by=(p_data->>'manager_id')::uuid,approved_at=now() where id=c.id;
    return '{}'::jsonb;
  end if;
  select * into r from facility_closure_credit_accounts where closure_id=c.id and id=(p_data->>'row_id')::uuid for update;
  if not found then raise exception 'Account adjustment not found.'; end if;
  if p_action = 'preview' then
    if c.status <> 'draft' or r.state in ('excluded','applying','applied') then raise exception 'This preview is locked.'; end if;
    update facility_closure_credit_accounts set preview=p_data->'preview',
      amount_cents=(p_data->'preview'->>'amount')::integer,
      fingerprint=p_data->'preview'->>'fingerprint',
      state=case when jsonb_array_length(p_data->'preview'->'warnings')>0 then 'review' else 'ready' end,
      note=null where id=r.id;
  elsif p_action = 'exclude' then
    if c.status not in ('draft','applying') or r.state in ('applying','applied') then raise exception 'This adjustment cannot be excluded.'; end if;
    if length(trim(coalesce(p_data->>'note',''))) = 0 then raise exception 'An exclusion reason is required.'; end if;
    update facility_closure_credit_accounts set state='excluded',note=left(p_data->>'note',500) where id=r.id;
  elsif p_action = 'claim' then
    if c.status <> 'applying' then raise exception 'Approve the preview before applying credits.'; end if;
    if r.state='applied' then return to_jsonb(r); end if;
    if r.state='applying' and r.claimed_at > now()-interval '2 minutes' then
      raise exception 'This credit is processing. Wait two minutes before retrying.';
    end if;
    if r.state not in ('ready','applying') or r.amount_cents<=0 then raise exception 'This account is not ready for a credit.'; end if;
    update facility_closure_credit_accounts set state='applying',claimed_at=now() where id=r.id returning * into r;
    return to_jsonb(r);
  elsif p_action = 'review' then
    if r.state <> 'applying' then raise exception 'Adjustment is not processing.'; end if;
    update facility_closure_credit_accounts set state='review',note=left(p_data->>'note',500) where id=r.id;
  elsif p_action = 'finish' then
    if r.state='applied' and r.stripe_transaction_id=p_data->>'transaction_id' then return to_jsonb(r); end if;
    if r.state <> 'applying' then raise exception 'Adjustment is not processing.'; end if;
    update facility_closure_credit_accounts set state='applied',stripe_transaction_id=p_data->>'transaction_id',applied_at=now(),note=null where id=r.id;
  else raise exception 'Unknown closure action.';
  end if;
  if c.status='applying' and not exists(select 1 from facility_closure_credit_accounts
    where closure_id=c.id and (state in ('pending','review','applying') or (state='ready' and amount_cents>0))) then
    update facility_closure_credits set status='applied' where id=c.id;
  end if;
  select * into r from facility_closure_credit_accounts where id=r.id;
  return to_jsonb(r);
end;
$$;
revoke all on function public.manage_facility_closure_credit(text,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.manage_facility_closure_credit(text,uuid,jsonb) to service_role;
commit;
