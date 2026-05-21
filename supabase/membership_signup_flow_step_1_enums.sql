-- Run this first by itself in the Supabase SQL editor.
-- Postgres requires newly added enum values to be committed before they are used.

alter type public.membership_account_type
  add value if not exists 'Weight Room Only';

alter type public.membership_account_type
  add value if not exists 'RESTRICTED ACCOUNT';
