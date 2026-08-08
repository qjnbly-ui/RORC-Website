create table if not exists public.staff_communication_threads (
  id uuid primary key default gen_random_uuid(),
  phone_e164 text not null unique,
  unread_count integer not null default 0,
  last_message_preview text not null default '',
  last_message_direction text check (last_message_direction in ('inbound', 'outbound')),
  last_message_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint staff_communication_threads_phone_check
    check (phone_e164 ~ E'^\\+[1-9][0-9]{7,14}$'),
  constraint staff_communication_threads_unread_check check (unread_count >= 0)
);

create index if not exists staff_communication_threads_recent_idx
  on public.staff_communication_threads (last_message_at desc);

create index if not exists staff_communication_threads_unread_idx
  on public.staff_communication_threads (last_message_at desc)
  where unread_count > 0;

drop trigger if exists staff_communication_threads_set_updated_at
  on public.staff_communication_threads;
create trigger staff_communication_threads_set_updated_at
before update on public.staff_communication_threads
for each row execute function public.set_updated_at();

create table if not exists public.staff_communication_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.staff_communication_threads(id) on delete cascade,
  twilio_message_sid text not null unique,
  direction text not null check (direction in ('inbound', 'outbound')),
  body text not null default '',
  message_status text not null default 'received' check (
    message_status in (
      'accepted', 'scheduled', 'canceled', 'queued', 'sending', 'sent',
      'delivered', 'undelivered', 'failed', 'receiving', 'received', 'read'
    )
  ),
  from_e164 text not null,
  to_e164 text not null,
  media_count smallint not null default 0,
  media jsonb not null default '[]'::jsonb,
  error_code text,
  created_by_member_id uuid references public.account_members(id) on delete set null,
  message_at timestamptz not null default now(),
  status_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint staff_communication_messages_body_length_check
    check (char_length(body) <= 16000),
  constraint staff_communication_messages_from_phone_check
    check (from_e164 ~ E'^\\+[1-9][0-9]{7,14}$'),
  constraint staff_communication_messages_to_phone_check
    check (to_e164 ~ E'^\\+[1-9][0-9]{7,14}$'),
  constraint staff_communication_messages_media_count_check check (media_count >= 0),
  constraint staff_communication_messages_media_check check (jsonb_typeof(media) = 'array')
);

create index if not exists staff_communication_messages_thread_recent_idx
  on public.staff_communication_messages (thread_id, message_at desc);

create index if not exists staff_communication_messages_status_idx
  on public.staff_communication_messages (message_status, status_updated_at desc)
  where message_status in ('queued', 'sending', 'sent', 'undelivered', 'failed');

alter table public.staff_communication_threads enable row level security;
alter table public.staff_communication_messages enable row level security;

revoke all on table public.staff_communication_threads from public, anon, authenticated;
revoke all on table public.staff_communication_messages from public, anon, authenticated;
grant select, insert, update on table public.staff_communication_threads to service_role;
grant select, insert, update on table public.staff_communication_messages to service_role;

create or replace function public.record_staff_communication_message(
  p_phone_e164 text,
  p_twilio_message_sid text,
  p_direction text,
  p_body text,
  p_message_status text,
  p_from_e164 text,
  p_to_e164 text,
  p_media jsonb default '[]'::jsonb,
  p_created_by_member_id uuid default null,
  p_message_at timestamptz default now()
)
returns table (message_id uuid, thread_id uuid)
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_thread_id uuid;
  v_message_id uuid;
  v_media jsonb := coalesce(p_media, '[]'::jsonb);
begin
  if p_phone_e164 !~ E'^\\+[1-9][0-9]{7,14}$'
    or p_from_e164 !~ E'^\\+[1-9][0-9]{7,14}$'
    or p_to_e164 !~ E'^\\+[1-9][0-9]{7,14}$' then
    raise exception 'invalid phone number';
  end if;
  if p_twilio_message_sid is null or btrim(p_twilio_message_sid) = '' then
    raise exception 'missing Twilio message SID';
  end if;
  if p_direction not in ('inbound', 'outbound') then
    raise exception 'invalid message direction';
  end if;
  if jsonb_typeof(v_media) <> 'array' then
    raise exception 'media must be a JSON array';
  end if;

  insert into public.staff_communication_threads (phone_e164, last_message_at)
  values (p_phone_e164, p_message_at)
  on conflict (phone_e164) do nothing;

  select thread.id
  into v_thread_id
  from public.staff_communication_threads as thread
  where thread.phone_e164 = p_phone_e164
  for update;

  insert into public.staff_communication_messages (
    thread_id,
    twilio_message_sid,
    direction,
    body,
    message_status,
    from_e164,
    to_e164,
    media_count,
    media,
    created_by_member_id,
    message_at,
    status_updated_at
  ) values (
    v_thread_id,
    p_twilio_message_sid,
    p_direction,
    left(coalesce(p_body, ''), 16000),
    p_message_status,
    p_from_e164,
    p_to_e164,
    jsonb_array_length(v_media),
    v_media,
    p_created_by_member_id,
    p_message_at,
    p_message_at
  )
  on conflict (twilio_message_sid) do nothing
  returning id into v_message_id;

  if v_message_id is null then
    select message.id, message.thread_id
    into v_message_id, v_thread_id
    from public.staff_communication_messages as message
    where message.twilio_message_sid = p_twilio_message_sid;
    return query select v_message_id, v_thread_id;
    return;
  end if;

  update public.staff_communication_threads
  set
    last_message_preview = left(coalesce(nullif(btrim(p_body), ''), '[Attachment]'), 160),
    last_message_direction = p_direction,
    last_message_at = p_message_at,
    unread_count = unread_count + case when p_direction = 'inbound' then 1 else 0 end
  where id = v_thread_id;

  return query select v_message_id, v_thread_id;
end;
$$;

revoke execute on function public.record_staff_communication_message(
  text, text, text, text, text, text, text, jsonb, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function public.record_staff_communication_message(
  text, text, text, text, text, text, text, jsonb, uuid, timestamptz
) to service_role;
