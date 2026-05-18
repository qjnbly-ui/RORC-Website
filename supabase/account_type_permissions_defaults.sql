insert into public.account_type_permissions (
  account_type,
  can_sign_in,
  bypass_time_windows,
  allowed_days,
  allowed_start_time,
  allowed_end_time,
  notes
) values
  ('Account Manager', true, true, '{}', null, null, '24/7 manager access'),
  ('Kiosk Account', true, true, '{}', null, null, '24/7 kiosk access'),
  ('Special Access Account', true, true, '{}', null, null, '24/7 contract access'),
  ('Active Membership', true, false, '{0,1,2,3,4,5,6}', '06:50:00', '21:10:00', 'Daily member hours'),
  ('Open Gym Only', true, false, '{2,4}', '17:50:00', '20:10:00', 'Tue/Thu open gym hours'),
  ('RESTRICTED ACCOUNT', false, false, '{}', null, null, 'No access')
on conflict (account_type)
do update set
  can_sign_in = excluded.can_sign_in,
  bypass_time_windows = excluded.bypass_time_windows,
  allowed_days = excluded.allowed_days,
  allowed_start_time = excluded.allowed_start_time,
  allowed_end_time = excluded.allowed_end_time,
  notes = excluded.notes;
