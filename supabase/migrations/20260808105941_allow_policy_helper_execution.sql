-- RLS policy expressions execute with the querying role's function privileges.
-- Keep app_private outside the exposed API schemas, while allowing authenticated
-- users to evaluate only the five read/authorization helpers referenced by RLS.

grant usage on schema app_private to authenticated;

grant execute on function app_private.is_kiosk_or_account_manager()
  to authenticated;
grant execute on function app_private.can_receive_rorc_broadcast(text)
  to authenticated;
grant execute on function app_private.can_read_heater_use_entry(uuid, uuid)
  to authenticated;
grant execute on function app_private.can_read_heater_group_members(uuid)
  to authenticated;
grant execute on function app_private.can_manage_heater_use_entry(uuid, uuid)
  to authenticated;

-- Trigger functions and the protected row-update trigger remain executable only
-- by their PostgreSQL owner. No client role receives Broadcast write permission.
