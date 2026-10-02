-- Optional SMS booking AI. Service-only, expiring drafts; no SMS credential grants.
create table public.sms_booking_drafts (
  id uuid primary key default gen_random_uuid(), message_sid text not null unique,
  phone_e164 text not null, message_body text not null, intent jsonb not null default '{}',
  status text not null check(status in ('processing','ready','clarification','staff','confirmed','canceled')),
  token_hash text unique, reply_text text not null default '', verified_member_id uuid references public.account_members(id),
  resolved_command jsonb, result jsonb, expires_at timestamptz not null, created_at timestamptz not null default now(),
  constraint sms_booking_token_hash_valid check(token_hash is null or token_hash ~ '^[a-f0-9]{64}$'),
  constraint sms_booking_phone_valid check(phone_e164 ~ E'^\\+[1-9][0-9]{7,14}$')
);
create index sms_booking_drafts_phone_recent on public.sms_booking_drafts(phone_e164,created_at desc);
create index sms_booking_drafts_expires on public.sms_booking_drafts(expires_at);
alter table public.sms_booking_drafts enable row level security;
revoke all on public.sms_booking_drafts from public,anon,authenticated;
grant select,insert,update,delete on public.sms_booking_drafts to service_role;

create or replace function public.confirm_sms_booking_draft(actor_id uuid, draft_token_hash text)
returns jsonb language plpgsql volatile security invoker set search_path=public,pg_temp as $$
declare draft public.sms_booking_drafts; output jsonb;
begin
  perform pg_advisory_xact_lock(72667201);
  select * into draft from public.sms_booking_drafts where token_hash=draft_token_hash for update;
  if draft.id is null or draft.verified_member_id is distinct from actor_id or draft.resolved_command is null then raise exception 'Verified draft not found' using errcode='42501'; end if;
  if draft.status='confirmed' then return draft.result; end if;
  if draft.status<>'ready' or draft.expires_at<=now() then raise exception 'Draft expired or canceled; nothing changed' using errcode='55000'; end if;
  perform 1 from public.rorc_receptionist_sms_consent where phone_e164=draft.phone_e164 and consent_status='opt_in' for share;
  if not found then raise exception 'SMS consent is required; nothing changed' using errcode='42501'; end if;
  output:=public.apply_recurring_rental_operation(actor_id,draft.id,draft.resolved_command);
  update public.sms_booking_drafts set status='confirmed',result=output where id=draft.id;
  return output;
end $$;
revoke execute on function public.confirm_sms_booking_draft(uuid,text) from public,anon,authenticated;
grant execute on function public.confirm_sms_booking_draft(uuid,text) to service_role;
-- Read-only conflict preview. Input comes only from the authenticated server's
-- normalized creation records or server-selected rows, never from an SMS client.
create or replace function public.preview_rental_access(proposals jsonb, excluded_ids uuid[] default '{}')
returns jsonb language plpgsql volatile security invoker set search_path=public,pg_temp as $$
declare row_json jsonb; proposed public.rental_requests; window_value tstzrange; prior_windows tstzrange[]:='{}'; count_value integer:=0;
begin
  if jsonb_typeof(proposals)<>'array' or jsonb_array_length(proposals) not between 1 and 240 then raise exception 'Choose 1–240 occurrences' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(72667201);
  for row_json in select value from jsonb_array_elements(proposals) loop
    proposed:=jsonb_populate_record(null::public.rental_requests,row_json);
    proposed.id:=coalesce(proposed.id,gen_random_uuid());
    if proposed.rental_status is distinct from 'canceled'::public.rental_status then
      perform public.assert_rental_available(proposed,excluded_ids);
      for window_value in select * from public.rental_access_windows(proposed) loop
        if exists(select 1 from unnest(prior_windows) earlier where earlier && window_value) then raise exception 'Proposed occurrences overlap on %',proposed.event_date using errcode='23P01'; end if;
        prior_windows:=array_append(prior_windows,window_value);
      end loop;
    end if;
    count_value:=count_value+1;
  end loop;
  return jsonb_build_object('available',true,'occurrences',count_value);
end $$;
revoke execute on function public.preview_rental_access(jsonb,uuid[]) from public,anon,authenticated;
grant execute on function public.preview_rental_access(jsonb,uuid[]) to service_role;
notify pgrst,'reload schema';
