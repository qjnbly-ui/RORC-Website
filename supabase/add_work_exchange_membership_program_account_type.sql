-- Adds a dedicated account type for Work Exchange Membership Program accounts.
-- Run this in Supabase SQL editor before selecting "Work Exchange Membership Program" in the app.

alter type public.membership_account_type
  add value if not exists 'Work Exchange Membership Program';

insert into public.account_type_permissions (
  account_type,
  can_sign_in,
  can_manage_members,
  bypass_time_windows,
  allowed_days,
  allowed_start_time,
  allowed_end_time,
  notes
) values (
  'Work Exchange Membership Program',
  true,
  false,
  false,
  array[0,1,2,3,4,5,6]::smallint[],
  time '06:50',
  time '21:10',
  'Member access safety window for nominal 7am-9pm hours.'
)
on conflict (account_type) do update set
  can_sign_in = excluded.can_sign_in,
  can_manage_members = excluded.can_manage_members,
  bypass_time_windows = excluded.bypass_time_windows,
  allowed_days = excluded.allowed_days,
  allowed_start_time = excluded.allowed_start_time,
  allowed_end_time = excluded.allowed_end_time,
  notes = excluded.notes,
  updated_at = now();
