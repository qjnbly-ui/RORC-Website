-- Explicit delegation preserves separate accounts, member IDs and existing logins.
create table public.member_account_access (
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  account_member_id uuid not null references public.account_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (auth_user_id, account_member_id)
);
alter table public.member_account_access enable row level security;
revoke all on public.member_account_access from public, anon, authenticated;
grant select on public.member_account_access to authenticated;
grant all on public.member_account_access to service_role;
create policy member_account_access_self_read on public.member_account_access
  for select to authenticated using (auth_user_id = (select auth.uid()));

-- Headers select scope, never grant access. No header retains the original login.
create or replace function public.current_account_member_id() returns uuid
language plpgsql stable security definer set search_path = '' as $$
declare requested text; target uuid;
begin
  if auth.uid() is null then return null; end if;
  requested := nullif(coalesce(nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-rorc-account-member', ''), '');
  if requested is null then
    select id into target from public.account_members where auth_user_id = auth.uid() order by created_at, id limit 1;
    return target;
  end if;
  begin target := requested::uuid; exception when invalid_text_representation then return null; end;
  if exists (select 1 from public.account_members m where m.id = target and
    (m.auth_user_id = auth.uid() or (m.account_type <> 'Account Manager' and exists (
      select 1 from public.member_account_access a where a.auth_user_id = auth.uid() and a.account_member_id = m.id)))) then
    return target;
  end if;
  return null;
end;
$$;
create or replace function public.current_account_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select account_id from public.account_members where id = public.current_account_member_id();
$$;
revoke all on function public.current_account_member_id() from public, anon;
revoke all on function public.current_account_id() from public, anon;
grant execute on function public.current_account_member_id(), public.current_account_id() to anon, authenticated, service_role;

create schema rorc_account_private;
revoke all on schema rorc_account_private from public, anon;
grant usage on schema rorc_account_private to authenticated;

-- This minimal list does not expose another account's contact details or PIN.
create function rorc_account_private.list_my_accounts()
returns table(account_member_id uuid, account_id uuid, account_number text, member_name text, is_primary boolean)
language sql stable security definer set search_path = '' as $$
 select m.id, m.account_id, a.account_number::text, m.member_name::text, m.auth_user_id = auth.uid()
 from public.account_members m join public.accounts a on a.id = m.account_id
 where auth.uid() is not null and (m.auth_user_id = auth.uid() or
   (m.account_type <> 'Account Manager' and exists(select 1 from public.member_account_access x where x.auth_user_id = auth.uid() and x.account_member_id = m.id)))
 order by (m.auth_user_id = auth.uid()) desc, a.account_number, m.id;
$$;
revoke all on function rorc_account_private.list_my_accounts() from public, anon;
grant execute on function rorc_account_private.list_my_accounts() to authenticated;
create function public.list_my_accounts()
returns table(account_member_id uuid, account_id uuid, account_number text, member_name text, is_primary boolean)
language sql stable security invoker set search_path = '' as $$
 select * from rorc_account_private.list_my_accounts();
$$;
revoke all on function public.list_my_accounts() from public, anon;
grant execute on function public.list_my_accounts() to authenticated;

-- Existing owner permissions apply to the selected, authorized member only.
drop policy account_billing_owner_read on public.account_billing;
create policy account_billing_owner_read on public.account_billing for select to authenticated
using (is_admin() or exists(select 1 from public.account_members m where m.id = public.current_account_member_id() and m.account_id = account_billing.account_id and m.is_billing_owner));
drop policy billing_line_items_member_read on public.billing_line_items;
create policy billing_line_items_member_read on public.billing_line_items for select to authenticated
using (is_admin() or account_member_id = public.current_account_member_id() or exists (
 select 1 from public.account_members charge_member join public.account_members current_member on current_member.account_id = charge_member.account_id
 where charge_member.id = billing_line_items.account_member_id and current_member.id = public.current_account_member_id() and current_member.is_billing_owner));

-- Contact edits are deliberately narrow; delegation cannot change roles or login links.
create function rorc_account_private.update_my_account_contact(phone text, email text) returns void
language plpgsql security definer set search_path = '' as $$
declare target uuid := public.current_account_member_id();
begin
 if auth.uid() is null or target is null then raise exception 'Account access required' using errcode = '42501'; end if;
 update public.account_members set phone_number = trim(phone), email_address = lower(trim(email)) where id = target;
end;
$$;
revoke all on function rorc_account_private.update_my_account_contact(text,text) from public, anon;
grant execute on function rorc_account_private.update_my_account_contact(text,text) to authenticated;
create function public.update_my_account_contact(phone text, email text) returns void
language sql security invoker set search_path = '' as $$
 select rorc_account_private.update_my_account_contact(phone, email);
$$;
revoke all on function public.update_my_account_contact(text,text) from public, anon;
grant execute on function public.update_my_account_contact(text,text) to authenticated;
-- The existing trigger also enforces that only contact fields can change.
create or replace function public.protect_account_member_update() returns trigger
language plpgsql set search_path = '' as $$
begin
 if auth.uid() is null or public.is_admin() then return new; end if;
 if old.auth_user_id is distinct from auth.uid() and old.id is distinct from public.current_account_member_id() then
   raise exception 'Only an authorized member can update this account member row.';
 end if;
 if (to_jsonb(new) - 'phone_number' - 'email_address' - 'image_path' - 'updated_at') is distinct from
    (to_jsonb(old) - 'phone_number' - 'email_address' - 'image_path' - 'updated_at') then
   raise exception 'Members can only update their own contact fields.';
 end if;
 return new;
end;
$$;

-- Shared organization emails cannot grant ownership of already claimed rentals.
create or replace function public.apply_recurring_rental_operation(actor_id uuid, operation_id uuid, command jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=public,pg_temp as $$
declare actor public.account_members; previous public.recurring_rental_operations; target public.rental_requests;
  r public.rental_requests; item jsonb; patch jsonb; ids uuid[]; results uuid[]:='{}'; mode text:=command->>'action';
  scope text:=coalesce(command->>'scope','this'); manager boolean; saved_command jsonb:=command;
  requester public.account_members; request_group uuid; request_row public.rental_change_requests; output jsonb; hours numeric; base numeric;
begin
  perform pg_advisory_xact_lock(72667201);
  select * into actor from public.account_members where id=actor_id;
  if actor.id is null then raise exception 'Member not found' using errcode='42501'; end if;
  manager:=actor.account_type::text='Account Manager';
  select * into previous from public.recurring_rental_operations where id=operation_id;
  if found then
    if previous.actor_member_id<>actor_id or previous.command<>command then raise exception 'Operation key already used for another request' using errcode='23505'; end if;
    return previous.result;
  end if;
  if mode not in ('create','update','cancel','request_update','request_cancel','approve','reject') or scope not in ('this','following','all') then raise exception 'Invalid operation' using errcode='22023'; end if;
  if mode in ('create','update','cancel','approve','reject') and not manager then raise exception 'Manager access required' using errcode='42501'; end if;
  if mode='create' then
    if jsonb_typeof(command->'rentals')<>'array' or jsonb_array_length(command->'rentals') not between 1 and 240 then raise exception 'Choose 1-240 rentals' using errcode='22023'; end if;
    for item in select value from jsonb_array_elements(command->'rentals') loop
      r:=jsonb_populate_record(null::public.rental_requests,item);
      insert into public.rental_requests(contact_name,contact_phone,contact_email,contact_address,event_name,event_type,event_date,event_start_time,event_end_time,
        public_event_start_time,public_event_end_time,estimated_attendance,food_or_drinks,alcohol,rental_type,rental_hours,is_private_event,special_access_discount,
        addon_tables,addon_chairs,addon_tarp,addon_heater,addon_ac,addon_cleaning_maintenance,addon_early_setup,addon_early_day_rental,addon_late_cleanup,addon_late_day_rental,
        estimated_total_cents,agreed_to_no_guarantee,agreed_to_guidelines,rental_status,admin_notes,claimed_member_id,claimed_account_id,recurring_series_id)
      values(r.contact_name,r.contact_phone,r.contact_email,r.contact_address,r.event_name,r.event_type,r.event_date,r.event_start_time,r.event_end_time,
        r.public_event_start_time,r.public_event_end_time,r.estimated_attendance,r.food_or_drinks,r.alcohol,r.rental_type,r.rental_hours,r.is_private_event,r.special_access_discount,
        r.addon_tables,r.addon_chairs,r.addon_tarp,r.addon_heater,r.addon_ac,r.addon_cleaning_maintenance,r.addon_early_setup,r.addon_early_day_rental,r.addon_late_cleanup,r.addon_late_day_rental,
        r.estimated_total_cents,true,true,'confirmed',r.admin_notes,r.claimed_member_id,r.claimed_account_id,operation_id::text) returning * into r;
      perform public.sync_recurring_rental_calendar(r,coalesce((command->>'isPublic')::boolean,false));
      results:=array_append(results,r.id);
    end loop;
  else
    patch:=coalesce(command->'patch','{}');
    if mode in ('approve','reject') then
      select * into request_row from public.rental_change_requests where id=(command->>'changeRequestId')::uuid for update;
      if request_row.id is null or request_row.recurring_operation_id is null or request_row.status<>'pending' then raise exception 'Pending series request not found' using errcode='55000'; end if;
      request_group:=request_row.recurring_operation_id;
      select * into requester from public.account_members where id=request_row.requester_member_id;
      if not exists(select 1 from public.recurring_rental_operations op where op.id=request_group and op.actor_member_id=requester.id and op.command->>'action' in ('request_update','request_cancel'))
         or exists(select 1 from public.rental_change_requests where recurring_operation_id=request_group and (requester_member_id<>requester.id or request_type<>request_row.request_type or requested_payload<>request_row.requested_payload)) then
        raise exception 'Invalid recurring review group' using errcode='42501';
      end if;

      select array_agg(rental_request_id order by rental_request_id) into ids from public.rental_change_requests where recurring_operation_id=request_group and status='pending';
      if exists(select 1 from public.rental_change_requests where recurring_operation_id=request_group and status<>'pending') then raise exception 'Series request already partially reviewed' using errcode='55000'; end if;
      patch:=request_row.requested_payload;
      if mode='approve' then mode:=case when request_row.request_type='cancel' then 'cancel' else 'update' end; end if;
    else
      select * into target from public.rental_requests where id=(command->>'rentalRequestId')::uuid for update;
      if target.id is null then raise exception 'Booking not found' using errcode='22023'; end if;
      select array_agg(id order by event_date,id) into ids from public.rental_requests where id=target.id or
        (scope<>'this' and target.recurring_series_id is not null and recurring_series_id=target.recurring_series_id and (scope='all' or event_date>=target.event_date));
    end if;
    if command ? 'expectedIds' and (select array_agg(v::uuid order by v::uuid) from jsonb_array_elements_text(command->'expectedIds') v)
       is distinct from (select array_agg(v order by v) from unnest(ids) v) then
      raise exception 'Selected bookings changed since preview; prepare a fresh request' using errcode='55000';
    end if;
    if command ? 'expectedVersions' and exists(select 1 from public.rental_requests v where v.id=any(ids)
        and (command->'expectedVersions'->>v.id::text)::timestamptz is distinct from v.updated_at) then
      raise exception 'Booking changed since preview; prepare a fresh request' using errcode='55000';
    end if;
    if cardinality(ids)>240 then raise exception 'Series exceeds 240 bookings' using errcode='22023'; end if;
    if patch ? 'event_date' and cardinality(ids)>1 then raise exception 'Date changes apply to one occurrence only' using errcode='22023'; end if;
    if exists(select 1 from jsonb_object_keys(patch) k where k not in ('event_date','event_name','event_start_time','event_end_time','public_event_start_time','public_event_end_time','message')) then raise exception 'Unsupported booking edit' using errcode='22023'; end if;
    for r in select * from public.rental_requests where id=any(ids) order by event_date,id for update loop
      if not manager and (r.claimed_member_id is distinct from actor_id and (r.claimed_member_id is not null or nullif(lower(actor.email_address::text),'') is null or lower(r.contact_email::text)<>lower(actor.email_address::text))) then raise exception 'Booking does not belong to this member' using errcode='42501'; end if;
      if request_group is not null and mode<>'reject' and r.claimed_member_id is distinct from requester.id
        and (r.claimed_member_id is not null or nullif(lower(requester.email_address::text),'') is null or lower(r.contact_email::text)<>lower(requester.email_address::text)) then
        raise exception 'Booking ownership changed; request must be reviewed again' using errcode='42501';
      end if;
      if mode like 'request_%' then
        if exists(select 1 from public.rental_change_requests where rental_request_id=r.id and status='pending') then raise exception 'Booking already has a pending request' using errcode='55000'; end if;
        insert into public.rental_change_requests(rental_request_id,requester_member_id,request_type,status,requested_payload,requester_snapshot,recurring_operation_id)
        values(r.id,actor_id,case when mode='request_cancel' then 'cancel' else 'update' end,'pending',patch,jsonb_build_object('memberId',actor.id,'accountId',actor.account_id,'name',actor.member_name),operation_id);
      elsif mode='cancel' then
        update public.rental_requests set rental_status='canceled',reviewed_at=now() where id=r.id;
        update public.events set status='cancelled' where rental_request_id=r.id;
      elsif mode='update' then
        r:=jsonb_populate_record(r,patch-'message');
        hours:=round(extract(epoch from (r.event_end_time::time-r.event_start_time::time))/3600,2);
        r.rental_hours:=case when r.rental_type='hourly' then least(9,greatest(.01,hours)) else null end;
        base:=case when not r.is_private_event then hours*500 when r.rental_type='hourly' then r.rental_hours*1000 else 10000 end;
        base:=round(base)+case when r.addon_cleaning_maintenance then 2000 else 0 end+case when r.addon_tables then 2000 else 0 end+case when r.addon_chairs then 2000 else 0 end+case when r.addon_tarp then 2000 else 0 end+
          case when r.addon_early_setup then 5000 else 0 end+case when r.addon_early_day_rental then 10000 else 0 end+case when r.addon_late_cleanup then 5000 else 0 end+case when r.addon_late_day_rental then 10000 else 0 end;
        r.estimated_total_cents:=round(base*case when r.special_access_discount then .8 else 1 end);
        update public.rental_requests set event_name=r.event_name,event_date=r.event_date,event_start_time=r.event_start_time,event_end_time=r.event_end_time,
          public_event_start_time=r.public_event_start_time,public_event_end_time=r.public_event_end_time,rental_hours=r.rental_hours,estimated_total_cents=r.estimated_total_cents,reviewed_at=now() where id=r.id;
        perform public.sync_recurring_rental_calendar(r);
      end if;
      results:=array_append(results,r.id);
    end loop;
    if request_group is not null then
      update public.rental_change_requests set status=case when mode='reject' then 'rejected' else 'approved' end,reviewed_by_member_id=actor_id,reviewed_at=now(),review_notes=command->>'reviewNotes' where recurring_operation_id=request_group;
    end if;
  end if;
  output:=jsonb_build_object('success',true,'rentalIds',to_jsonb(results),'pendingReview',mode like 'request_%','operationId',operation_id);
  insert into public.recurring_rental_operations(id,actor_member_id,command,result) values(operation_id,actor_id,saved_command,output);
  return output;
end $$;


notify pgrst, 'reload schema';
