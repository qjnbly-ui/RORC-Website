-- Transactional recurring rentals. Apply only after the rental booking/billing schemas.
-- No production application is performed by this change.
alter table public.rental_requests add column if not exists recurring_series_id text;
create index if not exists rental_requests_recurring_series_idx on public.rental_requests(recurring_series_id, event_date);
alter table public.rental_change_requests add column if not exists recurring_operation_id uuid;
create index if not exists rental_change_requests_recurring_operation_idx on public.rental_change_requests(recurring_operation_id);
-- Preserve legacy calendar series markers without changing existing bookings.
update public.rental_requests r set recurring_series_id = x.series
from (select rental_request_id, min(substring(created_by from '(?:^|:)series:([a-zA-Z0-9_-]+)')) series
      from public.events where rental_request_id is not null group by rental_request_id) x
where r.id=x.rental_request_id and r.recurring_series_id is null and x.series is not null;

create table public.recurring_rental_operations (
  id uuid primary key, actor_member_id uuid not null references public.account_members(id),
  command jsonb not null, result jsonb not null, created_at timestamptz not null default now()
);
alter table public.recurring_rental_operations enable row level security;
revoke all on public.recurring_rental_operations from public, anon, authenticated;
grant all on public.recurring_rental_operations to service_role;

create or replace function public.rental_access_windows(r public.rental_requests)
returns setof tstzrange language plpgsql stable security invoker set search_path=public,pg_temp as $$
begin
  if r.event_start_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or r.event_end_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
     or r.event_start_time >= r.event_end_time then raise exception 'Invalid rental access times' using errcode='22023'; end if;
  return next tstzrange((r.event_date+r.event_start_time::time) at time zone 'America/Los_Angeles', (r.event_date+r.event_end_time::time) at time zone 'America/Los_Angeles','[)');
  if r.addon_early_day_rental or r.addon_early_setup then
    return next tstzrange(((r.event_date-1)+case when r.addon_early_day_rental then time '07:00' else time '18:00' end) at time zone 'America/Los_Angeles',((r.event_date-1)+time '21:00') at time zone 'America/Los_Angeles','[)');
  end if;
  if r.addon_late_day_rental or r.addon_late_cleanup then
    return next tstzrange(((r.event_date+1)+time '07:00') at time zone 'America/Los_Angeles',((r.event_date+1)+case when r.addon_late_day_rental then time '21:00' else time '09:00' end) at time zone 'America/Los_Angeles','[)');
  end if;
end $$;

