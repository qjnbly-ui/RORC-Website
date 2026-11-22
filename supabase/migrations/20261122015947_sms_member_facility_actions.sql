-- Only the signed SMS ingress may resolve a sender or consume an accepted quote.
create function public.sms_facility_members(sender text)
returns table(member_id uuid, account_id uuid, label text)
language sql stable security invoker set search_path = public, pg_temp as $$
  select m.id, m.account_id, concat_ws(' · ', m.member_name, m.account_type::text, '#' || a.account_number)
  from account_members m join accounts a on a.id=m.account_id
  cross join lateral (select regexp_replace(m.phone_number, '[^0-9]', '', 'g') as digits) p
  where sender ~ '^[+][1-9][0-9]{7,14}$'
    and sender = '+' || case when length(p.digits)=10 then '1' || p.digits else p.digits end
    and m.account_type::text <> 'Kiosk Account'
  order by a.account_number, m.member_name, m.id
$$;

create function public.sms_facility_preview(sender text, actor uuid)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object('account', m.account_id, 'label', m.label,
    'canHeat', member_can_use_heater(actor) or am.account_type::text='Account Manager',
    'canEnter', am.can_access_independently and is_sign_in_authorized(actor, now()),
    'enabled', coalesce((select (config->>'heat_enabled')::boolean from automation_settings where id='thermostat_system_access'), true),
    'monthly', totals.charged, 'owed', totals.owed, 'month', to_char(month_start,'YYYY-MM'),
    'runtime', h.id, 'system', h.system_type,
    'canControl', coalesce(h.system_type='heat' and (h.responsible_member_id=actor or am.account_type::text='Account Manager'
      or (h.group_pay and exists(select 1 from heater_use_group_members g where g.heater_use_entry_id=h.id and g.account_member_id=actor))),false))
  from sms_facility_members(sender) m join account_members am on am.id=m.member_id
  cross join lateral (select date_trunc('month', now() at time zone 'America/Los_Angeles')::date as month_start) period
  cross join lateral (
    select coalesce(sum(b.amount_cents),0) charged,
      coalesce(sum(b.amount_cents) filter (where
        case when b.stripe_invoice_id is not null then b.stripe_invoice_status is distinct from 'paid'
          else b.posted_to_stripe_at is null and b.payment_recorded_at is null end),0) owed
    from billing_line_items b join account_members payer on payer.id=b.account_member_id
    join heater_use_entries run on run.id=b.heater_use_entry_id
    where payer.account_id=m.account_id and run.system_type='heat' and run.used_on >= month_start
      and run.used_on < month_start + interval '1 month'
  ) totals
  left join heater_use_entries h on h.end_at is null and h.turn_heater_on='On'
  where m.member_id=actor
$$;

create function public.accept_sms_facility_action(quote_id uuid, message_id uuid, equipment_ready boolean)
returns jsonb language plpgsql volatile security invoker set search_path = public, pg_temp as $$
declare
  q sms_booking_drafts; incoming sms_booking_drafts; plan jsonb; snapshot jsonb;
  actor uuid; runtime heater_use_entries; local_now timestamp := now() at time zone 'America/Los_Angeles';
  attendance text; heat text; temperature integer; minutes integer; until_time time;
  attendance_reply text := ''; problem text := ''; affected integer; result_data jsonb;
