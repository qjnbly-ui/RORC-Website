-- Integration fixture for a database with the RORC migrations installed.
-- All tables, copied functions and activity are isolated and rolled back.
begin;
create schema rorc_sms_facility_fixture;
set local search_path=rorc_sms_facility_fixture, public;
set local plpgsql.check_asserts=on;
do $fixture$
declare tbl text; func record; definition text;
begin
  foreach tbl in array array['accounts','account_members','account_billing','account_type_permissions','billing_line_items','heater_use_entries',
    'heater_use_group_members','timesheet_entries','sms_booking_drafts','automation_settings','rorc_receptionist_sms_consent','staff_communication_threads']
  loop
    execute format('create table rorc_sms_facility_fixture.%I (like public.%I including defaults including constraints)',tbl,tbl);
  end loop;
  -- timesheet log numbers ordinarily use the facility sequence. Keep fixture IDs local.
  alter table timesheet_entries alter column log_id set default 1;
  for func in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname=any(array['account_billing_allows_access','member_can_use_heater','is_sign_in_authorized',
      'sms_facility_members','sms_facility_preview','accept_sms_facility_action'])
    order by array_position(array['account_billing_allows_access','member_can_use_heater','is_sign_in_authorized',
      'sms_facility_members','sms_facility_preview','accept_sms_facility_action'],p.proname::text)
  loop
    definition:=replace(pg_get_functiondef(func.oid),'public.','rorc_sms_facility_fixture.');
    definition:=replace(definition,'rorc_sms_facility_fixture.membership_account_type','public.membership_account_type');
    definition:=replace(definition,'''public''','''rorc_sms_facility_fixture'', ''public''');
    execute definition;
  end loop;
end $fixture$;
insert into account_type_permissions select * from public.account_type_permissions;
do $fixture$
declare
  phone text:='+15035550188'; a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid();
  m uuid:=gen_random_uuid(); family uuid:=gen_random_uuid(); other_member uuid:=gen_random_uuid();
  heat uuid:=gen_random_uuid(); cooling uuid:=gen_random_uuid(); old_heat uuid:=gen_random_uuid();
  q uuid:=gen_random_uuid(); msg uuid:=gen_random_uuid(); plan jsonb; s jsonb; r jsonb;
  today date:=(now() at time zone 'America/Los_Angeles')::date;
begin
  insert into accounts(id,account_number) values(a,'A'),(b,'B');
  insert into account_members(id,member_name,account_id,phone_number,account_type,allow_heater_use) values
    (m,'Fixture',a,'(503) 555-0188','Special Access Account',true),
    (other_member,'Fixture',b,'+1 503 555 0188','Special Access Account',true),
    (family,'Family',a,null,'Active Membership',true);
  assert (select count(*)=2 from sms_facility_members(phone)), 'shared phone resolution';
  assert (select count(*)=0 from sms_facility_members('+15035550189')), 'unknown phone';
  insert into heater_use_entries(id,used_on,responsible_member_id,system_type,turn_heater_on,end_at) values
    (heat,today,m,'heat','Off',now()),(cooling,today,m,'ac','Off',now()),
    (old_heat,(date_trunc('month',today)-interval '1 day')::date,m,'heat','Off',now());
  insert into billing_line_items(account_member_id,heater_use_entry_id,amount_cents,reason,payment_recorded_at) values
    (m,heat,1250,'Heater use',null),(family,heat,500,'Heater use group share',now()),
    (m,cooling,200,'AC use',null),(m,old_heat,800,'Heater use',null),(other_member,heat,575,'Heater use group share',null);
  s:=sms_facility_preview(phone,m);
  assert s->>'monthly'='1750' and s->>'owed'='1250', 'scoped month with family share, excluding AC and previous month';
  assert sms_facility_preview('+15035550189',m) is null, 'unlinked phone cannot read balance';
  insert into automation_settings(id,config) values('sms_booking_ai','{"enabled":true}');
  insert into staff_communication_threads(phone_e164) values(phone);
  insert into rorc_receptionist_sms_consent(phone_e164,consent_status) values(phone,'opt_in');
  plan:=jsonb_build_object('stage','confirm','member',m,'account',a,'heat','start','attendance','in','temperature',68,
    'minutes',60,'month',s->'month','monthly',1750,'owed',1250,'revision',0);
  insert into sms_booking_drafts(id,message_sid,phone_e164,message_body,status,intent,created_at,expires_at) values
    (q,'SM'||replace(q::text,'-',''),phone,'fixture request','clarification',jsonb_build_object('assistantState',jsonb_build_object('facility',plan)),now()-interval '1 minute',now()+interval '20 minutes'),
    (msg,'SM'||replace(msg::text,'-',''),phone,'sounds good','processing','{}',now(),now()+interval '20 minutes');
  update staff_communication_threads set ai_mode='never';
  assert accept_sms_facility_action(q,msg,true) is null,'staff takeover';
  update staff_communication_threads set ai_mode='automatic';
  update rorc_receptionist_sms_consent set consent_status='opt_out';
  assert accept_sms_facility_action(q,msg,true) is null,'opt-out';
  update rorc_receptionist_sms_consent set consent_status='opt_in';
  update account_members set phone_number=null where id=m;
  assert accept_sms_facility_action(q,msg,true) is null,'reassigned phone';
  update account_members set phone_number=phone where id=m;
  update sms_booking_drafts set expires_at=now()-interval '1 second' where id=q;
  assert accept_sms_facility_action(q,msg,true) is null,'expired quote';
  update sms_booking_drafts set expires_at=now()+interval '1 minute' where id=q;
  update billing_line_items set amount_cents=1300 where amount_cents=1250;
  assert accept_sms_facility_action(q,msg,true)->>'problem' like '%statement changed%', 'changed quote';
  update billing_line_items set amount_cents=1250 where amount_cents=1300;
  assert (select count(*)=0 from timesheet_entries),'no premature check-in';
  r:=accept_sms_facility_action(q,msg,true);
  assert (r->>'entry') is not null and r->>'problem'='' and r->>'attendance'='You are checked in.', 'confirmed start';
  assert (select count(*)=1 from heater_use_entries where end_at is null and responsible_member_id=m and set_a_timer and target_temperature_f=68),'single billed member and timer';
  assert accept_sms_facility_action(q,msg,true) is null,'single-use quote';
  assert (select count(*)=1 from timesheet_entries where member_id=m),'single check-in';
  update heater_use_entries set end_at=now(),turn_heater_on='Off' where end_at is null;
  update sms_booking_drafts set status='clarification' where id=q;
  r:=accept_sms_facility_action(q,msg,false);
  assert r->>'entry' is null and r->>'problem' like '%offline%' and r->>'attendance'='You were already checked in.', 'offline partial outcome';
end $fixture$;
select 'SMS database scenarios passed' as result;
rollback;