create or replace function public.assert_rental_available(r public.rental_requests, excluded_ids uuid[] default '{}')
returns void language plpgsql volatile security invoker set search_path=public,pg_temp as $$
begin
  if exists (select 1 from public.rental_requests other cross join lateral public.rental_access_windows(other) ow
      cross join lateral public.rental_access_windows(r) nw
      where other.rental_status='confirmed' and other.id<>r.id and not(other.id=any(excluded_ids)) and ow && nw)
    or exists (select 1 from public.events e cross join lateral public.rental_access_windows(r) nw
      where e.status='confirmed' and e.event_type::text in ('rental','maintenance') and e.rental_request_id is null
        and (case when e.all_day then tstzrange(date_trunc('day',e.start_at at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles',
            (date_trunc('day',e.end_at at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles','[)')
            else tstzrange(e.start_at,e.end_at,'[)') end) && nw)
  then raise exception 'Rental access conflict on %',r.event_date using errcode='23P01'; end if;
end $$;

create schema if not exists rorc_booking_private;
revoke all on schema rorc_booking_private from public,anon,authenticated;
-- The guard must see other accounts' reservations despite caller RLS. Trigger-only
-- definer functions are placed outside exposed schemas and cannot be called directly.
-- They enforce conflicts, not additional client privileges.
-- All confirmed writes (including legacy staff/review endpoints) share this lock.
create or replace function rorc_booking_private.guard_rental_access()
returns trigger language plpgsql volatile security definer set search_path=public,pg_temp as $$
begin
  if tg_op='DELETE' then
    if old.recurring_series_id is not null or old.billing_finalized_at is not null or old.payment_status<>'unbilled' or exists(select 1 from public.billing_line_items b where b.rental_request_id=old.id) then raise exception 'Cancel this booking to retain its history' using errcode='55000'; end if;
    return old;
  end if;
  if auth.uid() is null and coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role' is distinct from 'service_role' then
    if new.rental_status='confirmed' then raise exception 'Authenticated booking required' using errcode='42501'; end if;
  end if;
  if new.rental_status='confirmed' and coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role' is distinct from 'service_role'
      and not exists(select 1 from public.account_members where auth_user_id=auth.uid() and account_type::text='Account Manager') then
    raise exception 'Manager approval required for confirmed bookings' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(72667201);
  if tg_op='UPDATE' and (old.billing_finalized_at is not null or old.payment_status in ('paid','unpaid','waived')
      or exists(select 1 from public.billing_line_items b where b.rental_request_id=old.id))
      and (new.event_date,new.event_start_time,new.event_end_time,new.rental_type,new.estimated_total_cents,
        new.addon_early_setup,new.addon_early_day_rental,new.addon_late_cleanup,new.addon_late_day_rental,new.is_private_event,new.special_access_discount,new.addon_tables,new.addon_chairs,new.addon_tarp,new.addon_cleaning_maintenance)
        is distinct from (old.event_date,old.event_start_time,old.event_end_time,old.rental_type,old.estimated_total_cents,
        old.addon_early_setup,old.addon_early_day_rental,old.addon_late_cleanup,old.addon_late_day_rental,old.is_private_event,old.special_access_discount,old.addon_tables,old.addon_chairs,old.addon_tarp,old.addon_cleaning_maintenance)
  then raise exception 'Finalized booking requires billing review before schedule edits' using errcode='55000'; end if;
  if new.rental_status='confirmed' then perform public.assert_rental_available(new); end if;
  return new;
end $$;
drop trigger if exists guard_rental_access on public.rental_requests;
create trigger guard_rental_access before insert or update or delete on public.rental_requests for each row execute function rorc_booking_private.guard_rental_access();

create or replace function rorc_booking_private.guard_standalone_calendar_access()
returns trigger language plpgsql volatile security definer set search_path=public,pg_temp as $$
declare proposed tstzrange;
begin
  perform pg_advisory_xact_lock(72667201);
  if auth.uid() is null and coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role' is distinct from 'service_role' then raise exception 'Authenticated booking required' using errcode='42501'; end if;
  if new.status<>'confirmed' or new.event_type::text not in ('rental','maintenance') or new.rental_request_id is not null then return new; end if;
  proposed:=case when new.all_day then tstzrange(date_trunc('day',new.start_at at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles',
      (date_trunc('day',new.end_at at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles','[)') else tstzrange(new.start_at,new.end_at,'[)') end;
  if exists(select 1 from public.rental_requests r cross join lateral public.rental_access_windows(r) w where r.rental_status='confirmed' and w && proposed)
      or exists(select 1 from public.events e where e.id<>new.id and e.status='confirmed' and e.event_type::text in ('rental','maintenance') and e.rental_request_id is null
        and (case when e.all_day then tstzrange(date_trunc('day',e.start_at at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles',
          (date_trunc('day',e.end_at at time zone 'America/Los_Angeles')+interval '1 day') at time zone 'America/Los_Angeles','[)') else tstzrange(e.start_at,e.end_at,'[)') end) && proposed)
  then raise exception 'Calendar access conflict' using errcode='23P01'; end if;
  return new;
end $$;
drop trigger if exists guard_standalone_calendar_access on public.events;
create trigger guard_standalone_calendar_access before insert or update on public.events for each row execute function rorc_booking_private.guard_standalone_calendar_access();

create or replace function public.sync_recurring_rental_calendar(r public.rental_requests, public_override boolean default null)
returns void language plpgsql volatile security invoker set search_path=public,pg_temp as $$
declare main_id uuid; visible boolean; item record; event_id uuid; marker text; title_value text;
begin
  select id,is_public into main_id,visible from public.events where rental_request_id=r.id
    order by (created_by like '%:calendar:main') desc,created_at,id limit 1;
  visible:=coalesce(public_override,visible,false);
  title_value:=coalesce(r.event_name,r.event_type);
  marker:=coalesce('member:'||r.claimed_member_id::text||':','')||'series:'||r.recurring_series_id||':rental:'||r.id::text;
  if main_id is null then
    insert into public.events(title,event_type,start_at,end_at,all_day,is_public,status,rental_request_id,created_by)
    values(title_value,'rental',(r.event_date+coalesce(r.public_event_start_time,r.event_start_time)::time) at time zone 'America/Los_Angeles',
      (r.event_date+coalesce(r.public_event_end_time,r.event_end_time)::time) at time zone 'America/Los_Angeles',r.rental_type<>'hourly' and r.public_event_start_time is null,visible,
      case when r.rental_status='canceled' then 'cancelled' else 'confirmed' end,r.id,marker||':calendar:main');
  else
    update public.events set title=title_value,start_at=(r.event_date+coalesce(r.public_event_start_time,r.event_start_time)::time) at time zone 'America/Los_Angeles',
      end_at=(r.event_date+coalesce(r.public_event_end_time,r.event_end_time)::time) at time zone 'America/Los_Angeles',
      all_day=r.rental_type<>'hourly' and r.public_event_start_time is null,is_public=visible,created_by=marker||':calendar:main' where id=main_id;
  end if;
  for item in select * from (values
    ('early-day',r.addon_early_day_rental,r.event_date-1,time '07:00',time '21:00'),
    ('early-setup',r.addon_early_setup and not r.addon_early_day_rental,r.event_date-1,time '18:00',time '21:00'),
    ('late-day',r.addon_late_day_rental,r.event_date+1,time '07:00',time '21:00'),
    ('late-cleanup',r.addon_late_cleanup and not r.addon_late_day_rental,r.event_date+1,time '07:00',time '09:00')
    ) as blocks(key,enabled,event_date,start_time,end_time) where enabled loop
    select id into event_id from public.events where rental_request_id=r.id and created_by like '%:calendar:'||item.key limit 1;
    if event_id is null then
      insert into public.events(title,event_type,start_at,end_at,all_day,is_public,status,rental_request_id,created_by)
      values(title_value||' - '||item.key,'rental',(item.event_date+item.start_time) at time zone 'America/Los_Angeles',
        (item.event_date+item.end_time) at time zone 'America/Los_Angeles',false,false,case when r.rental_status='canceled' then 'cancelled' else 'confirmed' end,r.id,marker||':calendar:'||item.key);
    else
      update public.events set title=title_value||' - '||item.key,start_at=(item.event_date+item.start_time) at time zone 'America/Los_Angeles',
        end_at=(item.event_date+item.end_time) at time zone 'America/Los_Angeles',created_by=marker||':calendar:'||item.key where id=event_id;
    end if;
  end loop;
end $$;
revoke execute on function public.sync_recurring_rental_calendar(public.rental_requests,boolean) from public,anon,authenticated;
grant execute on function public.sync_recurring_rental_calendar(public.rental_requests,boolean) to service_role;

-- Authenticated clients cannot attach extra rows to a service-created approval group.
create or replace function rorc_booking_private.guard_recurring_review_group()
returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
  if new.recurring_operation_id is not null and coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role' is distinct from 'service_role' then
    raise exception 'Recurring review groups require the verified server endpoint' using errcode='42501';
  end if;
  return new;
end $$;
revoke execute on function rorc_booking_private.guard_recurring_review_group() from public,anon,authenticated;
grant execute on function rorc_booking_private.guard_recurring_review_group() to service_role;
create trigger guard_recurring_review_group before insert or update on public.rental_change_requests for each row execute function rorc_booking_private.guard_recurring_review_group();
create unique index rental_change_requests_recurring_unique on public.rental_change_requests(recurring_operation_id,rental_request_id) where recurring_operation_id is not null;

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
      if not manager and (r.claimed_member_id is distinct from actor_id and (nullif(lower(actor.email_address::text),'') is null or lower(r.contact_email::text)<>lower(actor.email_address::text))) then raise exception 'Booking does not belong to this member' using errcode='42501'; end if;
      if request_group is not null and mode<>'reject' and r.claimed_member_id is distinct from requester.id
        and (nullif(lower(requester.email_address::text),'') is null or lower(r.contact_email::text)<>lower(requester.email_address::text)) then
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

-- RPC is a service-only API. The HTTP endpoint verifies the real auth user and actor.
revoke execute on function public.apply_recurring_rental_operation(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.apply_recurring_rental_operation(uuid,uuid,jsonb) to service_role;
revoke execute on function public.assert_rental_available(public.rental_requests,uuid[]) from public,anon,authenticated;
grant execute on function public.assert_rental_available(public.rental_requests,uuid[]) to service_role;
-- Trigger helpers are invoker functions, not privilege escalation entrypoints.
revoke execute on function rorc_booking_private.guard_rental_access() from public,anon,authenticated;
revoke execute on function rorc_booking_private.guard_standalone_calendar_access() from public,anon,authenticated;
grant execute on function rorc_booking_private.guard_rental_access(), rorc_booking_private.guard_standalone_calendar_access() to service_role;
notify pgrst,'reload schema';
