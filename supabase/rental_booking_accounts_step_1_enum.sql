-- Rental booking account claim flow, step 1.
-- Run this first, then run rental_booking_accounts.sql after it commits.

alter type public.membership_account_type
  add value if not exists 'Rental Account';
