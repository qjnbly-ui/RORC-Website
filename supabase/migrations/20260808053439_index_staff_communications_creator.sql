create index if not exists staff_communication_messages_creator_idx
  on public.staff_communication_messages (created_by_member_id)
  where created_by_member_id is not null;
