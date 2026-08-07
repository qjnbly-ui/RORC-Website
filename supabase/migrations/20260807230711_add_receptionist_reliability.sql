create table if not exists public.rorc_receptionist_calls (
  call_sid text primary key,
  caller_key text not null,
  caller_recognized boolean not null default false,
  account_verified boolean not null default false,
  knowledge_version text,
  final_outcome text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  constraint rorc_receptionist_calls_caller_key_check check (caller_key ~ '^[a-f0-9]{64}$')
);

create index if not exists rorc_receptionist_calls_started_idx
  on public.rorc_receptionist_calls (started_at desc);

create table if not exists public.rorc_receptionist_events (
  id uuid primary key default gen_random_uuid(),
  call_sid text not null references public.rorc_receptionist_calls(call_sid) on delete cascade,
  event_type text not null,
  intent text,
  confidence numeric(5,4),
  latency_ms integer,
  success boolean not null default true,
  error_code text,
  utterance_text text,
  utterance_expires_at timestamptz,
  twilio_message_sid text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint rorc_receptionist_events_intent_check check (
    intent is null or intent in (
      'simple_question', 'detailed_explanation', 'send_information',
      'start_form', 'check_account', 'request_person'
    )
  ),
  constraint rorc_receptionist_events_confidence_check check (
    confidence is null or (confidence >= 0 and confidence <= 1)
  ),
  constraint rorc_receptionist_events_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists rorc_receptionist_events_created_idx
  on public.rorc_receptionist_events (created_at desc);
create index if not exists rorc_receptionist_events_call_idx
  on public.rorc_receptionist_events (call_sid, created_at);
create index if not exists rorc_receptionist_events_intent_idx
  on public.rorc_receptionist_events (intent, created_at desc) where intent is not null;
create index if not exists rorc_receptionist_events_message_idx
  on public.rorc_receptionist_events (twilio_message_sid) where twilio_message_sid is not null;
create index if not exists rorc_receptionist_events_utterance_expiry_idx
  on public.rorc_receptionist_events (utterance_expires_at) where utterance_text is not null;

create table if not exists public.rorc_receptionist_pin_lockouts (
  caller_key text primary key,
  window_started_at timestamptz not null default now(),
  failed_attempts integer not null default 0,
  locked_until timestamptz,
  updated_at timestamptz not null default now(),
  constraint rorc_receptionist_pin_lockouts_caller_key_check check (caller_key ~ '^[a-f0-9]{64}$'),
  constraint rorc_receptionist_pin_lockouts_attempts_check check (failed_attempts >= 0 and failed_attempts <= 3)
);

create index if not exists rorc_receptionist_pin_lockouts_locked_idx
  on public.rorc_receptionist_pin_lockouts (locked_until) where locked_until is not null;

alter table public.rorc_receptionist_calls enable row level security;
alter table public.rorc_receptionist_events enable row level security;
alter table public.rorc_receptionist_pin_lockouts enable row level security;

revoke all on table public.rorc_receptionist_calls from public, anon, authenticated;
revoke all on table public.rorc_receptionist_events from public, anon, authenticated;
revoke all on table public.rorc_receptionist_pin_lockouts from public, anon, authenticated;

grant select, insert, update, delete on table public.rorc_receptionist_calls to service_role;
grant select, insert, update, delete on table public.rorc_receptionist_events to service_role;
grant select, insert, update, delete on table public.rorc_receptionist_pin_lockouts to service_role;

create or replace function public.rorc_receptionist_record_pin_attempt(
  p_caller_key text,
  p_succeeded boolean,
  p_now timestamptz default now()
)
returns table (failed_attempts integer, locked_until timestamptz, is_locked boolean)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_row public.rorc_receptionist_pin_lockouts%rowtype;
begin
  if p_caller_key !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid caller key';
  end if;

  if p_succeeded then
    delete from public.rorc_receptionist_pin_lockouts where caller_key = p_caller_key;
    return query select 0, null::timestamptz, false;
    return;
  end if;

  insert into public.rorc_receptionist_pin_lockouts as lockout (
    caller_key, window_started_at, failed_attempts, locked_until, updated_at
  ) values (
    p_caller_key, p_now, 1, null, p_now
  )
  on conflict (caller_key) do update set
    window_started_at = case
      when lockout.locked_until is not null and lockout.locked_until > p_now then lockout.window_started_at
      when lockout.window_started_at <= p_now - interval '15 minutes' then p_now
      else lockout.window_started_at
    end,
    failed_attempts = case
      when lockout.locked_until is not null and lockout.locked_until > p_now then lockout.failed_attempts
      when lockout.window_started_at <= p_now - interval '15 minutes' then 1
      else least(3, lockout.failed_attempts + 1)
    end,
    locked_until = case
      when lockout.locked_until is not null and lockout.locked_until > p_now then lockout.locked_until
      when (case when lockout.window_started_at <= p_now - interval '15 minutes' then 1 else lockout.failed_attempts + 1 end) >= 3
        then p_now + interval '30 minutes'
      else null
    end,
    updated_at = p_now
  returning lockout.* into v_row;

  return query select
    v_row.failed_attempts,
    v_row.locked_until,
    coalesce(v_row.locked_until > p_now, false);
end;
$$;

revoke execute on function public.rorc_receptionist_record_pin_attempt(text, boolean, timestamptz)
  from public, anon, authenticated;
grant execute on function public.rorc_receptionist_record_pin_attempt(text, boolean, timestamptz)
  to service_role;
