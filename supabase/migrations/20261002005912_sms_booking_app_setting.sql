-- Manager-controlled app setting. Existing service-only settings table and RLS.
insert into public.automation_settings(id,config) values('sms_booking_ai','{"enabled":false}'::jsonb) on conflict(id) do nothing;

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
  perform 1 from public.automation_settings where id='sms_booking_ai' and config->'enabled'='true'::jsonb for share;
  if not found then raise exception 'AI booking assistance is paused; nothing changed' using errcode='55000'; end if;
  output:=public.apply_recurring_rental_operation(actor_id,draft.id,draft.resolved_command);
  update public.sms_booking_drafts set status='confirmed',result=output where id=draft.id;
  return output;
end $$;
revoke execute on function public.confirm_sms_booking_draft(uuid,text) from public,anon,authenticated;
grant execute on function public.confirm_sms_booking_draft(uuid,text) to service_role;
notify pgrst,'reload schema';
