-- Per-conversation participation. Existing global SMS consent/AI switches remain authoritative.
alter table public.staff_communication_threads
  add column ai_mode text not null default 'automatic' check (ai_mode in ('automatic','never')),
  add column ai_resume_after_minutes integer not null default 20 check (ai_resume_after_minutes between 5 and 10080),
  add column ai_paused_until timestamptz,
  add column ai_revision bigint not null default 0;

-- Preserve the existing 20-minute pause for recent human replies.
update public.staff_communication_threads t
set ai_paused_until = recent.last_reply + interval '20 minutes'
from (
  select thread_id, max(message_at) as last_reply
  from public.staff_communication_messages
  where direction='outbound' and created_by_member_id is not null
    and message_at > now() - interval '20 minutes'
  group by thread_id
) recent where t.id=recent.thread_id;

create function public.pause_sms_ai_on_staff_reply()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if new.direction='outbound' and new.created_by_member_id is not null then
    update public.staff_communication_threads
    set ai_paused_until=now()+make_interval(mins=>ai_resume_after_minutes)
    where id=new.thread_id;
  end if;
  return new;
end $$;
revoke all on function public.pause_sms_ai_on_staff_reply() from public,anon,authenticated;
grant execute on function public.pause_sms_ai_on_staff_reply() to service_role;
create trigger staff_reply_pauses_sms_ai after insert on public.staff_communication_messages
for each row execute function public.pause_sms_ai_on_staff_reply();

-- Keep Resume now and any existing quiet handoff context in sync atomically.
create function public.set_sms_conversation_ai(thread_id uuid, mode text, resume_minutes integer, resume_now boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare thread public.staff_communication_threads;
begin
  if mode not in ('automatic','never') or resume_minutes not between 5 and 10080 or mode is null or resume_minutes is null or resume_now is null then
    raise exception 'Invalid conversation AI settings' using errcode='22023';
  end if;
  update public.staff_communication_threads t
  set ai_mode=mode,ai_resume_after_minutes=resume_minutes,
      ai_paused_until=case when resume_now or mode='never' then null else t.ai_paused_until end
  where t.id=thread_id returning t.* into thread;
  if thread.id is null then raise exception 'Conversation not found' using errcode='P0002'; end if;
  if resume_now then
    update public.sms_booking_drafts set status='canceled'
    where phone_e164=thread.phone_e164 and status='staff'
      and intent @> '{"assistantState":{"handoff":true}}'::jsonb;
  end if;
  return jsonb_build_object('ai_mode',thread.ai_mode,'ai_resume_after_minutes',thread.ai_resume_after_minutes,'ai_paused_until',thread.ai_paused_until);
end $$;
revoke all on function public.set_sms_conversation_ai(uuid,text,integer,boolean) from public,anon,authenticated;
grant execute on function public.set_sms_conversation_ai(uuid,text,integer,boolean) to service_role;

-- A policy change invalidates AI work already in progress, even after Resume now.
create function public.bump_sms_ai_revision()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  new.ai_revision := old.ai_revision + 1;
  return new;
end $$;
revoke all on function public.bump_sms_ai_revision() from public,anon,authenticated;
grant execute on function public.bump_sms_ai_revision() to service_role;
create trigger sms_ai_policy_revision before update of ai_mode,ai_resume_after_minutes,ai_paused_until
on public.staff_communication_threads for each row execute function public.bump_sms_ai_revision();
