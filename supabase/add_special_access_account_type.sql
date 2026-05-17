-- Adds a dedicated account type for custom contract-based access.
-- Run this in Supabase SQL editor before selecting "Special Access Account" in the app.

alter type public.membership_account_type
  add value if not exists 'Special Access Account';

-- Optional: migrate legacy records that used Billed Monthly for this purpose.
update public.account_members
set account_type = 'Special Access Account'
where account_type = 'Billed Monthly';

update public.signup_contracts
set requested_account_type = 'Special Access Account'
where requested_account_type = 'Billed Monthly';