begin
  select * into incoming from sms_booking_drafts where id=message_id and status='processing' and expires_at>now() for update;
  if incoming.id is null then return null; end if;
  perform pg_advisory_xact_lock(hashtextextended(incoming.phone_e164, 0));
  select * into q from sms_booking_drafts where id=quote_id and phone_e164=incoming.phone_e164
    and status='clarification' and expires_at>now() for update;
  plan := q.intent #> '{assistantState,facility}';
  if plan->>'stage' is distinct from 'confirm' or q.created_at>=incoming.created_at or exists (
    select 1 from sms_booking_drafts d where d.phone_e164=incoming.phone_e164 and d.id<>incoming.id and d.created_at>q.created_at
  ) then return null; end if;
  perform 1 from rorc_receptionist_sms_consent where phone_e164=q.phone_e164 and consent_status='opt_in' for share;
  if not found then return null; end if;
  perform 1 from staff_communication_threads where phone_e164=q.phone_e164 and ai_mode='automatic'
    and (ai_paused_until is null or ai_paused_until<=now()) and ai_revision=(plan->>'revision')::bigint for share;
  if not found then return null; end if;
  perform 1 from automation_settings where id='sms_booking_ai' and config->'enabled'='true'::jsonb for share;
  if not found then return null; end if;

  actor := (plan->>'member')::uuid;
  perform 1 from account_members where id=actor for update;
  snapshot := sms_facility_preview(q.phone_e164, actor);
  if snapshot is null or snapshot->>'account' is distinct from plan->>'account' then return null; end if;
  heat := plan->>'heat'; attendance := plan->>'attendance'; temperature := (plan->>'temperature')::integer;
  minutes := (plan->>'minutes')::integer; until_time := (plan->>'until')::time;
  if heat not in ('start','adjust','off','none') or attendance not in ('in','out','none')
    or (heat in ('start','adjust') and (temperature is null or temperature not between 45 and 80))
    or (minutes is not null and minutes not between 1 and 1439) then return null; end if;

  if heat='start' and (snapshot->'monthly' is distinct from plan->'monthly' or snapshot->'owed' is distinct from plan->'owed'
      or snapshot->'month' is distinct from plan->'month') then
    return jsonb_build_object('problem','Your monthly heat statement changed. Please request a fresh quote.');
  end if;
  if attendance='in' and not (snapshot->>'canEnter')::boolean then
    return jsonb_build_object('problem','This account cannot check in at this time.');
  end if;
  if attendance='in' then
    insert into timesheet_entries(member_or_guest,member_id,signed_in_at)
      select 'Member',actor,now() where not exists(select 1 from timesheet_entries
        where member_or_guest='Member' and member_id=actor and signed_out_at is null);
    get diagnostics affected = row_count;
    attendance_reply := case when affected=0 then 'You were already checked in.' else 'You are checked in.' end;
  end if;

  if heat<>'none' then
    if heat in ('start','adjust') and (not (snapshot->>'enabled')::boolean or not (snapshot->>'canHeat')::boolean) then
      problem := 'Heat is unavailable for this account.';
    elsif heat='start' and snapshot->>'runtime' is not null then
      problem := 'A thermostat session is already running.';
    elsif heat in ('adjust','off') and (not (snapshot->>'canControl')::boolean or snapshot->>'runtime' is distinct from plan->>'runtime') then
      problem := 'The selected heater session has changed or ended.';
    elsif not equipment_ready then
      problem := 'The thermostat is offline or unavailable. I could not confirm a heater change.';
    elsif heat='start' then
      begin
        insert into heater_use_entries(used_on,responsible_member_id,system_type,turn_heater_on,start_at,target_temperature_f,set_a_timer,timer_start,timer_stop)
        values(local_now::date,actor,'heat','On',now(),temperature,minutes is not null or until_time is not null,
          local_now::time,coalesce(until_time,(local_now + make_interval(mins=>minutes))::time)) returning * into runtime;
      exception when unique_violation then problem := 'A thermostat session is already running.';
      end;
    else
      select * into runtime from heater_use_entries where id=(plan->>'runtime')::uuid and end_at is null and turn_heater_on='On' for update;
      if runtime.id is null then problem := 'The selected heater session has ended.'; end if;
    end if;
  end if;
  -- A combined stop/check-out completes check-out only after Ecobee accepts the stop.
  if attendance='out' and heat='none' then
    update timesheet_entries set signed_out_at=now() where member_or_guest='Member' and member_id=actor and signed_out_at is null;
    get diagnostics affected = row_count;
    attendance_reply := case when affected=0 then 'You were already checked out.' else 'You are checked out.' end;
  end if;
  result_data := jsonb_build_object('attendance',attendance_reply,'problem',problem,'entry',runtime.id,
    'startAt',runtime.start_at,'priorTemperature',runtime.target_temperature_f);
  update sms_booking_drafts set status='confirmed', verified_member_id=actor, result=result_data where id=q.id;
  return result_data;
end $$;

revoke all on function public.sms_facility_members(text), public.sms_facility_preview(text,uuid),
  public.accept_sms_facility_action(uuid,uuid,boolean) from public, anon, authenticated;
grant execute on function public.sms_facility_members(text), public.sms_facility_preview(text,uuid),
  public.accept_sms_facility_action(uuid,uuid,boolean) to service_role;
notify pgrst,'reload schema';
